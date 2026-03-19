import type { PluginContext } from "@paperclipai/plugin-sdk";
import { sendMessage, editMessage, escapeMarkdownV2, truncateAtWord } from "./telegram-api.js";
import type { TelegramAdapter, MessageRef } from "./adapter.js";

export type EscalationReason =
  | "low_confidence"
  | "explicit_request"
  | "policy_violation"
  | "unknown_intent";

export type EscalationEvent = {
  escalationId: string;
  agentId: string;
  companyId: string;
  reason: EscalationReason;
  context: {
    conversationHistory: Array<{ role: string; text: string }>;
    agentReasoning: string;
    suggestedActions: string[];
    suggestedReply?: string;
    confidenceScore?: number;
  };
  timeout: {
    durationMs: number;
    defaultAction: "defer" | "auto_reply" | "close";
  };
  originChatId?: string;
  originThreadId?: string;
  originMessageId?: string;
};

export type EscalationResponse = {
  escalationId: string;
  responderId: string;
  responseText: string;
  action: "reply_to_customer" | "override_suggested" | "dismiss";
};

type StoredEscalation = {
  escalationId: string;
  agentId: string;
  companyId: string;
  reason: EscalationReason;
  agentReasoning: string;
  suggestedReply?: string;
  suggestedActions: string[];
  confidenceScore?: number;
  originChatId?: string;
  originThreadId?: string;
  originMessageId?: string;
  escalationChatId: string;
  escalationMessageId: string;
  status: "pending" | "resolved" | "timed_out";
  createdAt: string;
  timeoutAt: string;
  defaultAction: "defer" | "auto_reply" | "close";
};

const REASON_LABELS: Record<EscalationReason, string> = {
  low_confidence: "Low Confidence",
  explicit_request: "User Requested Human",
  policy_violation: "Policy Violation",
  unknown_intent: "Unknown Intent",
};

function esc(s: string): string {
  return escapeMarkdownV2(s);
}

export class EscalationManager {
  async create(
    ctx: PluginContext,
    token: string,
    event: EscalationEvent,
    escalationChatId: string,
  ): Promise<void> {
    const reasonLabel = REASON_LABELS[event.reason] ?? event.reason;
    const confidence = event.context.confidenceScore != null
      ? ` \\(${esc(String(Math.round(event.context.confidenceScore * 100)))}%\\)`
      : "";

    const lines: string[] = [
      `${esc("\u26a0\ufe0f")} *Escalation* \\- ${esc(reasonLabel)}${confidence}`,
      "",
      `*Agent:* ${esc(event.agentId)}`,
      `*Reason:* ${esc(event.context.agentReasoning ? truncateAtWord(event.context.agentReasoning, 500) : "No details provided")}`,
    ];

    if (event.context.suggestedActions.length > 0) {
      lines.push("");
      lines.push("*Suggested actions:*");
      for (const action of event.context.suggestedActions.slice(0, 5)) {
        lines.push(`  ${esc("-")} ${esc(action)}`);
      }
    }

    if (event.context.suggestedReply) {
      lines.push("");
      lines.push("*Suggested reply:*");
      lines.push(`${esc(">")} ${esc(truncateAtWord(event.context.suggestedReply, 300))}`);
    }

    lines.push("");
    lines.push(`ID: \`${esc(event.escalationId)}\``);

    const buttons = [];
    if (event.context.suggestedReply) {
      buttons.push([
        { text: "Send Suggested Reply", callback_data: `esc_suggested_${event.escalationId}` },
      ]);
    }
    buttons.push([
      { text: "Reply", callback_data: `esc_reply_${event.escalationId}` },
      { text: "Dismiss", callback_data: `esc_dismiss_${event.escalationId}` },
    ]);

    const messageId = await sendMessage(ctx, token, escalationChatId, lines.join("\n"), {
      parseMode: "MarkdownV2",
      inlineKeyboard: buttons,
    });

    if (!messageId) {
      ctx.logger.error("Failed to send escalation message", { escalationId: event.escalationId });
      return;
    }

    const timeoutAt = new Date(Date.now() + event.timeout.durationMs).toISOString();

    const stored: StoredEscalation = {
      escalationId: event.escalationId,
      agentId: event.agentId,
      companyId: event.companyId,
      reason: event.reason,
      agentReasoning: event.context.agentReasoning,
      suggestedReply: event.context.suggestedReply,
      suggestedActions: event.context.suggestedActions,
      confidenceScore: event.context.confidenceScore,
      originChatId: event.originChatId,
      originThreadId: event.originThreadId,
      originMessageId: event.originMessageId,
      escalationChatId,
      escalationMessageId: String(messageId),
      status: "pending",
      createdAt: new Date().toISOString(),
      timeoutAt,
      defaultAction: event.timeout.defaultAction,
    };

    await ctx.state.set(
      { scopeKind: "instance", stateKey: `escalation_${event.escalationId}` },
      stored,
    );

    // Map the escalation message back so replies can be routed
    await ctx.state.set(
      { scopeKind: "instance", stateKey: `msg_${escalationChatId}_${messageId}` },
      {
        entityId: event.escalationId,
        entityType: "escalation",
        companyId: event.companyId,
        eventType: "escalation.created",
      },
    );

    // Track pending escalation IDs for timeout checks
    const pendingIds = (await ctx.state.get({
      scopeKind: "instance",
      stateKey: "escalation_pending_ids",
    }) as string[] | null) ?? [];
    pendingIds.push(event.escalationId);
    await ctx.state.set(
      { scopeKind: "instance", stateKey: "escalation_pending_ids" },
      pendingIds,
    );

    ctx.logger.info("Escalation created", {
      escalationId: event.escalationId,
      reason: event.reason,
      timeoutAt,
    });
  }

  async handleCallback(
    ctx: PluginContext,
    token: string,
    action: string,
    escalationId: string,
    actor: string,
    callbackQueryId: string,
    chatId: string | null,
    messageId: number | undefined,
  ): Promise<void> {
    const stored = await ctx.state.get({
      scopeKind: "instance",
      stateKey: `escalation_${escalationId}`,
    }) as StoredEscalation | null;

    if (!stored || stored.status !== "pending") {
      return;
    }

    switch (action) {
      case "suggested": {
        if (!stored.suggestedReply) break;
        await this.resolve(ctx, token, stored, {
          escalationId,
          responderId: `telegram:${actor}`,
          responseText: stored.suggestedReply,
          action: "reply_to_customer",
        });
        break;
      }
      case "reply": {
        // Mark as "awaiting reply" - the next reply-to-message in the escalation chat
        // will be routed through the respond() path
        if (chatId && messageId) {
          await editMessage(
            ctx,
            token,
            chatId,
            messageId,
            `${esc("\u26a0\ufe0f")} *Escalation* \\- *Awaiting your reply*\n\n${esc("Reply to this message with your response to the customer\\.")}`,
            { parseMode: "MarkdownV2" },
          );
        }
        break;
      }
      case "dismiss": {
        await this.resolve(ctx, token, stored, {
          escalationId,
          responderId: `telegram:${actor}`,
          responseText: "",
          action: "dismiss",
        });
        break;
      }
      case "override": {
        // Same as reply - user will reply to the message
        if (chatId && messageId) {
          await editMessage(
            ctx,
            token,
            chatId,
            messageId,
            `${esc("\u26a0\ufe0f")} *Escalation* \\- *Override mode*\n\n${esc("Reply to this message with your custom response\\.")}`,
            { parseMode: "MarkdownV2" },
          );
        }
        break;
      }
    }
  }

  async respond(
    ctx: PluginContext,
    token: string,
    escalationId: string,
    response: EscalationResponse,
  ): Promise<void> {
    const stored = await ctx.state.get({
      scopeKind: "instance",
      stateKey: `escalation_${escalationId}`,
    }) as StoredEscalation | null;

    if (!stored || stored.status !== "pending") {
      ctx.logger.warn("Escalation respond called for non-pending escalation", { escalationId });
      return;
    }

    await this.resolve(ctx, token, stored, response);
  }

  private async resolve(
    ctx: PluginContext,
    token: string,
    stored: StoredEscalation,
    response: EscalationResponse,
  ): Promise<void> {
    stored.status = "resolved";
    await ctx.state.set(
      { scopeKind: "instance", stateKey: `escalation_${stored.escalationId}` },
      stored,
    );

    // Remove from pending list
    await this.removePending(ctx, stored.escalationId);

    // Update the escalation message
    const statusLabel = response.action === "dismiss" ? "Dismissed" : "Resolved";
    await editMessage(
      ctx,
      token,
      stored.escalationChatId,
      Number(stored.escalationMessageId),
      `${esc("\u2705")} *Escalation ${statusLabel}* by ${esc(response.responderId)}\n\nID: \`${esc(stored.escalationId)}\``,
      { parseMode: "MarkdownV2" },
    );

    // Emit resolution event so the agent can continue
    ctx.events.emit("escalation.resolved", {
      escalationId: stored.escalationId,
      agentId: stored.agentId,
      companyId: stored.companyId,
      responderId: response.responderId,
      responseText: response.responseText,
      action: response.action,
    });

    // If there's a response to send back to the original chat, send it
    if (response.action === "reply_to_customer" && response.responseText && stored.originChatId) {
      await sendMessage(ctx, token, stored.originChatId, esc(response.responseText), {
        parseMode: "MarkdownV2",
        messageThreadId: stored.originThreadId ? Number(stored.originThreadId) : undefined,
        replyToMessageId: stored.originMessageId ? Number(stored.originMessageId) : undefined,
      });
    }

    ctx.logger.info("Escalation resolved", {
      escalationId: stored.escalationId,
      action: response.action,
      responderId: response.responderId,
    });
  }

  async checkTimeouts(ctx: PluginContext, token: string): Promise<void> {
    const pendingIds = (await ctx.state.get({
      scopeKind: "instance",
      stateKey: "escalation_pending_ids",
    }) as string[] | null) ?? [];

    if (pendingIds.length === 0) return;

    const now = Date.now();

    for (const escalationId of pendingIds) {
      const stored = await ctx.state.get({
        scopeKind: "instance",
        stateKey: `escalation_${escalationId}`,
      }) as StoredEscalation | null;

      if (!stored || stored.status !== "pending") {
        await this.removePending(ctx, escalationId);
        continue;
      }

      const timeoutAt = new Date(stored.timeoutAt).getTime();
      if (now < timeoutAt) continue;

      ctx.logger.info("Escalation timed out", { escalationId, defaultAction: stored.defaultAction });

      stored.status = "timed_out";
      await ctx.state.set(
        { scopeKind: "instance", stateKey: `escalation_${escalationId}` },
        stored,
      );

      await this.removePending(ctx, escalationId);

      // Update escalation message
      await editMessage(
        ctx,
        token,
        stored.escalationChatId,
        Number(stored.escalationMessageId),
        `${esc("\u23f0")} *Escalation Timed Out*\n\nDefault action: ${esc(stored.defaultAction)}\nID: \`${esc(escalationId)}\``,
        { parseMode: "MarkdownV2" },
      );

      // Emit timeout event
      ctx.events.emit("escalation.timed_out", {
        escalationId,
        agentId: stored.agentId,
        companyId: stored.companyId,
        defaultAction: stored.defaultAction,
        suggestedReply: stored.suggestedReply,
      });

      // If default action is auto_reply and there's a suggested reply, send it
      if (stored.defaultAction === "auto_reply" && stored.suggestedReply && stored.originChatId) {
        await sendMessage(ctx, token, stored.originChatId, esc(stored.suggestedReply), {
          parseMode: "MarkdownV2",
          messageThreadId: stored.originThreadId ? Number(stored.originThreadId) : undefined,
          replyToMessageId: stored.originMessageId ? Number(stored.originMessageId) : undefined,
        });
      }
    }
  }

  private async removePending(ctx: PluginContext, escalationId: string): Promise<void> {
    const pendingIds = (await ctx.state.get({
      scopeKind: "instance",
      stateKey: "escalation_pending_ids",
    }) as string[] | null) ?? [];

    const updated = pendingIds.filter((id) => id !== escalationId);
    await ctx.state.set(
      { scopeKind: "instance", stateKey: "escalation_pending_ids" },
      updated,
    );
  }
}
