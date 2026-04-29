import {
  definePlugin,
  runWorker,
  type PluginContext,
  type PluginEvent,
  type PluginHealthDiagnostics,
  type Agent,
  type Issue,
} from "@paperclipai/plugin-sdk";
import {
  sendMessage,
  editMessage,
  answerCallbackQuery,
  setMyCommands,
  escapeMarkdownV2,
  isForum,
  GENERAL_TOPIC_THREAD_ID,
} from "./telegram-api.js";
import {
  formatIssueCreated,
  formatIssueDone,
  formatIssueAssigned,
  formatApprovalCreated,
  formatIssueRequestConfirmation,
  formatAgentError,
  formatAgentRunStarted,
  formatAgentRunFinished,
  type IssueLinksOpts,
} from "./formatters.js";
import { handleCommand, resolveNotificationThreadId, BOT_COMMANDS } from "./commands.js";
import {
  routeMessageToAgent,
  handleHandoffToolCall,
  handleDiscussToolCall,
  handleHandoffApproval,
  handleHandoffRejection,
  setupAcpOutputListener,
} from "./acp-bridge.js";
import { handleMediaMessage } from "./media-pipeline.js";
import { getPersistedTelegramUpdateOffset, persistTelegramUpdateOffset } from "./polling-offset.js";
import { classifyUpdate, STALE_UPDATE_GRACE_SECONDS } from "./update-filter.js";
import { handleCommandsCommand, tryCustomCommand } from "./command-registry.js";
import { handleRegisterWatch, checkWatches } from "./watch-registry.js";
import { METRIC_NAMES } from "./constants.js";
import { EscalationManager } from "./escalation.js";
import type { EscalationEvent } from "./escalation.js";
import { isTelegramUpdateAllowed, validateTelegramAllowlists } from "./allowlist.js";
import { resolvePaperclipApiBaseUrl } from "./paperclip-api.js";
import { createIgorRecoveryIssueForRunFailure } from "./recovery.js";

type TelegramConfig = {
  telegramBotTokenRef: string;
  defaultChatId: string;
  approvalsChatId: string;
  errorsChatId: string;
  paperclipBaseUrl: string;
  paperclipPublicUrl: string;
  notifyOnIssueCreated: boolean;
  notifyOnIssueDone: boolean;
  notifyOnIssueAssigned: boolean;
  onlyNotifyIfAssignedTo: string;
  notifyOnApprovalCreated: boolean;
  notifyOnAgentError: boolean;
  enableCommands: boolean;
  enableInbound: boolean;
  allowedTelegramUserIds: string[];
  allowedTelegramChatIds: string[];
  digestMode: "off" | "daily" | "bidaily" | "tridaily";
  dailyDigestTime: string;
  bidailySecondTime: string;
  tridailyTimes: string;
  topicRouting: boolean;
  escalationChatId: string;
  escalationTimeoutMs: number;
  escalationDefaultAction: "defer" | "auto_reply" | "close";
  escalationHoldMessage: string;
  // Phase 3: Media Pipeline
  briefAgentId: string;
  briefAgentChatIds: string[];
  transcriptionApiKeyRef: string;
  // Phase 5: Proactive Suggestions
  maxSuggestionsPerHourPerCompany: number;
  watchDeduplicationWindowMs: number;
};

type TelegramUpdate = {
  update_id: number;
  message?: {
    message_id: number;
    date?: number;
    from?: { id: number; username?: string; first_name?: string };
    chat: { id: number; type: string; title?: string };
    text?: string;
    message_thread_id?: number;
    reply_to_message?: {
      message_id: number;
      text?: string;
      from?: { is_bot?: boolean };
    };
    entities?: Array<{ type: string; offset: number; length: number }>;
    // Media fields (Phase 3)
    voice?: { file_id: string; duration: number; mime_type?: string };
    audio?: { file_id: string; duration: number; title?: string; mime_type?: string };
    video_note?: { file_id: string; duration: number };
    document?: { file_id: string; file_name?: string; mime_type?: string };
    photo?: Array<{ file_id: string; width: number; height: number }>;
    caption?: string;
  };
  callback_query?: {
    id: string;
    from: { id: number; username?: string; first_name?: string };
    message?: {
      message_id: number;
      date?: number;
      chat: { id: number };
      text?: string;
    };
    data?: string;
  };
};

const TELEGRAM_API = "https://api.telegram.org";

/**
 * Shared 5s sliding-window dedupe for issue.updated handlers.
 *
 * Paperclip's core can emit duplicate `issue.updated` plugin events for a
 * single PATCH (the route's logActivity plus side-effects from heartbeat
 * reconciliation), so handlers must dedupe to avoid sending the same
 * Telegram message twice.
 */
function makeUpdateDedupe(windowMs = 5_000, maxEntries = 500) {
  const seen = new Map<string, number>();
  return (key: string): boolean => {
    const now = Date.now();
    const last = seen.get(key);
    if (last !== undefined && now - last < windowMs) return false;
    seen.set(key, now);
    if (seen.size > maxEntries) {
      const cutoff = now - windowMs;
      for (const [k, ts] of seen) {
        if (ts < cutoff) seen.delete(k);
      }
    }
    return true;
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

async function resolveChat(
  ctx: PluginContext,
  companyId: string,
  fallback: string,
): Promise<string | null> {
  const override = await ctx.state.get({
    scopeKind: "company",
    scopeId: companyId,
    stateKey: "telegram-chat",
  });
  return (override as string) ?? fallback ?? null;
}

async function resolveCompanyId(ctx: PluginContext, chatId: string): Promise<string> {
  const mapping = await ctx.state.get({
    scopeKind: "instance",
    stateKey: `chat_${chatId}`,
  }) as { companyId?: string; companyName?: string } | null;
  return mapping?.companyId ?? mapping?.companyName ?? chatId;
}

const plugin = definePlugin({
  async setup(ctx) {
    const rawConfig = await ctx.config.get();
    ctx.logger.info("Telegram plugin config loaded");
    const config = rawConfig as unknown as TelegramConfig;
    const baseUrl = config.paperclipBaseUrl || "http://localhost:3100";
    const publicUrl = config.paperclipPublicUrl || baseUrl;

    if (!config.telegramBotTokenRef) {
      ctx.logger.warn("No telegramBotTokenRef configured, plugin disabled");
      return;
    }

    const token = await ctx.secrets.resolve(config.telegramBotTokenRef);

    // --- Register bot commands with Telegram ---
    if (config.enableCommands) {
      const allCommands = [
        ...BOT_COMMANDS,
        { command: "commands", description: "Manage custom workflow commands" },
      ];
      // Non-blocking init: don't hold up worker initialize on external API.
      // The host's worker-init RPC timeout is 15s; if api.telegram.org is
      // slow/unreachable, awaiting this call causes the worker to be SIGKILLed
      // before setup() completes. Fire-and-forget matches pollUpdates() below.
      setMyCommands(ctx, token, allCommands)
        .then((registered) => {
          if (registered) {
            ctx.logger.info("Bot commands registered with Telegram");
          }
        })
        .catch((err) => {
          ctx.logger.error("Failed to register bot commands", {
            error: String(err),
          });
        });
    }

    // --- Long polling for inbound messages ---
    let pollingActive = true;
    const pollingStartedAtSeconds = Math.floor(Date.now() / 1000);
    let lastUpdateId = await getPersistedTelegramUpdateOffset(ctx);

    async function pollUpdates(): Promise<void> {
      while (pollingActive) {
        try {
          const res = await ctx.http.fetch(
            `${TELEGRAM_API}/bot${token}/getUpdates?offset=${lastUpdateId + 1}&timeout=10&allowed_updates=["message","callback_query"]`,
            { method: "GET" },
          );
          const data = (await res.json()) as {
            ok: boolean;
            result?: TelegramUpdate[];
          };

          if (data.ok && data.result) {
            for (const update of data.result) {
              const decision = classifyUpdate(update, lastUpdateId, pollingStartedAtSeconds);
              if (decision.action === "skip" && decision.reason === "duplicate") {
                continue;
              }

              // Persist offset before handling. If handling sends a Telegram reply and then
              // crashes before the offset write, the same update is replayed on restart and
              // can flood the chat. At-most-once command handling is safer than replay.
              lastUpdateId = update.update_id;
              try {
                await persistTelegramUpdateOffset(ctx, lastUpdateId);
              } catch (err) {
                ctx.logger.error("Failed to persist Telegram polling offset before handling", {
                  updateId: lastUpdateId,
                  error: String(err),
                });
                continue;
              }

              if (decision.action === "skip" && decision.reason === "stale") {
                ctx.logger.info("Skipping stale Telegram update", {
                  updateId: update.update_id,
                  pollingStartedAtSeconds,
                  graceSeconds: STALE_UPDATE_GRACE_SECONDS,
                });
                continue;
              }

              try {
                await handleUpdate(ctx, token, config, update, baseUrl, publicUrl);
              } catch (err) {
                ctx.logger.error("Telegram update handling failed", {
                  updateId: update.update_id,
                  error: String(err),
                });
              }
            }
          }
        } catch (err) {
          ctx.logger.error("Telegram polling error", { error: String(err) });
          await new Promise((r) => setTimeout(r, 5000));
        }
      }
    }

    if (config.enableCommands || config.enableInbound) {
      pollUpdates().catch((err) =>
        ctx.logger.error("Polling loop crashed", { error: String(err) }),
      );
    }

    ctx.events.on("plugin.stopping", async () => {
      pollingActive = false;
    });

    // --- Phase 2: ACP output listener (cross-plugin events) ---
    setupAcpOutputListener(ctx, token);

    // --- Event subscriptions ---

    // Local policy (2026-04-29): drop replayed/stale host events on plugin startup.
    // The Paperclip host may deliver queued historical events when a plugin is re-enabled
    // after downtime. Without this guard, a repair/restart can replay hundreds of old
    // issue.created/issue.updated events as fresh Telegram notifications.
    const pluginStartedAtMs = Date.now();
    const replayGraceMs = 30_000;
    function isFreshEvent(event: PluginEvent): boolean {
      const occurredAtMs = Date.parse(String(event.occurredAt ?? ""));
      if (!Number.isFinite(occurredAtMs)) return true;
      return occurredAtMs >= pluginStartedAtMs - replayGraceMs;
    }

    const issuePrefixCache = new Map<string, string>();

    async function resolveIssueLinksOpts(companyId: string): Promise<IssueLinksOpts> {
      let prefix = issuePrefixCache.get(companyId);
      if (!prefix) {
        const company = await ctx.companies.get(companyId);
        prefix = company?.issuePrefix ?? "";
        if (prefix) issuePrefixCache.set(companyId, prefix);
      }
      return { baseUrl: publicUrl, issuePrefix: prefix || undefined };
    }

    const notify = async (
      event: PluginEvent,
      formatter: (e: PluginEvent, opts?: IssueLinksOpts) => { text: string; options: import("./telegram-api.js").SendMessageOptions },
      overrideChatId?: string,
    ) => {
      if (!isFreshEvent(event)) {
        ctx.logger.info("Skipping stale Telegram notification event", {
          eventType: event.eventType,
          eventId: event.eventId,
          occurredAt: event.occurredAt,
        });
        return;
      }
      const chatId = await resolveChat(
        ctx,
        event.companyId,
        overrideChatId || config.defaultChatId,
      );
      if (!chatId) return;
      const linksOpts = await resolveIssueLinksOpts(event.companyId);
      const msg = formatter(event, linksOpts);

      let messageThreadId: number | undefined;
      messageThreadId = await resolveNotificationThreadId(ctx, chatId, event, config.topicRouting);

      if (messageThreadId) {
        msg.options.messageThreadId = messageThreadId;
      }

      // Issue threading — if we've already sent a message for this entity in this
      // chat+topic, reply to that anchor so all updates about a single entity stack
      // as one Telegram thread on mobile (created → comments → done).
      const anchorKey = event.entityId
        ? `anchor_${chatId}_${event.entityType}_${event.entityId}`
        : null;
      if (anchorKey) {
        const anchor = (await ctx.state.get({
          scopeKind: "instance",
          stateKey: anchorKey,
        })) as { messageId: number; messageThreadId?: number } | null;
        // Only thread when targeting the same topic — Telegram rejects cross-topic replies.
        if (anchor?.messageId && anchor.messageThreadId === messageThreadId) {
          msg.options.replyToMessageId = anchor.messageId;
        }
      }

      const messageId = await sendMessage(ctx, token, chatId, msg.text, msg.options);

      if (messageId) {
        await ctx.state.set(
          {
            scopeKind: "instance",
            stateKey: `msg_${chatId}_${messageId}`,
          },
          {
            entityId: event.entityId,
            entityType: event.entityType,
            companyId: event.companyId,
            eventType: event.eventType,
          },
        );

        await ctx.activity.log({
          companyId: event.companyId,
          message: `Forwarded ${event.eventType} to Telegram`,
          entityType: "plugin",
          entityId: event.entityId,
        });

        // First-message-per-entity: store the anchor so future notifications about the
        // same entity reply to this one. Never overwritten — the first message stays root.
        if (anchorKey) {
          const existing = (await ctx.state.get({
            scopeKind: "instance",
            stateKey: anchorKey,
          })) as { messageId: number; messageThreadId?: number } | null;
          if (!existing) {
            await ctx.state.set(
              { scopeKind: "instance", stateKey: anchorKey },
              { messageId, messageThreadId },
            );
          }
        }
      }
    };

    if (config.notifyOnIssueCreated) {
      ctx.events.on("issue.created", (event: PluginEvent) =>
        notify(event, formatIssueCreated),
      );
    }

    if (config.notifyOnIssueDone) {
      const resultDedupe = makeUpdateDedupe();
      ctx.events.on("issue.updated", async (event: PluginEvent) => {
        const payload = event.payload as Record<string, unknown>;
        const status = String(payload.status ?? "");
        if (status !== "done" && status !== "in_review") return;
        if (!resultDedupe(`${status}|${event.entityId}`)) return;
        // Enrich with issue fields if missing (issue.updated events often omit them).
        if ((!payload.title || !payload.identifier) && event.entityId) {
          try {
            const issue = await ctx.issues.get(event.entityId, event.companyId);
            if (issue) {
              payload.title = issue.title;
              payload.identifier ??= issue.identifier;
              payload.priority ??= issue.priority;
              payload.assigneeAgentId ??= issue.assigneeAgentId;
              payload.assigneeUserId ??= issue.assigneeUserId;
            }
          } catch { /* best effort */ }
        }
        // Enrich with latest comment. This is the delegated-work completion bridge:
        // the raw terminal status event gets paired with the agent's closing/review
        // comment so Michael sees the result/recommendation, not just lifecycle noise.
        if (!payload.comment && event.entityId) {
          try {
            const comments = await ctx.issues.listComments(event.entityId, event.companyId);
            if (comments.length > 0) {
              const latest = comments.reduce((a, b) =>
                new Date(a.createdAt) > new Date(b.createdAt) ? a : b,
              );
              payload.comment = latest.body;
            }
          } catch { /* best effort */ }
        }
        await notify(event, formatIssueDone);
      });
    }

    if (config.notifyOnIssueAssigned) {
      const assignmentDedupe = makeUpdateDedupe();

      ctx.events.on("issue.updated", async (event: PluginEvent) => {
        const payload = event.payload as Record<string, unknown>;
        const prev = (payload._previous as Record<string, unknown> | undefined) ?? {};

        const userChanged =
          "assigneeUserId" in payload && payload.assigneeUserId !== prev.assigneeUserId;
        const agentChanged =
          "assigneeAgentId" in payload && payload.assigneeAgentId !== prev.assigneeAgentId;
        if (!userChanged && !agentChanged) return;

        if (config.onlyNotifyIfAssignedTo && payload.assigneeUserId !== config.onlyNotifyIfAssignedTo) {
          return;
        }

        const dedupeKey = [
          "assigned",
          event.entityId,
          String(prev.assigneeUserId ?? ""),
          String(payload.assigneeUserId ?? ""),
          String(prev.assigneeAgentId ?? ""),
          String(payload.assigneeAgentId ?? ""),
        ].join("|");
        if (!assignmentDedupe(dedupeKey)) return;

        if ((!payload.title || !payload.assigneeName) && event.entityId) {
          try {
            const issue = await ctx.issues.get(event.entityId, event.companyId);
            if (issue) {
              payload.title ??= issue.title;
              const name = (issue as unknown as Record<string, unknown>).assigneeName;
              if (name) payload.assigneeName ??= name;
            }
          } catch { /* best effort */ }
        }

        await notify(event, formatIssueAssigned);
      });
    }

    if (config.notifyOnApprovalCreated) {
      ctx.events.on("approval.created", async (event: PluginEvent) => {
        const payload = event.payload as Record<string, unknown>;
        // Enrich with linked issue details (event only has issueIds)
        const issueIds = Array.isArray(payload.issueIds) ? payload.issueIds as string[] : [];
        if (issueIds.length > 0 && !payload.linkedIssues) {
          try {
            const issues = await Promise.all(
              issueIds.slice(0, 5).map((id) => ctx.issues.get(id, event.companyId)),
            );
            payload.linkedIssues = issues
              .filter(Boolean)
              .map((i) => ({
                identifier: i!.identifier,
                title: i!.title,
                status: i!.status,
                priority: i!.priority,
              }));
            // Use first issue's title as the approval title if missing
            if (!payload.title && issues[0]) {
              payload.title = issues[0].identifier
                ? `${issues[0].identifier}: ${issues[0].title}`
                : issues[0].title;
            }
          } catch { /* best effort */ }
        }
        // Enrich agent name
        if (payload.agentId && !payload.agentName) {
          try {
            const agent = await ctx.agents.get(String(payload.agentId), event.companyId);
            if (agent) payload.agentName = agent.name;
          } catch { /* best effort */ }
        }
        // Build a meaningful title if still missing
        if (!payload.title || payload.title === "Approval Requested") {
          const approvalType = String(payload.type ?? "unknown").replace(/_/g, " ");
          const agentLabel = payload.agentName ? String(payload.agentName) : null;
          payload.title = agentLabel
            ? `${approvalType} — ${agentLabel}`
            : approvalType;
        }
        await notify(event, formatApprovalCreated, config.approvalsChatId);
      });

      const confirmationDedupe = makeUpdateDedupe(60_000, 500);
      ctx.events.on("issue.thread_interaction_created" as never, async (event: PluginEvent) => {
        const payload = event.payload as Record<string, unknown>;
        const interaction = asRecord(payload.interaction ?? payload.threadInteraction ?? payload);
        const interactionPayload = asRecord(interaction.payload ?? payload.payload);
        const kind = firstNonEmptyString(interaction.kind, payload.kind);
        if (kind !== "request_confirmation") return;

        const status = firstNonEmptyString(interaction.status, payload.status, interactionPayload.status);
        if (status && status !== "pending") return;

        const interactionId = firstNonEmptyString(interaction.id, payload.interactionId, event.entityId);
        const issueId = firstNonEmptyString(payload.issueId, interaction.issueId, interactionPayload.issueId);
        if (!interactionId || !issueId) {
          ctx.logger.error("Cannot notify request_confirmation without interaction and issue ids", {
            eventId: event.eventId,
            eventType: event.eventType,
          });
          return;
        }

        const idempotencyKey = firstNonEmptyString(interaction.idempotencyKey, payload.idempotencyKey);
        const dedupeKey = idempotencyKey ?? `${issueId}|${interactionId}`;
        if (!confirmationDedupe(dedupeKey)) return;

        await ctx.state.set(
          { scopeKind: "instance", stateKey: `confirmation_${interactionId}` },
          { issueId, interactionId, companyId: event.companyId },
        );

        if ((!payload.identifier || !payload.title) && issueId) {
          try {
            const issue = await ctx.issues.get(issueId, event.companyId);
            if (issue) {
              payload.identifier ??= issue.identifier;
              payload.issueIdentifier ??= issue.identifier;
              payload.issueTitle ??= issue.title;
            }
          } catch { /* best effort */ }
        }

        await notify(event, formatIssueRequestConfirmation, config.approvalsChatId);
      });
    }

    if (config.notifyOnAgentError) {
      ctx.events.on("agent.run.failed", async (event: PluginEvent) => {
        await notify(event, formatAgentError, config.errorsChatId);
        try {
          await createIgorRecoveryIssueForRunFailure(ctx, event, baseUrl);
        } catch (err) {
          ctx.logger.error("Failed to route agent failure to Igor recovery issue", {
            error: String(err),
          });
        }
      });
    }

    // Local policy (CHO-772): do not emit routine run lifecycle pings to Telegram.
    // Paperclip issue updates/comments/reassignments can legitimately spawn repeated
    // short adapter runs for the same issue; notifying each `agent.run.started` made
    // handoffs look like notification loops. Keep issue/approval/error notifications,
    // which carry the actual user-facing state change.
    // ctx.events.on("agent.run.started", (event: PluginEvent) =>
    //   notify(event, formatAgentRunStarted),
    // );
    // ctx.events.on("agent.run.finished", (event: PluginEvent) =>
    //   notify(event, formatAgentRunFinished),
    // );

    // --- Per-company chat overrides ---

    ctx.data.register("chat-mapping", async (params) => {
      const companyId = String(params.companyId);
      const saved = await ctx.state.get({
        scopeKind: "company",
        scopeId: companyId,
        stateKey: "telegram-chat",
      });
      return { chatId: saved ?? config.defaultChatId };
    });

    ctx.actions.register("set-chat", async (params) => {
      const companyId = String(params.companyId);
      const chatId = String(params.chatId);
      await ctx.state.set(
        { scopeKind: "company", scopeId: companyId, stateKey: "telegram-chat" },
        chatId,
      );
      ctx.logger.info("Updated Telegram chat mapping", { companyId, chatId });
      return { ok: true };
    });

    // --- Daily digest job ---

    // Support legacy dailyDigestEnabled boolean
    const effectiveDigestMode = (config as Record<string, unknown>).dailyDigestEnabled === true && config.digestMode === "off"
      ? "daily"
      : config.digestMode ?? "off";

    if (effectiveDigestMode !== "off") {
      ctx.jobs.register("telegram-daily-digest", async () => {
        // Check if current UTC hour matches a configured digest time
        const nowHour = new Date().getUTCHours();
        const nowMin = new Date().getUTCMinutes();
        if (nowMin >= 5) return; // only fire within first 5 min of the hour

        const parseHour = (t: string) => {
          const [h] = (t || "").split(":");
          return parseInt(h ?? "", 10);
        };
        const firstHour = parseHour(config.dailyDigestTime);
        const secondHour = parseHour(config.bidailySecondTime);
        const tridailyHours = (config.tridailyTimes || "07:00,13:00,19:00")
          .split(",")
          .map((t) => parseHour(t.trim()));

        let shouldSend = false;
        if (effectiveDigestMode === "daily") {
          shouldSend = nowHour === firstHour;
        } else if (effectiveDigestMode === "bidaily") {
          shouldSend = nowHour === firstHour || nowHour === secondHour;
        } else if (effectiveDigestMode === "tridaily") {
          shouldSend = tridailyHours.includes(nowHour);
        }
        if (!shouldSend) return;

        const companies = await ctx.companies.list();
        for (const company of companies) {
          const chatId = await resolveChat(ctx, company.id, config.defaultChatId);
          if (!chatId) continue;

          try {
            const agents = await ctx.agents.list({ companyId: company.id });
            const activeAgents = agents.filter((a: Agent) => a.status === "active");
            const issues = await ctx.issues.list({ companyId: company.id, limit: 50 });

            const now = Date.now();
            const oneDayMs = 24 * 60 * 60 * 1000;
            const completedToday = issues.filter((i: Issue) =>
              i.status === "done" && i.completedAt && (now - new Date(i.completedAt).getTime()) < oneDayMs
            );
            const createdToday = issues.filter((i: Issue) =>
              (now - new Date(i.createdAt).getTime()) < oneDayMs
            );

            const issuePrefix = company.issuePrefix;
            const inProgress = issues.filter((i: Issue) => i.status === "in_progress");
            const inReview = issues.filter((i: Issue) => i.status === "in_review");
            const blocked = issues.filter((i: Issue) => i.status === "blocked");

            const dateStr = new Date().toISOString().split("T")[0];
            const companyLabel = company.name ? ` \\- ${escapeMarkdownV2(company.name)}` : "";
            const digestLabel = effectiveDigestMode === "bidaily" ? "Digest" : "Daily Digest";
            const lines = [
              escapeMarkdownV2("\ud83d\udcca") + ` *${escapeMarkdownV2(digestLabel)}${companyLabel} \\- ${escapeMarkdownV2(dateStr!)}*`,
              "",
              `${escapeMarkdownV2("\u2705")} Tasks completed: *${completedToday.length}*`,
              `${escapeMarkdownV2("\ud83d\udccb")} Tasks created: *${createdToday.length}*`,
              `${escapeMarkdownV2("\ud83e\udd16")} Active agents: *${activeAgents.length}*/${escapeMarkdownV2(String(agents.length))}`,
            ];

            if (activeAgents.length > 0) {
              const topAgent = activeAgents[0]!.name;
              lines.push(`${escapeMarkdownV2("\u2b50")} Top performer: *${escapeMarkdownV2(topAgent)}*`);
            }

            const formatIssueItem = (i: Issue) => {
              const id = i.identifier ?? i.id;
              const idText = issuePrefix
                ? `[${escapeMarkdownV2(id)}](${publicUrl}/${issuePrefix}/issues/${id})`
                : escapeMarkdownV2(id);
              return `  ${idText} \\- ${escapeMarkdownV2(i.title)}`;
            };

            if (inProgress.length > 0) {
              lines.push("", `${escapeMarkdownV2("\ud83d\udd04")} *In Progress \\(${inProgress.length}\\)*`);
              for (const i of inProgress.slice(0, 10)) lines.push(formatIssueItem(i));
            }
            if (inReview.length > 0) {
              lines.push("", `${escapeMarkdownV2("\ud83d\udd0d")} *In Review \\(${inReview.length}\\)*`);
              for (const i of inReview.slice(0, 10)) lines.push(formatIssueItem(i));
            }
            if (blocked.length > 0) {
              lines.push("", `${escapeMarkdownV2("\ud83d\udeab")} *Blocked \\(${blocked.length}\\)*`);
              for (const i of blocked.slice(0, 10)) lines.push(formatIssueItem(i));
            }

            const digestThreadId = await isForum(ctx, token, chatId)
              ? GENERAL_TOPIC_THREAD_ID
              : undefined;

            await sendMessage(ctx, token, chatId, lines.join("\n"), {
              parseMode: "MarkdownV2",
              messageThreadId: digestThreadId,
            });
          } catch (err) {
            ctx.logger.error("Daily digest failed for company", { companyId: company.id, error: String(err) });
            const text = [
              escapeMarkdownV2("\ud83d\udcca") + " *Daily Digest*",
              "",
              escapeMarkdownV2("Could not generate digest. Check plugin logs for details."),
            ].join("\n");

            const errorThreadId = await isForum(ctx, token, chatId)
              ? GENERAL_TOPIC_THREAD_ID
              : undefined;

            await sendMessage(ctx, token, chatId, text, {
              parseMode: "MarkdownV2",
              messageThreadId: errorThreadId,
            });
          }
        }
      });
    }

    // --- Phase 1: Escalation support ---
    const escalationManager = new EscalationManager();

    // Register escalate_to_human tool - 3-arg signature with ToolRunContext
    ctx.tools.register("escalate_to_human", {
      displayName: "Escalate to Human",
      description: "Escalate a conversation to a human when you cannot handle it confidently",
      parametersSchema: {
        type: "object",
        properties: {
          reason: {
            type: "string",
            enum: ["low_confidence", "explicit_request", "policy_violation", "unknown_intent"],
            description: "Why this conversation needs human attention",
          },
          conversationSummary: {
            type: "string",
            description: "Brief summary of the conversation context and what the user needs",
          },
          suggestedActions: {
            type: "array",
            items: { type: "string" },
            description: "Suggested actions the human responder could take",
          },
          suggestedReply: {
            type: "string",
            description: "A draft reply the human can send or modify",
          },
          confidenceScore: {
            type: "number",
            minimum: 0,
            maximum: 1,
            description: "How confident the agent is (0-1). Lower values indicate greater need for human help",
          },
          originChatId: { type: "string" },
          originThreadId: { type: "string" },
          originMessageId: { type: "string" },
          sessionId: { type: "string", description: "Session ID for routing reply back" },
          transport: { type: "string", enum: ["native", "acp"], description: "Transport type for reply routing" },
        },
        required: ["reason", "conversationSummary"],
      },
    }, async (params: unknown, runCtx) => {
      const p = params as Record<string, unknown>;
      const escalationId = crypto.randomUUID();
      const timeoutMs = config.escalationTimeoutMs || 900000;
      const defaultAction = config.escalationDefaultAction || "defer";

      const resolvedEscalationChatId = await resolveChat(
        ctx,
        runCtx.companyId,
        config.escalationChatId,
      );
      if (!resolvedEscalationChatId) {
        ctx.logger.warn("Escalation received but no escalationChatId configured");
        return { error: "No escalation channel configured" };
      }

      const escalationEvent: EscalationEvent = {
        escalationId,
        agentId: runCtx.agentId,
        companyId: runCtx.companyId,
        reason: p.reason as EscalationEvent["reason"],
        context: {
          conversationHistory: [],
          agentReasoning: String(p.conversationSummary ?? ""),
          suggestedActions: (p.suggestedActions as string[]) ?? [],
          suggestedReply: p.suggestedReply ? String(p.suggestedReply) : undefined,
          confidenceScore: typeof p.confidenceScore === "number" ? p.confidenceScore : undefined,
        },
        timeout: {
          durationMs: timeoutMs,
          defaultAction,
        },
        originChatId: p.originChatId ? String(p.originChatId) : undefined,
        originThreadId: p.originThreadId ? String(p.originThreadId) : undefined,
        originMessageId: p.originMessageId ? String(p.originMessageId) : undefined,
        transport: p.transport as "native" | "acp" | undefined,
        sessionId: p.sessionId ? String(p.sessionId) : undefined,
      };

      await escalationManager.create(ctx, token, escalationEvent, resolvedEscalationChatId);

      // Send hold message to the originating chat if configured
      if (config.escalationHoldMessage && escalationEvent.originChatId) {
        const holdText = escapeMarkdownV2(config.escalationHoldMessage);
        await sendMessage(ctx, token, escalationEvent.originChatId, holdText, {
          parseMode: "MarkdownV2",
          messageThreadId: escalationEvent.originThreadId ? Number(escalationEvent.originThreadId) : undefined,
          replyToMessageId: escalationEvent.originMessageId ? Number(escalationEvent.originMessageId) : undefined,
        });
      }

      return { content: JSON.stringify({ status: "escalated", escalationId }) };
    });

    // --- Phase 2: Register handoff_to_agent tool ---
    ctx.tools.register("handoff_to_agent", {
      displayName: "Handoff to Agent",
      description: "Hand off work to another agent in this thread",
      parametersSchema: {
        type: "object",
        properties: {
          targetAgent: { type: "string", description: "Name of agent to hand off to" },
          reason: { type: "string", description: "Why you're handing off" },
          contextSummary: { type: "string", description: "Summary for the target agent" },
          requiresApproval: { type: "boolean", default: true, description: "Wait for human approval before target starts" },
          chatId: { type: "string", description: "Telegram chat ID" },
          threadId: { type: "number", description: "Telegram thread ID" },
        },
        required: ["targetAgent", "reason", "contextSummary"],
      },
    }, async (params: unknown, runCtx) => {
      return handleHandoffToolCall(ctx, token, params as Record<string, unknown>, runCtx.companyId, runCtx.agentId);
    });

    // --- Phase 2: Register discuss_with_agent tool ---
    ctx.tools.register("discuss_with_agent", {
      displayName: "Discuss with Agent",
      description: "Start a back-and-forth conversation with another agent",
      parametersSchema: {
        type: "object",
        properties: {
          targetAgent: { type: "string", description: "Name of agent to discuss with" },
          topic: { type: "string", description: "Discussion topic" },
          initialMessage: { type: "string", description: "First message to send" },
          maxTurns: { type: "number", default: 10, description: "Maximum conversation turns" },
          humanCheckpointAt: { type: "number", description: "Pause for human approval at this turn" },
          chatId: { type: "string", description: "Telegram chat ID" },
          threadId: { type: "number", description: "Telegram thread ID" },
        },
        required: ["targetAgent", "topic", "initialMessage"],
      },
    }, async (params: unknown, runCtx) => {
      return handleDiscussToolCall(ctx, token, params as Record<string, unknown>, runCtx.companyId, runCtx.agentId);
    });

    // Local policy (2026-04-29): proactive watches are disabled on this instance.
    // The watch scheduler can emit suggestions independently of issue state and caused
    // a notification storm during plugin recovery. Re-enable only after a bounded,
    // reviewed design exists.

    // --- Phase 1: Escalation timeout checker job ---
    ctx.jobs.register("check-escalation-timeouts", async () => {
      try {
        await escalationManager.checkTimeouts(ctx, token);
      } catch (err) {
        ctx.logger.error("Escalation timeout check failed", { error: String(err) });
      }
    });

    // --- Phase 5: Watch checker job disabled locally (2026-04-29). ---
    // Proactive watches are disabled until they have explicit bounded config and tests.

    ctx.logger.info("Telegram bot plugin started (Chat OS v2 - all 5 phases)");
  },

  async onValidateConfig(config) {
    if (!config.telegramBotTokenRef || typeof config.telegramBotTokenRef !== "string") {
      return { ok: false, errors: ["telegramBotTokenRef is required"] };
    }
    const allowlistErrors = validateTelegramAllowlists(config);
    if (allowlistErrors.length > 0) {
      return { ok: false, errors: allowlistErrors };
    }
    return { ok: true };
  },

  async onHealth(): Promise<PluginHealthDiagnostics> {
    return { status: "ok" };
  },
});

async function handleUpdate(
  ctx: PluginContext,
  token: string,
  config: TelegramConfig,
  update: TelegramUpdate,
  baseUrl: string,
  publicUrl?: string,
): Promise<void> {
  if (!isTelegramUpdateAllowed(config, update)) {
    const fromId = update.message?.from?.id ?? update.callback_query?.from.id;
    const chatId = update.message?.chat.id ?? update.callback_query?.message?.chat.id;
    ctx.logger.warn("Blocked unauthorized Telegram update", {
      updateId: update.update_id,
      fromId,
      chatId,
    });
    return;
  }

  if (update.callback_query) {
    await handleCallbackQuery(ctx, token, update.callback_query, baseUrl, publicUrl);
    return;
  }

  const msg = update.message;
  if (!msg) return;

  const chatId = String(msg.chat.id);
  const threadId = msg.message_thread_id;

  // Phase 3: Handle media messages
  const hasMedia = !!(msg.voice || msg.audio || msg.video_note || msg.document || msg.photo);
  if (hasMedia) {
    const companyId = await resolveCompanyId(ctx, chatId);
    const handled = await handleMediaMessage(ctx, token, msg as Parameters<typeof handleMediaMessage>[2], {
      briefAgentId: config.briefAgentId ?? "",
      briefAgentChatIds: config.briefAgentChatIds ?? [],
      transcriptionApiKeyRef: config.transcriptionApiKeyRef ?? "",
      publicUrl,
    }, companyId);
    if (handled) return;
  }

  if (!msg.text) return;

  const text = msg.text;

  // Route thread messages to agent sessions
  if (threadId) {
    const isCommand = text.startsWith("/");
    if (!isCommand) {
      const companyId = await resolveCompanyId(ctx, chatId);
      const replyToId = msg.reply_to_message?.message_id;
      const routed = await routeMessageToAgent(ctx, token, chatId, threadId, text, replyToId, companyId);
      if (routed) return;
    }
  }

  const botCommand = msg.entities?.find((e) => e.type === "bot_command" && e.offset === 0);
  if (botCommand && config.enableCommands) {
    const fullCommand = text.slice(botCommand.offset, botCommand.offset + botCommand.length);
    const command = fullCommand.replace(/^\//, "").replace(/@.*$/, "");
    const args = text.slice(botCommand.offset + botCommand.length).trim();
    const companyId = await resolveCompanyId(ctx, chatId);

    // Phase 4: Check custom commands first
    if (command === "commands") {
      await handleCommandsCommand(ctx, token, chatId, args, threadId, companyId);
      return;
    }

    const handledCustom = await tryCustomCommand(ctx, token, chatId, command, args, threadId, companyId);
    if (handledCustom) return;

    // Built-in commands
    await handleCommand(ctx, token, chatId, command, args, threadId, baseUrl, publicUrl, companyId);
    return;
  }

  if (config.enableInbound && msg.reply_to_message?.from?.is_bot) {
    const replyToId = msg.reply_to_message.message_id;
    const mapping = await ctx.state.get({
      scopeKind: "instance",
      stateKey: `msg_${chatId}_${replyToId}`,
    }) as { entityId: string; entityType: string; companyId: string } | null;

    if (mapping && mapping.entityType === "escalation") {
      const escalationManager = new EscalationManager();
      const responderId = `telegram:${msg.from?.username ?? msg.from?.id ?? chatId}`;
      await escalationManager.respond(ctx, token, mapping.entityId, {
        escalationId: mapping.entityId,
        responderId,
        responseText: text,
        action: "reply_to_customer",
      });
      await ctx.metrics.write(METRIC_NAMES.inboundRouted, 1);
      ctx.logger.info("Routed Telegram reply to escalation", {
        escalationId: mapping.entityId,
        from: msg.from?.username,
      });
    } else if (mapping && mapping.entityType === "issue") {
      try {
        // Use the SDK (not ctx.http.fetch) because the plugin sandbox blocks
        // outbound fetches to private IPs like 127.0.0.1 for SSRF protection.
        // The SDK's createComment goes through the plugin RPC bridge instead.
        await ctx.issues.createComment(mapping.entityId, text, mapping.companyId);
        await ctx.metrics.write(METRIC_NAMES.inboundRouted, 1);
        ctx.logger.info("Routed Telegram reply to issue comment", {
          issueId: mapping.entityId,
          from: msg.from?.username,
        });
      } catch (err) {
        ctx.logger.error("Failed to route inbound message", {
          issueId: mapping.entityId,
          error: String(err),
        });
      }
    }
  }
}

async function handleCallbackQuery(
  ctx: PluginContext,
  token: string,
  query: NonNullable<TelegramUpdate["callback_query"]>,
  baseUrl: string,
  publicUrl?: string,
): Promise<void> {
  const data = query.data;
  if (!data) return;

  const actor = query.from.username ?? query.from.first_name ?? String(query.from.id);
  const chatId = query.message?.chat.id ? String(query.message.chat.id) : null;
  const messageId = query.message?.message_id;
  const apiBaseUrl = resolvePaperclipApiBaseUrl(baseUrl, publicUrl);

  if (data.startsWith("confirm_accept_") || data.startsWith("confirm_reject_")) {
    const accepting = data.startsWith("confirm_accept_");
    const interactionId = data.replace(accepting ? "confirm_accept_" : "confirm_reject_", "");
    const mapping = (await ctx.state.get({
      scopeKind: "instance",
      stateKey: `confirmation_${interactionId}`,
    })) as { issueId?: string; interactionId?: string } | null;
    const issueId = mapping?.issueId;
    if (!issueId) {
      await answerCallbackQuery(ctx, token, query.id, "Open Paperclip to decide this confirmation");
      return;
    }

    const action = accepting ? "accept" : "reject";
    ctx.logger.info("Confirmation button clicked", { interactionId, issueId, action, actor });

    try {
      await ctx.http.fetch(
        `${apiBaseUrl}/api/issues/${issueId}/interactions/${interactionId}/${action}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ decidedByUserId: `telegram:${actor}` }),
        },
      );

      await answerCallbackQuery(ctx, token, query.id, accepting ? "Accepted" : "Rejected");

      if (chatId && messageId) {
        await editMessage(
          ctx,
          token,
          chatId,
          messageId,
          accepting
            ? `${escapeMarkdownV2("✅")} *Accepted* by ${escapeMarkdownV2(actor)}`
            : `${escapeMarkdownV2("❌")} *Rejected* by ${escapeMarkdownV2(actor)}`,
          { parseMode: "MarkdownV2" },
        );
      }
    } catch (err) {
      await answerCallbackQuery(ctx, token, query.id, `Failed: ${String(err)}`);
    }
    return;
  }

  if (data.startsWith("approve_")) {
    const approvalId = data.replace("approve_", "");
    ctx.logger.info("Approval button clicked", { approvalId, actor });

    try {
      await ctx.http.fetch(
        `${apiBaseUrl}/api/approvals/${approvalId}/approve`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ decidedByUserId: `telegram:${actor}` }),
        },
      );

      await answerCallbackQuery(ctx, token, query.id, "Approved");

      if (chatId && messageId) {
        await editMessage(
          ctx,
          token,
          chatId,
          messageId,
          `${escapeMarkdownV2("\u2705")} *Approved* by ${escapeMarkdownV2(actor)}`,
          { parseMode: "MarkdownV2" },
        );
      }
    } catch (err) {
      await answerCallbackQuery(ctx, token, query.id, `Failed: ${String(err)}`);
    }
    return;
  }

  if (data.startsWith("esc_")) {
    const parts = data.split("_");
    const action = parts[1] ?? "";
    const escalationId = parts.slice(2).join("_");
    const escalationManager = new EscalationManager();
    await escalationManager.handleCallback(
      ctx,
      token,
      action,
      escalationId,
      actor,
      query.id,
      chatId,
      messageId,
    );
    await answerCallbackQuery(ctx, token, query.id, `Escalation: ${action}`);
    return;
  }

  if (data.startsWith("reject_")) {
    const approvalId = data.replace("reject_", "");
    ctx.logger.info("Rejection button clicked", { approvalId, actor });

    try {
      await ctx.http.fetch(
        `${apiBaseUrl}/api/approvals/${approvalId}/reject`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ decidedByUserId: `telegram:${actor}` }),
        },
      );

      await answerCallbackQuery(ctx, token, query.id, "Rejected");

      if (chatId && messageId) {
        await editMessage(
          ctx,
          token,
          chatId,
          messageId,
          `${escapeMarkdownV2("\u274c")} *Rejected* by ${escapeMarkdownV2(actor)}`,
          { parseMode: "MarkdownV2" },
        );
      }
    } catch (err) {
      await answerCallbackQuery(ctx, token, query.id, `Failed: ${String(err)}`);
    }
    return;
  }

  if (data.startsWith("handoff_approve_")) {
    const handoffId = data.replace("handoff_approve_", "");
    await handleHandoffApproval(ctx, token, handoffId, actor, query.id, chatId, messageId);
    await answerCallbackQuery(ctx, token, query.id, "Handoff approved");
    return;
  }

  if (data.startsWith("handoff_reject_")) {
    const handoffId = data.replace("handoff_reject_", "");
    await handleHandoffRejection(ctx, token, handoffId, actor, query.id, chatId, messageId);
    await answerCallbackQuery(ctx, token, query.id, "Handoff rejected");
    return;
  }

  await answerCallbackQuery(ctx, token, query.id, "Unknown action");
}

runWorker(plugin, import.meta.url);
