import type { PluginContext } from "@paperclipai/plugin-sdk";
import { sendMessage, escapeMarkdownV2 } from "./telegram-api.js";
import { buildPaperclipAuthHeaders, fetchPaperclipApi } from "./paperclip-api.js";

/**
 * What is actually waiting on a human, as the /<company>/decisions page shows it.
 *
 * The naming here is a trap worth documenting. There IS a `decisions` table and
 * a /companies/:id/decisions endpoint — but that is a different, largely unused
 * feature. The Decisions PAGE is built from **issue thread interactions**:
 * `ask_user_questions` and `request_confirmation` records attached to issues,
 * grouped into "decision queues" (Questions, Plans).
 *
 * Querying /decisions?status=open returns [] on an instance with a full page,
 * which reads as "nothing pending" and is worse than an error.
 *
 * There is no company-wide endpoint that returns pending interactions WITH
 * their content:
 *   - /decision-queues/:key/items returns bare pointers (sourceKind+sourceId),
 *     with no enrichment and no issue id, and it retains resolved items too.
 *   - Interactions are only readable per issue, via /issues/:id/interactions.
 *
 * So this walks recent issues and collects their pending interactions. The
 * bound is deliberate: unbounded, this would be one request per issue for the
 * life of the company. Pending questions are by nature recent — an agent is
 * blocked waiting on them — so recency is the right cut, and the cap is
 * reported to the user rather than hidden.
 */

const CALLBACK_PREFIX = "dec_";
const DEFAULT_ISSUE_SCAN = 30;

export type PendingInteraction = {
  id: string;
  issueId: string;
  issueIdentifier?: string;
  kind: string;
  title: string;
  summary?: string | null;
  status: string;
};

type RawInteraction = {
  id?: string;
  kind?: string;
  status?: string;
  title?: string;
  summary?: string | null;
};

export function isDecisionCallback(data: string): boolean {
  return data.startsWith(CALLBACK_PREFIX);
}

/** Human label for an interaction kind; unknown kinds fall back to the raw value. */
export function describeKind(kind: string): string {
  const labels: Record<string, string> = {
    ask_user_questions: "Question",
    request_confirmation: "Confirmation",
  };
  return labels[kind] ?? kind.replace(/_/g, " ");
}

async function fetchIssueInteractions(
  ctx: PluginContext,
  baseUrl: string,
  issueId: string,
  boardApiToken?: string,
): Promise<RawInteraction[]> {
  try {
    const response = await fetchPaperclipApi(ctx, `${baseUrl}/api/issues/${issueId}/interactions`, {
      method: "GET",
      headers: { ...buildPaperclipAuthHeaders(boardApiToken) },
    });
    const parsed = (await (response as Response).json()) as unknown;
    return Array.isArray(parsed) ? (parsed as RawInteraction[]) : [];
  } catch {
    // One unreadable issue must not sink the whole command.
    return [];
  }
}

/**
 * Collect interactions still waiting on a person, newest issues first.
 * Returns the scanned count so the caller can be honest about the bound.
 */
export async function fetchPendingInteractions(
  ctx: PluginContext,
  baseUrl: string,
  companyId: string,
  boardApiToken?: string,
  scanLimit: number = DEFAULT_ISSUE_SCAN,
): Promise<{ pending: PendingInteraction[]; scanned: number }> {
  const issues = await ctx.issues.list({ companyId, limit: scanLimit });

  // Concurrent, but in small batches: one request per issue against a local
  // server is fine, a burst of 30 is not.
  const pending: PendingInteraction[] = [];
  const batchSize = 6;
  for (let i = 0; i < issues.length; i += batchSize) {
    const batch = issues.slice(i, i + batchSize);
    const results = await Promise.all(
      batch.map(async (issue) => ({
        issue,
        interactions: await fetchIssueInteractions(ctx, baseUrl, issue.id, boardApiToken),
      })),
    );
    for (const { issue, interactions } of results) {
      for (const interaction of interactions) {
        if (interaction.status !== "pending") continue;
        pending.push({
          id: interaction.id ?? "",
          issueId: issue.id,
          issueIdentifier: issue.identifier ?? undefined,
          kind: interaction.kind ?? "unknown",
          title: interaction.title ?? "(untitled)",
          summary: interaction.summary ?? null,
          status: interaction.status,
        });
      }
    }
  }

  return { pending, scanned: issues.length };
}

export function renderPendingInteraction(item: PendingInteraction, publicUrl?: string): string {
  const lines = [
    `${escapeMarkdownV2("🗳")} *${escapeMarkdownV2(item.title)}*`,
    escapeMarkdownV2(`${describeKind(item.kind)} · ${item.issueIdentifier ?? item.issueId}`),
  ];

  const summary = (item.summary ?? "").trim();
  if (summary) {
    const excerpt = summary.length > 350 ? `${summary.slice(0, 350)}…` : summary;
    lines.push("", escapeMarkdownV2(excerpt));
  }

  // Answering needs a form (free text, per-question picks), which Telegram
  // buttons cannot render — so link out rather than pretend to collect it.
  if (publicUrl && item.issueIdentifier) {
    lines.push("", escapeMarkdownV2(`Answer: ${publicUrl}/decisions`));
  }

  return lines.join("\n");
}

export async function sendPendingList(
  ctx: PluginContext,
  token: string,
  chatId: string,
  found: { pending: PendingInteraction[]; scanned: number },
  opts: { messageThreadId?: number; publicUrl?: string; limit?: number } = {},
): Promise<void> {
  const { pending, scanned } = found;

  if (pending.length === 0) {
    await sendMessage(
      ctx,
      token,
      chatId,
      `Nothing is waiting on your input (checked the ${scanned} most recent issues).`,
      { messageThreadId: opts.messageThreadId },
    );
    return;
  }

  const limit = opts.limit ?? 5;
  for (const item of pending.slice(0, limit)) {
    await sendMessage(ctx, token, chatId, renderPendingInteraction(item, opts.publicUrl), {
      parseMode: "MarkdownV2",
      messageThreadId: opts.messageThreadId,
    });
  }

  if (pending.length > limit) {
    await sendMessage(
      ctx,
      token,
      chatId,
      `…and ${pending.length - limit} more waiting.`,
      { messageThreadId: opts.messageThreadId },
    );
  }
}
