import type {
  IssueThreadInteraction,
  RequestConfirmationInteraction,
  AskUserQuestionsInteraction,
  RequestItemVerdictsInteraction,
} from "@paperclipai/shared";

// Issue-thread-interaction ("decision card") Telegram wiring.
//
// The host has no `interaction.created` event, so the plugin discovers decision
// cards by listing an issue's interactions whenever that issue changes
// (issue.created / issue.updated — both already subscribed). Only the daily
// binary decision cards are actionable from Telegram: `respondInteraction` is
// accept/reject(+reason), so `request_confirmation` is the one kind a two-button
// message can fully resolve. The richer kinds (ask_user_questions,
// request_checkbox_confirmation, request_item_verdicts) need the web UI and are
// left to the existing digest path.

export const INTERACTION_ACCEPT_PREFIX = "int_accept_";
export const INTERACTION_REJECT_PREFIX = "int_reject_";

/**
 * State entityType stored on an interaction notification's `msg_<chat>_<id>`
 * record so callbacks and reason replies can recover the issue/company/interaction.
 */
export const INTERACTION_ENTITY_TYPE = "issue_interaction";
/** entityType stored on the force_reply "reason?" prompt message. */
export const INTERACTION_REASON_ENTITY_TYPE = "issue_interaction_reason";

/**
 * True when this interaction is a daily decision card the plugin can both
 * notify about and resolve from Telegram: a still-pending `request_confirmation`.
 * `respondInteraction` is accept/reject, so this is the one kind two buttons can
 * fully resolve.
 */
export function isActionableInteraction(
  interaction: IssueThreadInteraction,
): interaction is RequestConfirmationInteraction {
  return interaction.kind === "request_confirmation" && interaction.status === "pending";
}

/**
 * True when this is a pending decision the plugin should surface but CANNOT
 * resolve from Telegram: `ask_user_questions` (multiple-choice answers) and
 * `request_item_verdicts` (per-item approve/reject/defer). The plugin SDK
 * (@paperclipai/plugin-sdk 2026.1012.0) exposes only `respondInteraction`
 * (accept/reject) — there is no host method to submit question answers or item
 * verdicts — so these are forwarded as notify-only cards with an "open in
 * Paperclip" deep link rather than dropped onto the n8n digest silently.
 */
export function isNotifyOnlyInteraction(
  interaction: IssueThreadInteraction,
): interaction is AskUserQuestionsInteraction | RequestItemVerdictsInteraction {
  return (
    interaction.status === "pending" &&
    (interaction.kind === "ask_user_questions" || interaction.kind === "request_item_verdicts")
  );
}

/**
 * Any pending interaction the plugin forwards to Telegram — actionable
 * (accept/reject buttons) or notify-only (deep link). Other kinds
 * (suggest_tasks, request_checkbox_confirmation, connection_intent) stay on the
 * digest path.
 */
export function isForwardableInteraction(interaction: IssueThreadInteraction): boolean {
  return isActionableInteraction(interaction) || isNotifyOnlyInteraction(interaction);
}

export type InteractionCallback = {
  action: "accept" | "reject";
  interactionId: string;
};

/** An issue worth re-listing interactions for on a scheduler-poll tick. */
export type InteractionCandidate = {
  issueId: string;
  companyId: string;
};

/**
 * Bounded, time-windowed record of issues the plugin has recently seen events
 * for, feeding the scheduler-poll fallback (worker's `check-issue-interactions`
 * job).
 *
 * The event-driven path misses a decision card that is posted without a
 * *subsequent* issue.updated: the host fires issue.created before the card
 * exists, and card creation itself need not emit a plugin-visible issue.updated
 * (observed live — a card only forwarded once an unrelated priority bump fired
 * a later issue.updated). Re-listing the interactions of recently-active issues
 * a tick later catches that gap without enumerating the whole board.
 *
 * Bounded two ways: entries older than `ttlMs` are dropped, and the newest
 * `maxEntries` are kept when the map would grow past that. Re-recording an
 * issue refreshes its timestamp so a steadily-active issue never ages out.
 */
export function createRecentIssueTracker(options: { ttlMs?: number; maxEntries?: number } = {}) {
  const ttlMs = options.ttlMs ?? 10 * 60_000;
  const maxEntries = options.maxEntries ?? 200;
  const seen = new Map<string, { companyId: string; ts: number }>();

  function prune(now: number): void {
    for (const [issueId, rec] of seen) {
      if (now - rec.ts >= ttlMs) seen.delete(issueId);
    }
    if (seen.size > maxEntries) {
      const byAge = [...seen.entries()].sort((a, b) => a[1].ts - b[1].ts);
      for (let i = 0; i < byAge.length - maxEntries; i++) seen.delete(byAge[i]![0]);
    }
  }

  return {
    record(issueId: string, companyId: string, now: number = Date.now()): void {
      if (!issueId || !companyId) return;
      seen.set(issueId, { companyId, ts: now });
      prune(now);
    },
    candidates(now: number = Date.now()): InteractionCandidate[] {
      prune(now);
      return [...seen.entries()].map(([issueId, rec]) => ({ issueId, companyId: rec.companyId }));
    },
    get size(): number {
      return seen.size;
    },
  };
}

export type RecentIssueTracker = ReturnType<typeof createRecentIssueTracker>;

/**
 * Merge candidate lists (tracked activity first, then wider nets) into a
 * deduped, capped set. First occurrence of an issueId wins, so the
 * higher-signal source listed first keeps its company attribution, and the
 * result never exceeds `maxCandidates` — the bound that keeps a poll tick from
 * fanning out across the whole board.
 */
export function mergeInteractionCandidates(
  sources: InteractionCandidate[][],
  maxCandidates: number,
): InteractionCandidate[] {
  const byIssue = new Map<string, InteractionCandidate>();
  for (const list of sources) {
    for (const candidate of list) {
      if (!candidate.issueId || !candidate.companyId) continue;
      if (byIssue.has(candidate.issueId)) continue;
      byIssue.set(candidate.issueId, candidate);
      if (byIssue.size >= maxCandidates) return [...byIssue.values()];
    }
  }
  return [...byIssue.values()];
}

/** Build the Telegram `callback_data` for an accept/reject button. */
export function buildInteractionCallbackData(
  action: "accept" | "reject",
  interactionId: string,
): string {
  const prefix = action === "accept" ? INTERACTION_ACCEPT_PREFIX : INTERACTION_REJECT_PREFIX;
  return `${prefix}${interactionId}`;
}

/**
 * Parse an interaction `callback_data`, or null when it is not one of ours.
 * Reject is checked first so the accept prefix (a strict substring of neither)
 * cannot shadow it; both prefixes are disjoint from the approval/escalation
 * prefixes handled elsewhere.
 */
export function parseInteractionCallbackData(data: string): InteractionCallback | null {
  if (data.startsWith(INTERACTION_ACCEPT_PREFIX)) {
    const interactionId = data.slice(INTERACTION_ACCEPT_PREFIX.length);
    return interactionId ? { action: "accept", interactionId } : null;
  }
  if (data.startsWith(INTERACTION_REJECT_PREFIX)) {
    const interactionId = data.slice(INTERACTION_REJECT_PREFIX.length);
    return interactionId ? { action: "reject", interactionId } : null;
  }
  return null;
}
