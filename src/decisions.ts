import type { PluginContext } from "@paperclipai/plugin-sdk";
import { sendMessage, escapeMarkdownV2 } from "./telegram-api.js";
import { buildPaperclipAuthHeaders, fetchPaperclipApi } from "./paperclip-api.js";
import {
  fetchInteraction,
  sendAnswerableInteraction,
  isAskUserQuestionsAnswerable,
  type AnswerableInteraction,
  type AskUserQuestionsPayload,
  type RequestConfirmationPayload,
} from "./interaction-answers.js";

/**
 * What is actually waiting on a human, read from the same source the Decisions
 * page renders: GET /api/companies/:companyId/attention.
 *
 * Two earlier attempts got this wrong, in ways worth recording because both
 * returned a confident, plausible, incomplete answer rather than an error:
 *
 *   1. /companies/:id/decisions — a different, largely unused feature. Returns
 *      [] on an instance whose Decisions page is full.
 *   2. Walking recent issues for pending issue_thread_interactions. Correct as
 *      far as it went, but the page is not only interactions: it also surfaces
 *      blocker_attention, reviews, approvals, recovery actions and more. On a
 *      live instance showing six items, that approach found one — and it could
 *      not see the other four blockers at all, at any scan depth.
 *
 * The attention endpoint solves both: one request instead of one per issue, no
 * scan bound to apologise for, server-side ranking, and every source kind the
 * page knows about. It also returns `whyNow` and `decisionVerbs`, so the bot
 * can say what the decision IS rather than just that one exists.
 */

const DEFAULT_DISPLAY_LIMIT = 5;

export type AttentionItem = {
  id: string;
  sourceKind: string;
  title: string;
  issueIdentifier?: string;
  issueHref?: string;
  whyNow?: string;
  severity?: string;
  excerpt?: string;
  verbs: string[];
  inlineResolvable: boolean;
  // Only set for sourceKind === "issue_thread_interaction": the attention
  // feed's excerpt has no question/option payload, so answering inline needs
  // these to go fetch the full interaction from the issue it belongs to.
  interactionId?: string;
  issueId?: string;
  interactionKind?: string;
};

export type AttentionResult = {
  items: AttentionItem[];
  totalCount: number;
};

type RawAttention = {
  totalCount?: number;
  items?: Array<Record<string, unknown>>;
};

/** Human label for a source kind; unknown kinds degrade to the raw value. */
export function describeSourceKind(kind: string): string {
  const labels: Record<string, string> = {
    issue_thread_interaction: "Needs your answer",
    blocker_attention: "Blocked",
    approval: "Approval",
    review: "Review",
    recovery_action: "Recovery",
    failed_run: "Failed run",
    budget_alert: "Budget",
    agent_error_alert: "Agent error",
    join_request: "Join request",
    decision: "Decision",
    productivity_review: "Productivity review",
  };
  return labels[kind] ?? kind.replace(/_/g, " ");
}

function severityMarker(severity?: string): string {
  if (severity === "high" || severity === "critical") return "🔴";
  if (severity === "low") return "⚪";
  return "🟡";
}

/**
 * Pull the one line of substance out of whichever detail shape this item has.
 * Each source kind carries a different field, and a missing one is normal
 * rather than an error — blockers have no prose at all.
 */
function extractExcerpt(detail: Record<string, unknown> | undefined): string | undefined {
  if (!detail) return undefined;
  const candidates = [detail.firstQuestionText, detail.promptExcerpt, detail.summary];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return undefined;
}

function toAttentionItem(raw: Record<string, unknown>): AttentionItem {
  const subject = (raw.subject ?? {}) as Record<string, unknown>;
  const relatedIssue = (raw.relatedIssue ?? {}) as Record<string, unknown>;
  const detail = raw.detail as Record<string, unknown> | undefined;
  const verbs = Array.isArray(raw.decisionVerbs)
    ? (raw.decisionVerbs as Array<Record<string, unknown>>)
        .map((v) => (typeof v.label === "string" ? v.label : ""))
        .filter(Boolean)
    : [];
  const sourceKind = typeof raw.sourceKind === "string" ? raw.sourceKind : "unknown";
  const subjectMetadata = (subject.metadata ?? {}) as Record<string, unknown>;
  const isInteraction = sourceKind === "issue_thread_interaction";

  return {
    id: typeof raw.id === "string" ? raw.id : "",
    sourceKind,
    title: typeof subject.title === "string" ? subject.title : "(untitled)",
    issueIdentifier:
      typeof relatedIssue.identifier === "string" ? relatedIssue.identifier : undefined,
    issueHref: typeof subject.href === "string" ? subject.href : undefined,
    whyNow: typeof raw.whyNow === "string" ? raw.whyNow : undefined,
    severity: typeof raw.severity === "string" ? raw.severity : undefined,
    excerpt: extractExcerpt(detail),
    verbs,
    inlineResolvable: raw.inlineResolvable === true,
    interactionId: isInteraction && typeof subject.id === "string" ? subject.id : undefined,
    issueId: isInteraction && typeof subjectMetadata.issueId === "string" ? subjectMetadata.issueId : undefined,
    interactionKind: isInteraction && typeof subjectMetadata.kind === "string" ? subjectMetadata.kind : undefined,
  };
}

/**
 * Fetch the full interaction and, if its shape is one Telegram can render as
 * buttons, narrow it into an AnswerableInteraction. Returns null for anything
 * that must fall back to the web-UI link: an unsupported kind, a fetch
 * failure, an interaction that resolved since the feed was read, or (for
 * ask_user_questions) a question with a designer-declared free-text option.
 */
async function tryBuildAnswerableInteraction(
  ctx: PluginContext,
  baseUrl: string,
  item: AttentionItem,
  boardApiToken?: string,
): Promise<AnswerableInteraction | null> {
  if (!item.issueId || !item.interactionId) return null;

  const fresh = await fetchInteraction(ctx, baseUrl, item.issueId, item.interactionId, boardApiToken);
  if (!fresh || fresh.status !== "pending") return null;

  if (fresh.kind === "ask_user_questions") {
    const payload = fresh.payload as AskUserQuestionsPayload;
    if (!isAskUserQuestionsAnswerable(payload)) return null;
    return { id: fresh.id, kind: "ask_user_questions", payload };
  }
  if (fresh.kind === "request_confirmation") {
    return { id: fresh.id, kind: "request_confirmation", payload: fresh.payload as RequestConfirmationPayload };
  }
  return null;
}

/**
 * Fetch everything waiting on a human. Throws on failure rather than returning
 * an empty list — "nothing is pending" must never be indistinguishable from
 * "we could not ask", which is the mistake that made the previous version
 * report an empty queue while four items sat on the page.
 */
export async function fetchAttention(
  ctx: PluginContext,
  baseUrl: string,
  companyId: string,
  boardApiToken?: string,
): Promise<AttentionResult> {
  const response = (await fetchPaperclipApi(
    ctx,
    `${baseUrl}/api/companies/${companyId}/attention`,
    { method: "GET", headers: { ...buildPaperclipAuthHeaders(boardApiToken) } },
  )) as Response;

  const parsed = (await response.json()) as RawAttention;
  const items = Array.isArray(parsed.items) ? parsed.items.map(toAttentionItem) : [];

  return {
    items,
    totalCount: typeof parsed.totalCount === "number" ? parsed.totalCount : items.length,
  };
}

export function renderAttentionItem(
  item: AttentionItem,
  publicUrl?: string,
  opts: { includeOpenLink?: boolean } = {},
): string {
  const heading = `${severityMarker(item.severity)} *${escapeMarkdownV2(item.title)}*`;
  const context = [describeSourceKind(item.sourceKind), item.issueIdentifier]
    .filter(Boolean)
    .join(" · ");
  const lines = [heading, escapeMarkdownV2(context)];

  // whyNow is the host's own one-line explanation of urgency. Preferring it
  // over anything invented here keeps the bot and the web UI telling the same
  // story about the same item.
  if (item.whyNow) lines.push("", escapeMarkdownV2(item.whyNow));

  if (item.excerpt) {
    const excerpt = item.excerpt.length > 300 ? `${item.excerpt.slice(0, 300)}…` : item.excerpt;
    lines.push("", escapeMarkdownV2(excerpt));
  }

  if (item.verbs.length > 0) {
    lines.push("", escapeMarkdownV2(`Options: ${item.verbs.join(" / ")}`));
  }

  // Deep-link to the item itself, not to the Decisions index — href already
  // carries the interaction anchor, so this lands on the thing being decided.
  // Suppressed when an inline answer prompt follows this message (BLA-154) —
  // the link would just be a redundant way to do what the buttons already do.
  if (opts.includeOpenLink !== false && publicUrl && item.issueHref) {
    lines.push("", escapeMarkdownV2(`Open: ${publicUrl}${item.issueHref}`));
  }

  return lines.join("\n");
}

export async function sendAttentionList(
  ctx: PluginContext,
  token: string,
  chatId: string,
  found: AttentionResult,
  opts: {
    messageThreadId?: number;
    publicUrl?: string;
    limit?: number;
    baseUrl?: string;
    companyId?: string;
    boardApiToken?: string;
  } = {},
): Promise<void> {
  const { items, totalCount } = found;

  if (items.length === 0) {
    await sendMessage(ctx, token, chatId, "Nothing is waiting on your input.", {
      messageThreadId: opts.messageThreadId,
    });
    return;
  }

  const limit = opts.limit ?? DEFAULT_DISPLAY_LIMIT;
  for (const item of items.slice(0, limit)) {
    // Only issue_thread_interaction items are candidates — approvals,
    // reviews, blockers etc. resolve through entirely different endpoints
    // this plugin does not call (BLA-154's scope is ask_user_questions and
    // request_confirmation specifically).
    const answerable = item.sourceKind === "issue_thread_interaction" && item.inlineResolvable && opts.baseUrl
      ? await tryBuildAnswerableInteraction(ctx, opts.baseUrl, item, opts.boardApiToken)
      : null;

    await sendMessage(ctx, token, chatId, renderAttentionItem(item, opts.publicUrl, { includeOpenLink: !answerable }), {
      parseMode: "MarkdownV2",
      messageThreadId: opts.messageThreadId,
    });

    if (answerable && item.issueId) {
      await sendAnswerableInteraction(ctx, token, chatId, answerable, {
        issueId: item.issueId,
        companyId: opts.companyId,
        messageThreadId: opts.messageThreadId,
      });
    }
  }

  if (totalCount > limit) {
    await sendMessage(ctx, token, chatId, `…and ${totalCount - limit} more waiting.`, {
      messageThreadId: opts.messageThreadId,
    });
  }
}

/**
 * Turn a failure into something the reader can act on. A raw
 * `403: {"error":"Board access required"}` names the symptom and hides the
 * cause: the board token was not resolved for this update.
 */
export function describeDecisionsError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);

  if (/\b(401|403)\b/.test(message) || /board access/i.test(message)) {
    return [
      "Can't read decisions — the bot has no board access right now.",
      "",
      "This is the plugin's board API token failing to resolve, not a permissions change on your account. It usually means the plugin config was loaded without a company scope, which happens on worker restart.",
    ].join("\n");
  }

  return `Could not load decisions: ${message}`;
}
