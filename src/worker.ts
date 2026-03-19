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
} from "./telegram-api.js";
import {
  formatIssueCreated,
  formatIssueDone,
  formatApprovalCreated,
  formatAgentError,
  formatAgentRunStarted,
  formatAgentRunFinished,
} from "./formatters.js";
import { handleCommand, getTopicForProject, BOT_COMMANDS } from "./commands.js";
import { routeMessageToAcp, handleAcpOutput } from "./acp-bridge.js";
import { METRIC_NAMES } from "./constants.js";
import { TelegramAdapter } from "./adapter.js";
import { EscalationManager } from "./escalation.js";
import type { EscalationEvent, EscalationResponse } from "./escalation.js";

type TelegramConfig = {
  telegramBotTokenRef: string;
  defaultChatId: string;
  approvalsChatId: string;
  errorsChatId: string;
  paperclipBaseUrl: string;
  notifyOnIssueCreated: boolean;
  notifyOnIssueDone: boolean;
  notifyOnApprovalCreated: boolean;
  notifyOnAgentError: boolean;
  enableCommands: boolean;
  enableInbound: boolean;
  dailyDigestEnabled: boolean;
  dailyDigestTime: string;
  topicRouting: boolean;
  escalationChatId: string;
  escalationTimeoutMs: number;
  escalationDefaultAction: "defer" | "auto_reply" | "close";
  escalationHoldMessage: string;
};

type TelegramUpdate = {
  update_id: number;
  message?: {
    message_id: number;
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
  };
  callback_query?: {
    id: string;
    from: { id: number; username?: string; first_name?: string };
    message?: {
      message_id: number;
      chat: { id: number };
      text?: string;
    };
    data?: string;
  };
};

const TELEGRAM_API = "https://api.telegram.org";

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

const plugin = definePlugin({
  async setup(ctx) {
    const rawConfig = await ctx.config.get();
    ctx.logger.info("Telegram plugin config loaded");
    const config = rawConfig as unknown as TelegramConfig;
    const baseUrl = config.paperclipBaseUrl || "http://localhost:3100";

    if (!config.telegramBotTokenRef) {
      ctx.logger.warn("No telegramBotTokenRef configured, plugin disabled");
      return;
    }

    const token = await ctx.secrets.resolve(config.telegramBotTokenRef);

    // --- Register bot commands with Telegram ---
    if (config.enableCommands) {
      const registered = await setMyCommands(ctx, token, BOT_COMMANDS);
      if (registered) {
        ctx.logger.info("Bot commands registered with Telegram");
      }
    }

    // --- Long polling for inbound messages ---
    let pollingActive = true;
    let lastUpdateId = 0;

    async function pollUpdates(): Promise<void> {
      while (pollingActive) {
        try {
          const res = await ctx.http.fetch(
            `${TELEGRAM_API}/bot${token}/getUpdates?offset=${lastUpdateId + 1}&timeout=30&allowed_updates=["message","callback_query"]`,
            { method: "GET" },
          );
          const data = (await res.json()) as {
            ok: boolean;
            result?: TelegramUpdate[];
          };

          if (data.ok && data.result) {
            for (const update of data.result) {
              lastUpdateId = Math.max(lastUpdateId, update.update_id);
              await handleUpdate(ctx, token, config, update, baseUrl);
            }
          }
        } catch (err) {
          ctx.logger.error("Telegram polling error", { error: String(err) });
          await new Promise((r) => setTimeout(r, 5000));
        }
      }
    }

    // Start polling in background
    if (config.enableCommands || config.enableInbound) {
      pollUpdates().catch((err) =>
        ctx.logger.error("Polling loop crashed", { error: String(err) }),
      );
    }

    // Stop polling on plugin shutdown
    ctx.events.on("plugin.stopping", async () => {
      pollingActive = false;
    });

    // --- Event subscriptions ---

    const notify = async (
      event: PluginEvent,
      formatter: (e: PluginEvent) => { text: string; options: import("./telegram-api.js").SendMessageOptions },
      overrideChatId?: string,
    ) => {
      const chatId = await resolveChat(
        ctx,
        event.companyId,
        overrideChatId || config.defaultChatId,
      );
      if (!chatId) return;
      const msg = formatter(event);

      // Topic routing: check if event has a project mapping
      let messageThreadId: number | undefined;
      if (config.topicRouting) {
        const payload = event.payload as Record<string, unknown>;
        const projectName = payload.projectName ? String(payload.projectName) : undefined;
        messageThreadId = await getTopicForProject(ctx, chatId, projectName);
      }

      if (messageThreadId) {
        msg.options.messageThreadId = messageThreadId;
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
      }
    };

    if (config.notifyOnIssueCreated) {
      ctx.events.on("issue.created", (event: PluginEvent) =>
        notify(event, formatIssueCreated),
      );
    }

    if (config.notifyOnIssueDone) {
      ctx.events.on("issue.updated", async (event: PluginEvent) => {
        const payload = event.payload as Record<string, unknown>;
        if (payload.status !== "done") return;
        await notify(event, formatIssueDone);
      });
    }

    if (config.notifyOnApprovalCreated) {
      ctx.events.on("approval.created", (event: PluginEvent) =>
        notify(event, formatApprovalCreated, config.approvalsChatId),
      );
    }

    if (config.notifyOnAgentError) {
      ctx.events.on("agent.run.failed", (event: PluginEvent) =>
        notify(event, formatAgentError, config.errorsChatId),
      );
    }

    ctx.events.on("agent.run.started", (event: PluginEvent) =>
      notify(event, formatAgentRunStarted),
    );
    ctx.events.on("agent.run.finished", (event: PluginEvent) =>
      notify(event, formatAgentRunFinished),
    );

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

    if (config.dailyDigestEnabled) {
      ctx.jobs.register("telegram-daily-digest", async () => {
        try {
          const companies = await ctx.companies.list();
          const companyId = companies[0]?.id ?? "";
          const agents = await ctx.agents.list({ companyId });
          const activeAgents = agents.filter((a: Agent) => a.status === "active");
          const issues = await ctx.issues.list({ companyId, limit: 50 });

          const now = Date.now();
          const oneDayMs = 24 * 60 * 60 * 1000;
          const completedToday = issues.filter((i: Issue) =>
            i.status === "done" && i.completedAt && (now - new Date(i.completedAt).getTime()) < oneDayMs
          );
          const createdToday = issues.filter((i: Issue) =>
            (now - new Date(i.createdAt).getTime()) < oneDayMs
          );

          const dateStr = new Date().toISOString().split("T")[0];
          const lines = [
            escapeMarkdownV2("📊") + ` *Daily Digest \\- ${escapeMarkdownV2(dateStr!)}*`,
            "",
            `${escapeMarkdownV2("✅")} Tasks completed: *${completedToday.length}*`,
            `${escapeMarkdownV2("📋")} Tasks created: *${createdToday.length}*`,
            `${escapeMarkdownV2("🤖")} Active agents: *${activeAgents.length}*/${escapeMarkdownV2(String(agents.length))}`,
          ];

          if (activeAgents.length > 0) {
            const topAgent = activeAgents[0]!.name;
            lines.push(`${escapeMarkdownV2("⭐")} Top performer: *${escapeMarkdownV2(topAgent)}*`);
          }

          await sendMessage(ctx, token, config.defaultChatId, lines.join("\n"), {
            parseMode: "MarkdownV2",
          });
        } catch (err) {
          ctx.logger.error("Daily digest failed", { error: String(err) });
          const text = [
            escapeMarkdownV2("📊") + " *Daily Digest*",
            "",
            escapeMarkdownV2("Could not generate digest. Check plugin logs for details."),
          ].join("\n");

          await sendMessage(ctx, token, config.defaultChatId, text, {
            parseMode: "MarkdownV2",
          });
        }
      });
    }

    // --- ACP output listener ---
    ctx.events.on("acp:output", async (event: unknown) => {
      const acpEvent = event as {
        sessionId: string;
        chatId: string;
        threadId: number;
        text: string;
        done?: boolean;
      };
      await handleAcpOutput(ctx, token, acpEvent);
    });

    // --- Escalation support ---
    const adapter = new TelegramAdapter(ctx, token);
    const escalationManager = new EscalationManager();

    ctx.events.on("escalation.created", async (event: unknown) => {
      const escalationEvent = event as EscalationEvent;
      if (!config.escalationChatId) {
        ctx.logger.warn("Escalation received but no escalationChatId configured");
        return;
      }
      await escalationManager.create(ctx, token, escalationEvent, config.escalationChatId);

      // Send hold message to the originating chat if configured
      if (config.escalationHoldMessage && escalationEvent.originChatId) {
        const holdText = escapeMarkdownV2(config.escalationHoldMessage);
        await sendMessage(ctx, token, escalationEvent.originChatId, holdText, {
          parseMode: "MarkdownV2",
          messageThreadId: escalationEvent.originThreadId ? Number(escalationEvent.originThreadId) : undefined,
          replyToMessageId: escalationEvent.originMessageId ? Number(escalationEvent.originMessageId) : undefined,
        });
      }
    });

    // --- Register escalate_to_human tool ---
    ctx.tools.register("escalate_to_human", {
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
        },
        required: ["reason", "conversationSummary"],
      },
    }, async (params: Record<string, unknown>) => {
      const escalationId = crypto.randomUUID();
      const timeoutMs = config.escalationTimeoutMs || 900000;
      const defaultAction = config.escalationDefaultAction || "defer";

      await ctx.events.emit("escalation.created", {
        escalationId,
        agentId: String(params.agentId ?? "unknown-agent"),
        companyId: String(params.companyId ?? ""),
        reason: params.reason,
        context: {
          conversationHistory: [],
          agentReasoning: String(params.conversationSummary ?? ""),
          suggestedActions: (params.suggestedActions as string[]) ?? [],
          suggestedReply: params.suggestedReply ? String(params.suggestedReply) : undefined,
          confidenceScore: typeof params.confidenceScore === "number" ? params.confidenceScore : undefined,
        },
        timeout: {
          durationMs: timeoutMs,
          defaultAction,
        },
        originChatId: params.originChatId ? String(params.originChatId) : undefined,
        originThreadId: params.originThreadId ? String(params.originThreadId) : undefined,
        originMessageId: params.originMessageId ? String(params.originMessageId) : undefined,
      } satisfies EscalationEvent);

      return { content: JSON.stringify({ status: "escalated", escalationId }) };
    });

    // --- Escalation timeout checker job ---
    ctx.jobs.register("check-escalation-timeouts", async () => {
      try {
        await escalationManager.checkTimeouts(ctx, token);
      } catch (err) {
        ctx.logger.error("Escalation timeout check failed", { error: String(err) });
      }
    });

    ctx.logger.info("Telegram bot plugin started");
  },

  async onValidateConfig(config) {
    if (!config.telegramBotTokenRef || typeof config.telegramBotTokenRef !== "string") {
      return { ok: false, errors: ["telegramBotTokenRef is required"] };
    }
    if (!config.defaultChatId || typeof config.defaultChatId !== "string") {
      return { ok: false, errors: ["defaultChatId is required"] };
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
): Promise<void> {
  if (update.callback_query) {
    await handleCallbackQuery(ctx, token, update.callback_query, baseUrl);
    return;
  }

  const msg = update.message;
  if (!msg?.text) return;

  const chatId = String(msg.chat.id);
  const text = msg.text;
  const threadId = msg.message_thread_id;

  // Route thread messages to ACP if a session is bound
  if (threadId) {
    const isAcpCommand = text.startsWith("/acp");
    if (!isAcpCommand) {
      const routed = await routeMessageToAcp(ctx, chatId, threadId, text);
      if (routed) return;
    }
  }

  const botCommand = msg.entities?.find((e) => e.type === "bot_command" && e.offset === 0);
  if (botCommand && config.enableCommands) {
    const fullCommand = text.slice(botCommand.offset, botCommand.offset + botCommand.length);
    const command = fullCommand.replace(/^\//, "").replace(/@.*$/, "");
    const args = text.slice(botCommand.offset + botCommand.length).trim();
    await handleCommand(ctx, token, chatId, command, args, threadId, baseUrl);
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
        await ctx.http.fetch(
          `${baseUrl}/api/issues/${mapping.entityId}/comments`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              body: text,
              authorUserId: `telegram:${msg.from?.username ?? msg.from?.id ?? chatId}`,
            }),
          },
        );
        await ctx.metrics.write(METRIC_NAMES.inboundRouted, 1);
        ctx.logger.info("Routed Telegram reply to issue comment", {
          issueId: mapping.entityId,
          from: msg.from?.username,
        });
      } catch (err) {
        ctx.logger.error("Failed to route inbound message", { error: String(err) });
      }
    }
  }
}

async function handleCallbackQuery(
  ctx: PluginContext,
  token: string,
  query: NonNullable<TelegramUpdate["callback_query"]>,
  baseUrl: string,
): Promise<void> {
  const data = query.data;
  if (!data) return;

  const actor = query.from.username ?? query.from.first_name ?? String(query.from.id);
  const chatId = query.message?.chat.id ? String(query.message.chat.id) : null;
  const messageId = query.message?.message_id;

  if (data.startsWith("approve_")) {
    const approvalId = data.replace("approve_", "");
    ctx.logger.info("Approval button clicked", { approvalId, actor });

    try {
      await ctx.http.fetch(
        `${baseUrl}/api/approvals/${approvalId}/approve`,
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
          `${escapeMarkdownV2("✅")} *Approved* by ${escapeMarkdownV2(actor)}`,
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
    // Format: esc_{action}_{escalationId}
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
        `${baseUrl}/api/approvals/${approvalId}/reject`,
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
          `${escapeMarkdownV2("❌")} *Rejected* by ${escapeMarkdownV2(actor)}`,
          { parseMode: "MarkdownV2" },
        );
      }
    } catch (err) {
      await answerCallbackQuery(ctx, token, query.id, `Failed: ${String(err)}`);
    }
    return;
  }

  await answerCallbackQuery(ctx, token, query.id, "Unknown action");
}

runWorker(plugin, import.meta.url);
