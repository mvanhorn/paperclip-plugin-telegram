import type { PluginEvent } from "@paperclipai/plugin-sdk";
import type {
  RequestConfirmationInteraction,
  AskUserQuestionsInteraction,
  RequestItemVerdictsInteraction,
} from "@paperclipai/shared";
import { escapeMarkdownV2, truncateAtWord } from "./telegram-api.js";
import type { SendMessageOptions } from "./telegram-api.js";
import { AGENT_ERROR_TRUNCATE_LENGTH } from "./constants.js";
import {
  buildInteractionCallbackData,
} from "./interaction-routing.js";
import { str } from "./coerce.js";

type Payload = Record<string, unknown>;

type FormattedMessage = {
  text: string;
  options: SendMessageOptions;
};

function esc(s: string): string {
  return escapeMarkdownV2(s);
}

function bold(s: string): string {
  return `*${esc(s)}*`;
}

function code(s: string): string {
  return `\`${esc(s)}\``;
}

export type IssueLinksOpts = { baseUrl?: string; issuePrefix?: string };

function isExternalUrl(url?: string): boolean {
  return !!url && url.startsWith("https://");
}

function issueLink(identifier: string, opts?: IssueLinksOpts): string {
  if (opts?.baseUrl && opts?.issuePrefix) {
    const url = `${opts.baseUrl}/${opts.issuePrefix}/issues/${identifier}`;
    return `[${esc(identifier)}](${url})`;
  }
  return bold(identifier);
}

function issueButton(identifier: string, opts?: IssueLinksOpts): { text: string; url: string } | null {
  if (opts?.baseUrl && opts?.issuePrefix && isExternalUrl(opts.baseUrl)) {
    return { text: `Open ${identifier} ↗`, url: `${opts.baseUrl}/${opts.issuePrefix}/issues/${identifier}` };
  }
  return null;
}

function agentButton(agentId: string, label: string, publicUrl?: string): { text: string; url: string } | null {
  if (publicUrl && isExternalUrl(publicUrl)) {
    return { text: label, url: `${publicUrl}/agents/${agentId}` };
  }
  return null;
}

function isUuidLike(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function displayAgentName(value: string): string {
  return isUuidLike(value) ? `Agent ${value.slice(0, 8)}` : value;
}

function runButton(agentId: string, runId: string | null, publicUrl?: string): { text: string; url: string } | null {
  if (publicUrl && isExternalUrl(publicUrl) && runId) {
    return { text: "View Run ↗", url: `${publicUrl}/agents/${agentId}/runs/${runId}` };
  }
  return null;
}

// Renders only when the inline error text was cut, and takes runButton's
// place in the keyboard row rather than sitting alongside it: the run
// dashboard exposes no error-anchored URL, so both buttons would point at
// the identical `/runs/:runId` page. Two labels for one URL reads as
// broken, so the more accurate label ("Full error", surfaced right below
// the truncated text it completes) wins the slot; formatAgentError falls
// back to runButton when the message wasn't truncated.
function fullErrorButton(agentId: string, runId: string | null, publicUrl?: string): { text: string; url: string } | null {
  if (publicUrl && isExternalUrl(publicUrl) && runId) {
    return { text: "Full error ↗", url: `${publicUrl}/agents/${agentId}/runs/${runId}` };
  }
  return null;
}

function classifyAgentError(errorMessage: string): string {
  if (/timed?\s*out|timeout/i.test(errorMessage)) return "Agent Timeout";
  if (/limit|rate.?limit|quota/i.test(errorMessage)) return "Agent Rate Limit";
  return "Agent Error";
}

// Issue-lifecycle notifications (created/assigned/done) are
// silent for low/medium priority issues so routine churn doesn't buzz the phone; high/critical
// priority stays loud, and unknown priority defaults to loud so we never silently swallow a
// notification we can't classify. Approvals and agent errors are always loud, unconditionally.
const SILENT_ISSUE_PRIORITIES = new Set(["low", "medium"]);

function silentForPriority(priority: string | null): boolean {
  return priority !== null && SILENT_ISSUE_PRIORITIES.has(priority.toLowerCase());
}

export function formatIssueCreated(event: PluginEvent, opts?: IssueLinksOpts): FormattedMessage {
  const p = event.payload as Payload;
  const identifier = str(p.identifier, event.entityId);
  const title = str(p.title, "Untitled");
  const status = p.status ? str(p.status) : null;
  const priority = p.priority ? str(p.priority) : null;
  const assigneeName = p.assigneeName ? str(p.assigneeName) : null;
  const projectName = p.projectName ? str(p.projectName) : null;

  const lines: string[] = [
    `${esc("📋")} ${bold("Issue Created")}: ${issueLink(identifier, opts)}`,
    bold(title),
  ];

  const meta: string[] = [];
  if (status) meta.push(`Status: ${code(status)}`);
  if (priority) meta.push(`Priority: ${code(priority)}`);
  if (assigneeName) meta.push(`Assignee: ${esc(assigneeName)}`);
  if (projectName) meta.push(`Project: ${esc(projectName)}`);
  if (meta.length > 0) lines.push(meta.join(" \\| "));

  if (p.description) {
    const desc = truncateAtWord(str(p.description), 200);
    lines.push(`\n${esc(">")} ${esc(desc)}`);
  }

  const button = issueButton(identifier, opts);
  return {
    text: lines.join("\n"),
    options: {
      parseMode: "MarkdownV2",
      ...(silentForPriority(priority) ? { disableNotification: true } : {}),
      ...(button ? { inlineKeyboard: [[button]] } : {}),
    },
  };
}

export function formatIssueAssigned(event: PluginEvent, opts?: IssueLinksOpts): FormattedMessage {
  const p = event.payload as Payload;
  const prev = (p._previous as Payload | undefined) ?? {};
  const identifier = str(p.identifier, event.entityId);
  const title = str(p.title, "Untitled");
  const priority = p.priority ? str(p.priority) : null;
  const assigneeName = p.assigneeName ? str(p.assigneeName) : null;
  const prevAssigneeName = prev.assigneeName ? str(prev.assigneeName) : null;

  const lines: string[] = [
    `${esc("🎯")} ${bold("Issue Assigned")}: ${issueLink(identifier, opts)}`,
    bold(title),
  ];

  if (assigneeName) {
    lines.push(
      prevAssigneeName
        ? `Assignee: ${esc(prevAssigneeName)} ${esc("→")} ${esc(assigneeName)}`
        : `Assignee: ${esc(assigneeName)}`,
    );
  } else {
    lines.push(esc("Unassigned"));
  }

  const button = issueButton(identifier, opts);
  return {
    text: lines.join("\n"),
    options: {
      parseMode: "MarkdownV2",
      ...(silentForPriority(priority) ? { disableNotification: true } : {}),
      ...(button ? { inlineKeyboard: [[button]] } : {}),
    },
  };
}

export function formatIssueDone(event: PluginEvent, opts?: IssueLinksOpts): FormattedMessage {
  const p = event.payload as Payload;
  const identifier = str(p.identifier, event.entityId);
  const title = str(p.title);
  const priority = p.priority ? str(p.priority) : null;
  const comment = p.comment ? str(p.comment) : null;

  const lines: string[] = [
    `${esc("✅")} ${bold("Issue Completed")}: ${issueLink(identifier, opts)}`,
    `${bold(title)} ${esc("is now done.")}`,
  ];

  if (comment) {
    const truncated = truncateAtWord(comment, 300);
    lines.push(`\n${esc(">")} ${esc(truncated)}`);
  }

  const button = issueButton(identifier, opts);
  return {
    text: lines.join("\n"),
    options: {
      parseMode: "MarkdownV2",
      ...(silentForPriority(priority) ? { disableNotification: true } : {}),
      ...(button ? { inlineKeyboard: [[button]] } : {}),
    },
  };
}

export function formatApprovalCreated(event: PluginEvent, opts?: IssueLinksOpts): FormattedMessage {
  const p = event.payload as Payload;
  const approvalType = str(p.type, "unknown");
  const approvalId = str(p.approvalId, event.entityId);
  const title = str(p.title, "Approval Requested");
  const description = p.description ? str(p.description) : null;
  const agentName = p.agentName ? str(p.agentName) : null;

  const lines: string[] = [
    `${esc("🔔")} ${bold("Approval Requested")}`,
    bold(title),
  ];

  if (agentName) lines.push(`Agent: ${esc(agentName)} \\| Type: ${code(approvalType)}`);
  if (description) lines.push(`\n${esc(truncateAtWord(description, 300))}`);

  // Add linked issues if present
  const linkedIssues = Array.isArray(p.linkedIssues) ? p.linkedIssues as Array<Payload> : [];
  if (linkedIssues.length > 0) {
    lines.push(`\n${bold(`Linked Issues (${String(linkedIssues.length)})`)}`);
    for (const issue of linkedIssues.slice(0, 5)) {
      const issueId = str(issue.identifier, "?");
      const issueParts = [`${issueLink(issueId, opts)} ${esc(str(issue.title))}`];
      const issueMeta: string[] = [];
      if (issue.status) issueMeta.push(str(issue.status));
      if (issue.priority) issueMeta.push(str(issue.priority));
      if (issue.assignee) issueMeta.push(`-> ${str(issue.assignee)}`);
      if (issueMeta.length > 0) issueParts.push(`\\(${esc(issueMeta.join(" | "))}\\)`);
      lines.push(issueParts.join(" "));
    }
  }

  const keyboard: Array<Array<{ text: string; callback_data?: string; url?: string }>> = [
    [
      { text: "Approve", callback_data: `approve_${approvalId}` },
      { text: "Reject", callback_data: `reject_${approvalId}` },
    ],
  ];

  // Add deep link to the first linked issue if available
  if (linkedIssues.length > 0) {
    const firstIssueId = str(linkedIssues[0]!.identifier);
    if (firstIssueId) {
      const btn = issueButton(firstIssueId, opts);
      if (btn) keyboard.push([btn]);
    }
  }

  return {
    text: lines.join("\n"),
    options: {
      parseMode: "MarkdownV2",
      inlineKeyboard: keyboard,
    },
  };
}

export function formatAgentError(event: PluginEvent, opts?: IssueLinksOpts): FormattedMessage {
  const p = event.payload as Payload;
  const agentId = str(p.agentId, event.entityId);
  const rawAgentName = str(p.agentName, str(p.name, agentId));
  const agentName = displayAgentName(rawAgentName);
  const errorMessage = str(p.error, str(p.message, "Unknown error"));
  const runId = p.runId ? str(p.runId) : null;
  const companyName = p.companyName ? str(p.companyName) : null;
  const issueIdentifier = p.issueIdentifier ? str(p.issueIdentifier) : null;
  const issueTitle = p.issueTitle ? str(p.issueTitle) : null;

  const lines: string[] = [
    `${esc("❌")} ${bold(classifyAgentError(errorMessage))}`,
    `Agent: ${bold(agentName)}`,
  ];
  // The compact label hides the identifier it was derived from, and the "View Agent"
  // button only exists when a public base URL is configured. Keep the full id in a
  // metadata line so error notifications stay correlatable without one.
  if (agentName !== rawAgentName) lines.push(`Agent ID: ${code(rawAgentName)}`);
  if (companyName) lines.push(`Company: ${esc(companyName)}`);
  if (issueIdentifier) {
    lines.push(
      issueTitle
        ? `Issue: ${issueLink(issueIdentifier, opts)} ${esc("—")} ${esc(issueTitle)}`
        : `Issue: ${issueLink(issueIdentifier, opts)}`,
    );
  }
  const isTruncated = errorMessage.length > AGENT_ERROR_TRUNCATE_LENGTH;
  lines.push(`\n${code(truncateAtWord(errorMessage, AGENT_ERROR_TRUNCATE_LENGTH))}`);

  // fullErrorButton and runButton point at the same run page, so only one
  // occupies the slot — never both.
  const fullError = isTruncated ? fullErrorButton(agentId, runId, opts?.baseUrl) : null;
  const buttons = [
    fullError,
    fullError ? null : runButton(agentId, runId, opts?.baseUrl),
    issueIdentifier ? issueButton(issueIdentifier, opts) : null,
    agentButton(agentId, "View Agent ↗", opts?.baseUrl),
  ].filter((button): button is { text: string; url: string } => Boolean(button));

  return {
    text: lines.join("\n"),
    options: {
      parseMode: "MarkdownV2",
      ...(buttons.length > 0 ? { inlineKeyboard: [buttons] } : {}),
    },
  };
}

export function formatAgentRunStarted(event: PluginEvent, opts?: IssueLinksOpts): FormattedMessage {
  const p = event.payload as Payload;
  const agentId = str(p.agentId, event.entityId);
  const agentName = displayAgentName(str(p.agentName, agentId));
  const runId = p.runId ? str(p.runId) : null;

  const buttons: Array<{ text: string; url: string }> = [];
  if (opts?.baseUrl && isExternalUrl(opts.baseUrl)) {
    const url = runId
      ? `${opts.baseUrl}/agents/${agentId}/runs/${runId}`
      : `${opts.baseUrl}/agents/${agentId}`;
    buttons.push({ text: "View Run ↗", url });
  }

  return {
    text: `${esc("▶️")} ${bold(agentName)} ${esc("started run")}`,
    options: {
      parseMode: "MarkdownV2",
      disableNotification: true,
      ...(buttons.length > 0 ? { inlineKeyboard: [buttons] } : {}),
    },
  };
}

export function formatAgentRunFinished(event: PluginEvent, opts?: IssueLinksOpts): FormattedMessage {
  const p = event.payload as Payload;
  const agentId = str(p.agentId, event.entityId);
  const agentName = displayAgentName(str(p.agentName, agentId));
  const runId = p.runId ? str(p.runId) : null;

  const buttons: Array<{ text: string; url: string }> = [];
  if (opts?.baseUrl && isExternalUrl(opts.baseUrl)) {
    const url = runId
      ? `${opts.baseUrl}/agents/${agentId}/runs/${runId}`
      : `${opts.baseUrl}/agents/${agentId}`;
    buttons.push({ text: "View Run ↗", url });
  }

  return {
    text: `${esc("✅")} ${bold(agentName)} ${esc("completed run")}`,
    options: {
      parseMode: "MarkdownV2",
      disableNotification: true,
      ...(buttons.length > 0 ? { inlineKeyboard: [buttons] } : {}),
    },
  };
}

export type InteractionIssueInfo = { identifier?: string | null; title?: string | null };

// Daily decision card (issue-thread `request_confirmation`). Unlike the
// event-based formatters above this takes the interaction object directly —
// decision cards arrive via `ctx.issues.listInteractions`, not a PluginEvent.
//
// Two action buttons carry the interaction id in their `callback_data`
// (`int_accept_`/`int_reject_` + UUID, ~47 bytes, well under Telegram's 64);
// the callback handler recovers issue/company from the notification's stored
// `msg_` mapping. Always loud: a decision card is something a human must act on.
export function formatIssueInteraction(
  interaction: RequestConfirmationInteraction,
  issue: InteractionIssueInfo = {},
  opts?: IssueLinksOpts,
): FormattedMessage {
  const payload = interaction.payload;
  const heading = interaction.title?.trim() || "Decision needed";

  const lines: string[] = [`${esc("🗳️")} ${bold(heading)}`];

  const identifier = issue.identifier?.trim();
  if (identifier) {
    const title = issue.title?.trim();
    lines.push(title ? `${issueLink(identifier, opts)} ${esc(title)}` : issueLink(identifier, opts));
  }

  lines.push(`\n${esc(truncateAtWord(payload.prompt, 500))}`);

  const details = payload.detailsMarkdown?.trim();
  if (details) lines.push(`\n${esc(truncateAtWord(details, 500))}`);

  const acceptLabel = payload.acceptLabel?.trim() || "Approve";
  const rejectLabel = payload.rejectLabel?.trim() || "Reject";

  const keyboard: Array<Array<{ text: string; callback_data?: string; url?: string }>> = [
    [
      { text: `✅ ${acceptLabel}`, callback_data: buildInteractionCallbackData("accept", interaction.id) },
      { text: `❌ ${rejectLabel}`, callback_data: buildInteractionCallbackData("reject", interaction.id) },
    ],
  ];

  if (identifier) {
    const btn = issueButton(identifier, opts);
    if (btn) keyboard.push([btn]);
  }

  return {
    text: lines.join("\n"),
    options: {
      parseMode: "MarkdownV2",
      inlineKeyboard: keyboard,
    },
  };
}

// Caps so a card with many items/questions stays well inside Telegram's
// 4096-char message limit; the deep link leads to the full list in Paperclip.
const NOTICE_MAX_ITEMS = 10;
const NOTICE_MAX_QUESTIONS = 8;
const NOTICE_MAX_OPTIONS = 6;

/**
 * Notify-only card for a pending decision the plugin cannot resolve from
 * Telegram: `ask_user_questions` and `request_item_verdicts`. `respondInteraction`
 * is accept/reject only, so there is no button that answers these — the card
 * summarizes what is pending and links out to Paperclip, where the board user
 * answers. Always loud: a human must act. Carries no resolve `callback_data`,
 * only an "Open" URL button, so the callback handler never has to touch it.
 */
export function formatIssueInteractionNotice(
  interaction: AskUserQuestionsInteraction | RequestItemVerdictsInteraction,
  issue: InteractionIssueInfo = {},
  opts?: IssueLinksOpts,
): FormattedMessage {
  const isQuestions = interaction.kind === "ask_user_questions";
  const heading =
    interaction.title?.trim() || (isQuestions ? "Questions need answering" : "Items need review");

  const lines: string[] = [`${esc("🗳️")} ${bold(heading)}`];

  const identifier = issue.identifier?.trim();
  if (identifier) {
    const title = issue.title?.trim();
    lines.push(title ? `${issueLink(identifier, opts)} ${esc(title)}` : issueLink(identifier, opts));
  }

  if (interaction.kind === "request_item_verdicts") {
    const payload = interaction.payload;
    lines.push(`\n${esc(truncateAtWord(payload.prompt, 400))}`);
    const details = payload.detailsMarkdown?.trim();
    if (details) lines.push(`\n${esc(truncateAtWord(details, 300))}`);

    const items = payload.items ?? [];
    const shown = items.slice(0, NOTICE_MAX_ITEMS);
    if (shown.length > 0) {
      lines.push("");
      for (const item of shown) lines.push(esc(`• ${item.label}`));
      if (items.length > shown.length) lines.push(esc(`…and ${items.length - shown.length} more`));
    }
  } else {
    const payload = interaction.payload;
    const title = payload.title?.trim();
    if (title) lines.push(`\n${esc(truncateAtWord(title, 300))}`);

    const questions = payload.questions ?? [];
    const shown = questions.slice(0, NOTICE_MAX_QUESTIONS);
    if (shown.length > 0) {
      lines.push("");
      for (const question of shown) {
        lines.push(esc(`• ${truncateAtWord(question.prompt, 200)}`));
        const options = (question.options ?? []).slice(0, NOTICE_MAX_OPTIONS).map((o) => o.label);
        if (options.length > 0) lines.push(`  ${esc(options.join(" / "))}`);
      }
      if (questions.length > shown.length) {
        lines.push(esc(`…and ${questions.length - shown.length} more`));
      }
    }
  }

  lines.push(`\n${esc("↗ Open in Paperclip to respond — this can't be answered from Telegram.")}`);

  const keyboard: Array<Array<{ text: string; url: string }>> = [];
  if (identifier) {
    const btn = issueButton(identifier, opts);
    if (btn) keyboard.push([btn]);
  }

  return {
    text: lines.join("\n"),
    options: {
      parseMode: "MarkdownV2",
      ...(keyboard.length > 0 ? { inlineKeyboard: keyboard } : {}),
    },
  };
}
