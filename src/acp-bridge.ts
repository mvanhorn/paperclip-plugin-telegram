import type { PluginContext, AgentSessionEvent } from "@paperclipai/plugin-sdk";
import { sendMessage, escapeMarkdownV2, sendChatAction } from "./telegram-api.js";
import {
  MAX_AGENTS_PER_THREAD,
  DEFAULT_CONVERSATION_TURNS,
  MAX_CONVERSATION_TURNS,
  ACP_SPAWN_EVENT,
  ACP_OUTPUT_EVENT,
} from "./constants.js";

// --- Types ---

export type ChatSession = {
  sessionId: string;
  agentId: string;
  agentName: string;
  agentDisplayName: string;
  transport: "native" | "acp";
  spawnedAt: string;
  status: "active" | "closed";
  lastActivityAt: string;
};

type AcpOutputEvent = {
  sessionId: string;
  chatId: string;
  threadId: number;
  text: string;
  done?: boolean;
};

type ConversationLoop = {
  loopId: string;
  initiatorSessionId: string;
  targetSessionId: string;
  initiatorAgent: string;
  targetAgent: string;
  topic: string;
  maxTurns: number;
  humanCheckpointAt?: number;
  currentTurn: number;
  lastOutputHash: string | null;
  previousOutputHash: string | null;
  status: "active" | "paused" | "completed";
  chatId: string;
  threadId: number;
};

type PendingHandoff = {
  handoffId: string;
  sourceSessionId: string;
  sourceAgent: string;
  targetAgent: string;
  reason: string;
  contextSummary: string;
  chatId: string;
  threadId: number;
  companyId: string;
};

type OutputQueueEntry = {
  sessionId: string;
  agentDisplayName: string;
  text: string;
  done: boolean;
  queuedAt: number;
};

// --- Setup: register ACP output listener ---

export function setupAcpOutputListener(
  ctx: PluginContext,
  token: string,
): void {
  ctx.events.on(ACP_OUTPUT_EVENT, async (event) => {
    const payload = event.payload as AcpOutputEvent;
    await handleAcpOutput(ctx, token, payload);
  });
}

// --- ACP command handler ---

export async function handleAcpCommand(
  ctx: PluginContext,
  token: string,
  chatId: string,
  args: string,
  messageThreadId?: number,
  companyId?: string,
): Promise<void> {
  const parts = args.trim().split(/\s+/);
  const subcommand = parts[0]?.toLowerCase() ?? "";

  switch (subcommand) {
    case "spawn":
      await handleAcpSpawn(ctx, token, chatId, parts.slice(1).join(" "), messageThreadId, companyId);
      break;
    case "status":
      await handleAcpStatus(ctx, token, chatId, messageThreadId);
      break;
    case "cancel":
      await handleAcpCancel(ctx, token, chatId, messageThreadId, companyId);
      break;
    case "close":
      await handleAcpClose(ctx, token, chatId, parts.slice(1).join(" ").trim(), messageThreadId, companyId);
      break;
    default:
      await sendMessage(
        ctx,
        token,
        chatId,
        [
          escapeMarkdownV2("\ud83d\udd0c") + " *ACP Commands*",
          "",
          `/acp spawn <agent\\-name> \\- ${escapeMarkdownV2("Start an agent session in this thread")}`,
          `/acp status \\- ${escapeMarkdownV2("Show all agent sessions in this thread")}`,
          `/acp cancel \\- ${escapeMarkdownV2("Cancel the running agent task")}`,
          `/acp close [agent\\-name] \\- ${escapeMarkdownV2("End an agent session (most recent if no name given)")}`,
        ].join("\n"),
        { parseMode: "MarkdownV2", messageThreadId },
      );
  }
}

// --- Spawn (multi-agent aware, native-first) ---

async function handleAcpSpawn(
  ctx: PluginContext,
  token: string,
  chatId: string,
  agentName: string,
  messageThreadId?: number,
  companyId?: string,
): Promise<void> {
  if (!agentName.trim()) {
    await sendMessage(ctx, token, chatId, "Usage: /acp spawn <agent-name>", {
      messageThreadId,
    });
    return;
  }

  if (!messageThreadId) {
    await sendMessage(
      ctx,
      token,
      chatId,
      "Agent sessions must be started inside a topic thread.",
      { messageThreadId },
    );
    return;
  }

  const sessions = await getSessions(ctx, chatId, messageThreadId);
  const activeSessions = sessions.filter((s) => s.status === "active");

  if (activeSessions.length >= MAX_AGENTS_PER_THREAD) {
    const listing = activeSessions.map((s) => `  - ${s.agentDisplayName} (${s.transport})`).join("\n");
    await sendMessage(
      ctx,
      token,
      chatId,
      `Thread already has ${MAX_AGENTS_PER_THREAD} active agents (max):\n${listing}`,
      { messageThreadId },
    );
    return;
  }

  await sendChatAction(ctx, token, chatId);

  const trimmedName = agentName.trim();
  const displayName = trimmedName.charAt(0).toUpperCase() + trimmedName.slice(1);
  const resolvedCompanyId = companyId ?? await resolveCompanyIdFromChat(ctx, chatId);

  // Try native session first: check if agent exists in Paperclip
  let transport: "native" | "acp" = "acp";
  let sessionId: string;
  let agentId = "";

  try {
    const agent = await ctx.agents.get(trimmedName, resolvedCompanyId);
    if (agent) {
      // Native Paperclip agent - create a session
      agentId = agent.id;
      const session = await ctx.agents.sessions.create(agentId, resolvedCompanyId, {
        reason: `Telegram thread ${chatId}/${messageThreadId}`,
      });
      sessionId = session.sessionId;
      transport = "native";
      ctx.logger.info("Created native agent session", { agentId, sessionId });
    } else {
      sessionId = `acp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    }
  } catch {
    // Agent not found in Paperclip - fall back to ACP
    sessionId = `acp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  const now = new Date().toISOString();
  const newSession: ChatSession = {
    sessionId,
    agentId,
    agentName: trimmedName,
    agentDisplayName: displayName,
    transport,
    spawnedAt: now,
    status: "active",
    lastActivityAt: now,
  };

  sessions.push(newSession);
  await saveSessions(ctx, chatId, messageThreadId, sessions);

  if (transport === "acp") {
    // Emit ACP spawn event - companyId is SECOND arg
    ctx.events.emit(ACP_SPAWN_EVENT, resolvedCompanyId, {
      type: "spawn",
      sessionId,
      agentName: trimmedName,
      chatId,
      threadId: messageThreadId,
    });
  }

  const agentCount = activeSessions.length + 1;
  const transportLabel = transport === "native" ? "Paperclip" : "ACP";
  const agentCountLine = agentCount > 1
    ? `\n${escapeMarkdownV2(`${agentCount} agents now active in this thread. Use @${trimmedName} to address directly.`)}`
    : "";

  await sendMessage(
    ctx,
    token,
    chatId,
    [
      escapeMarkdownV2("\ud83d\udd0c") + " *Agent Session Started*",
      "",
      `Agent: *${escapeMarkdownV2(displayName)}*`,
      `Transport: *${escapeMarkdownV2(transportLabel)}*`,
      `Session: \`${escapeMarkdownV2(sessionId)}\``,
      "",
      escapeMarkdownV2("Send messages in this thread to interact with the agent."),
      agentCountLine,
    ].join("\n"),
    { parseMode: "MarkdownV2", messageThreadId },
  );

  ctx.logger.info("Agent session spawned", { sessionId, agentName: trimmedName, transport, chatId, threadId: messageThreadId });
}

// --- Status ---

async function handleAcpStatus(
  ctx: PluginContext,
  token: string,
  chatId: string,
  messageThreadId?: number,
): Promise<void> {
  if (!messageThreadId) {
    await sendMessage(ctx, token, chatId, "Run /acp status inside a thread with an active session.", {
      messageThreadId,
    });
    return;
  }

  const sessions = await getSessions(ctx, chatId, messageThreadId);
  const activeSessions = sessions.filter((s) => s.status === "active");

  if (activeSessions.length === 0) {
    await sendMessage(ctx, token, chatId, "No agent sessions bound to this thread.", {
      messageThreadId,
    });
    return;
  }

  const lines = [
    escapeMarkdownV2("\ud83d\udd0c") + ` *Agent Sessions \\(${activeSessions.length}\\)*`,
    "",
  ];

  for (const session of activeSessions) {
    lines.push(
      `${escapeMarkdownV2("\ud83e\udd16")} *${escapeMarkdownV2(session.agentDisplayName)}* \\[${escapeMarkdownV2(session.transport)}\\]`,
      `  Session: \`${escapeMarkdownV2(session.sessionId)}\``,
      `  Started: ${escapeMarkdownV2(session.spawnedAt)}`,
      `  Last active: ${escapeMarkdownV2(session.lastActivityAt)}`,
      "",
    );
  }

  await sendMessage(ctx, token, chatId, lines.join("\n"), {
    parseMode: "MarkdownV2",
    messageThreadId,
  });
}

// --- Cancel ---

async function handleAcpCancel(
  ctx: PluginContext,
  token: string,
  chatId: string,
  messageThreadId?: number,
  companyId?: string,
): Promise<void> {
  if (!messageThreadId) {
    await sendMessage(ctx, token, chatId, "Run /acp cancel inside a thread with an active session.", {
      messageThreadId,
    });
    return;
  }

  const sessions = await getSessions(ctx, chatId, messageThreadId);
  const activeSessions = sessions.filter((s) => s.status === "active");

  if (activeSessions.length === 0) {
    await sendMessage(ctx, token, chatId, "No agent sessions bound to this thread.", {
      messageThreadId,
    });
    return;
  }

  // Cancel the most recently active session
  const target = activeSessions.sort(
    (a, b) => new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime(),
  )[0]!;

  const resolvedCompanyId = companyId ?? await resolveCompanyIdFromChat(ctx, chatId);

  if (target.transport === "native") {
    try {
      await ctx.agents.sessions.close(target.sessionId, resolvedCompanyId);
    } catch (err) {
      ctx.logger.error("Failed to close native session", { error: String(err) });
    }
  } else {
    ctx.events.emit(ACP_SPAWN_EVENT, resolvedCompanyId, {
      type: "cancel",
      sessionId: target.sessionId,
      chatId,
      threadId: messageThreadId,
    });
  }

  await sendMessage(
    ctx,
    token,
    chatId,
    `${escapeMarkdownV2("\u23f9")} Cancellation requested for *${escapeMarkdownV2(target.agentDisplayName)}* \\(\`${escapeMarkdownV2(target.sessionId)}\`\\)`,
    { parseMode: "MarkdownV2", messageThreadId },
  );

  ctx.logger.info("Agent cancel requested", { sessionId: target.sessionId, chatId, threadId: messageThreadId });
}

// --- Close ---

async function handleAcpClose(
  ctx: PluginContext,
  token: string,
  chatId: string,
  targetAgentName: string,
  messageThreadId?: number,
  companyId?: string,
): Promise<void> {
  if (!messageThreadId) {
    await sendMessage(ctx, token, chatId, "Run /acp close inside a thread with an active session.", {
      messageThreadId,
    });
    return;
  }

  const sessions = await getSessions(ctx, chatId, messageThreadId);
  const activeSessions = sessions.filter((s) => s.status === "active");

  if (activeSessions.length === 0) {
    await sendMessage(ctx, token, chatId, "No agent sessions bound to this thread.", {
      messageThreadId,
    });
    return;
  }

  let targetSession: ChatSession | undefined;

  if (targetAgentName) {
    const lowerTarget = targetAgentName.toLowerCase();
    targetSession = activeSessions.find((s) => s.agentName.toLowerCase() === lowerTarget);
    if (!targetSession) {
      targetSession = activeSessions.find((s) => s.agentName.toLowerCase().includes(lowerTarget));
    }
    if (!targetSession) {
      const listing = activeSessions.map((s) => `  - ${s.agentDisplayName}`).join("\n");
      await sendMessage(
        ctx,
        token,
        chatId,
        `No agent named "${targetAgentName}" found. Active agents:\n${listing}`,
        { messageThreadId },
      );
      return;
    }
  } else {
    targetSession = activeSessions.sort(
      (a, b) => new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime(),
    )[0]!;
  }

  const resolvedCompanyId = companyId ?? await resolveCompanyIdFromChat(ctx, chatId);

  // Close via the correct transport
  if (targetSession.transport === "native") {
    try {
      await ctx.agents.sessions.close(targetSession.sessionId, resolvedCompanyId);
    } catch (err) {
      ctx.logger.error("Failed to close native session", { error: String(err) });
    }
  } else {
    ctx.events.emit(ACP_SPAWN_EVENT, resolvedCompanyId, {
      type: "close",
      sessionId: targetSession.sessionId,
      chatId,
      threadId: messageThreadId,
    });
  }

  // Mark closed
  const idx = sessions.findIndex((s) => s.sessionId === targetSession!.sessionId);
  if (idx >= 0) {
    sessions[idx]!.status = "closed";
  }
  await saveSessions(ctx, chatId, messageThreadId, sessions);

  await sendMessage(
    ctx,
    token,
    chatId,
    `${escapeMarkdownV2("\ud83d\udd0c")} Session for *${escapeMarkdownV2(targetSession.agentDisplayName)}* closed\\.`,
    { parseMode: "MarkdownV2", messageThreadId },
  );

  ctx.logger.info("Agent session closed", {
    sessionId: targetSession.sessionId,
    agentName: targetSession.agentName,
    transport: targetSession.transport,
    chatId,
    threadId: messageThreadId,
  });
}

// --- Multi-agent message routing ---

export async function routeMessageToAgent(
  ctx: PluginContext,
  token: string,
  chatId: string,
  threadId: number,
  text: string,
  replyToMessageId?: number,
  companyId?: string,
): Promise<boolean> {
  const sessions = await getSessions(ctx, chatId, threadId);
  const activeSessions = sessions.filter((s) => s.status === "active");

  if (activeSessions.length === 0) return false;

  let targetSession: ChatSession | undefined;

  // 1) Check for @mention
  const mentionMatch = text.match(/@(\w+)/);
  if (mentionMatch) {
    const mentionName = mentionMatch[1]!.toLowerCase();
    targetSession = activeSessions.find(
      (s) => s.agentName.toLowerCase() === mentionName || s.agentDisplayName.toLowerCase() === mentionName,
    );
    if (!targetSession) {
      targetSession = activeSessions.find(
        (s) => s.agentName.toLowerCase().includes(mentionName) || s.agentDisplayName.toLowerCase().includes(mentionName),
      );
    }
  }

  // 2) Check reply-to for agent message mapping
  if (!targetSession && replyToMessageId) {
    const agentMapping = await ctx.state.get({
      scopeKind: "instance",
      stateKey: `agent_msg_${chatId}_${replyToMessageId}`,
    }) as { sessionId: string } | null;

    if (agentMapping) {
      targetSession = activeSessions.find((s) => s.sessionId === agentMapping.sessionId);
    }
  }

  // 3) Fallback: most recently active agent
  if (!targetSession) {
    targetSession = activeSessions.sort(
      (a, b) => new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime(),
    )[0]!;
  }

  // Update last activity
  targetSession.lastActivityAt = new Date().toISOString();
  const idx = sessions.findIndex((s) => s.sessionId === targetSession!.sessionId);
  if (idx >= 0) {
    sessions[idx] = targetSession;
  }
  await saveSessions(ctx, chatId, threadId, sessions);

  const resolvedCompanyId = companyId ?? await resolveCompanyIdFromChat(ctx, chatId);

  // Route via correct transport
  if (targetSession.transport === "native") {
    try {
      await ctx.agents.sessions.sendMessage(targetSession.sessionId, resolvedCompanyId, {
        prompt: text,
        reason: "telegram_message",
        onEvent: (event: AgentSessionEvent) => {
          if (event.eventType === "chunk" && event.message) {
            handleAcpOutput(ctx, token, {
              sessionId: targetSession!.sessionId,
              chatId,
              threadId,
              text: event.message,
              done: false,
            }).catch((err) => ctx.logger.error("Native output handler error", { error: String(err) }));
          } else if (event.eventType === "done") {
            handleAcpOutput(ctx, token, {
              sessionId: targetSession!.sessionId,
              chatId,
              threadId,
              text: event.message ?? "",
              done: true,
            }).catch((err) => ctx.logger.error("Native output handler error", { error: String(err) }));
          }
        },
      });
    } catch (err) {
      ctx.logger.error("Failed to send message to native session", { error: String(err) });
      return false;
    }
  } else {
    // ACP transport - emit event, companyId is SECOND arg
    ctx.events.emit(ACP_SPAWN_EVENT, resolvedCompanyId, {
      type: "message",
      sessionId: targetSession.sessionId,
      chatId,
      threadId,
      text,
    });
  }

  ctx.logger.info("Routed message to agent session", {
    sessionId: targetSession.sessionId,
    agentName: targetSession.agentName,
    transport: targetSession.transport,
    chatId,
    threadId,
    routingMethod: mentionMatch ? "mention" : replyToMessageId ? "reply" : "fallback",
  });
  return true;
}

// --- ACP output handler (sequenced, labeled) ---

export async function handleAcpOutput(
  ctx: PluginContext,
  token: string,
  event: AcpOutputEvent,
): Promise<void> {
  const { sessionId, chatId, threadId, text, done } = event;

  const sessions = await getSessions(ctx, chatId, threadId);
  const session = sessions.find((s) => s.sessionId === sessionId);
  const displayName = session?.agentDisplayName ?? "Agent";

  // Update last activity
  if (session) {
    session.lastActivityAt = new Date().toISOString();
    const idx = sessions.findIndex((s) => s.sessionId === sessionId);
    if (idx >= 0) {
      sessions[idx] = session;
    }
    await saveSessions(ctx, chatId, threadId, sessions);
  }

  // Output sequencing for multi-agent threads
  const activeSessions = sessions.filter((s) => s.status === "active");
  if (activeSessions.length > 1) {
    const queued = await handleOutputSequencing(ctx, token, chatId, threadId, {
      sessionId,
      agentDisplayName: displayName,
      text,
      done: done ?? false,
      queuedAt: Date.now(),
    });
    if (queued) return;
  }

  await sendLabeledOutput(ctx, token, chatId, threadId, sessionId, displayName, text, done);
  await checkConversationLoopContinuation(ctx, token, chatId, threadId, sessionId, text, done);
}

// --- Output sequencing ---

async function handleOutputSequencing(
  ctx: PluginContext,
  token: string,
  chatId: string,
  threadId: number,
  entry: OutputQueueEntry,
): Promise<boolean> {
  const speakerKey = `output_speaker_${chatId}_${threadId}`;
  const queueKey = `output_queue_${chatId}_${threadId}`;

  const currentSpeaker = await ctx.state.get({
    scopeKind: "instance",
    stateKey: speakerKey,
  }) as string | null;

  if (!currentSpeaker || currentSpeaker === entry.sessionId) {
    await ctx.state.set(
      { scopeKind: "instance", stateKey: speakerKey },
      entry.sessionId,
    );

    if (entry.done) {
      await ctx.state.set(
        { scopeKind: "instance", stateKey: speakerKey },
        null,
      );
      await flushOutputQueue(ctx, token, chatId, threadId);
    }

    return false;
  }

  // Another agent is speaking - queue
  const queue = (await ctx.state.get({
    scopeKind: "instance",
    stateKey: queueKey,
  }) as OutputQueueEntry[] | null) ?? [];

  queue.push(entry);
  await ctx.state.set(
    { scopeKind: "instance", stateKey: queueKey },
    queue,
  );

  return true;
}

async function flushOutputQueue(
  ctx: PluginContext,
  token: string,
  chatId: string,
  threadId: number,
): Promise<void> {
  const queueKey = `output_queue_${chatId}_${threadId}`;
  const speakerKey = `output_speaker_${chatId}_${threadId}`;

  const queue = (await ctx.state.get({
    scopeKind: "instance",
    stateKey: queueKey,
  }) as OutputQueueEntry[] | null) ?? [];

  if (queue.length === 0) return;

  const firstEntry = queue[0]!;
  const nextSpeaker = firstEntry.sessionId;

  await ctx.state.set(
    { scopeKind: "instance", stateKey: speakerKey },
    nextSpeaker,
  );

  const toSend: OutputQueueEntry[] = [];
  const remaining: OutputQueueEntry[] = [];

  for (const entry of queue) {
    if (entry.sessionId === nextSpeaker) {
      toSend.push(entry);
    } else {
      remaining.push(entry);
    }
  }

  await ctx.state.set(
    { scopeKind: "instance", stateKey: queueKey },
    remaining,
  );

  for (const entry of toSend) {
    await sendLabeledOutput(
      ctx, token, chatId, threadId,
      entry.sessionId, entry.agentDisplayName, entry.text, entry.done,
    );

    if (entry.done) {
      await ctx.state.set(
        { scopeKind: "instance", stateKey: speakerKey },
        null,
      );
      await flushOutputQueue(ctx, token, chatId, threadId);
      return;
    }
  }
}

// --- Send labeled output ---

async function sendLabeledOutput(
  ctx: PluginContext,
  token: string,
  chatId: string,
  threadId: number,
  sessionId: string,
  displayName: string,
  text: string,
  done?: boolean,
): Promise<void> {
  const prefix = done
    ? escapeMarkdownV2("\u2705")
    : escapeMarkdownV2("\ud83e\udd16");

  const label = `*\\[${escapeMarkdownV2(displayName)}\\]*`;
  const formatted = `${prefix} ${label} ${escapeMarkdownV2(text)}`;

  const messageId = await sendMessage(ctx, token, chatId, formatted, {
    parseMode: "MarkdownV2",
    messageThreadId: threadId,
  });

  if (messageId) {
    await ctx.state.set(
      { scopeKind: "instance", stateKey: `agent_msg_${chatId}_${messageId}` },
      { sessionId },
    );
  }
}

// --- Handoff tool handler ---

export async function handleHandoffToolCall(
  ctx: PluginContext,
  token: string,
  params: Record<string, unknown>,
  companyId: string,
  sourceAgentId: string,
): Promise<{ content?: string; error?: string }> {
  const targetAgent = String(params.targetAgent ?? "");
  const reason = String(params.reason ?? "");
  const contextSummary = String(params.contextSummary ?? "");
  const requiresApproval = params.requiresApproval !== false;
  const chatId = String(params.chatId ?? "");
  const threadId = Number(params.threadId ?? 0);

  if (!targetAgent || !chatId || !threadId) {
    return { error: "Missing required fields: targetAgent, chatId, threadId" };
  }

  const sessions = await getSessions(ctx, chatId, threadId);
  const sourceSession = sessions.find((s) => s.agentId === sourceAgentId);
  const sourceAgent = sourceSession?.agentDisplayName ?? "Agent";

  const handoffId = `handoff_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const handoffText = [
    `${escapeMarkdownV2("\ud83d\udd04")} *\\[${escapeMarkdownV2(sourceAgent)}\\]* ${escapeMarkdownV2("Handing off to")} *${escapeMarkdownV2(targetAgent)}*`,
    "",
    `${escapeMarkdownV2("Reason:")} ${escapeMarkdownV2(reason)}`,
  ].join("\n");

  if (requiresApproval) {
    await sendMessage(ctx, token, chatId, handoffText, {
      parseMode: "MarkdownV2",
      messageThreadId: threadId,
      inlineKeyboard: [
        [
          { text: "Approve", callback_data: `handoff_approve_${handoffId}` },
          { text: "Reject", callback_data: `handoff_reject_${handoffId}` },
        ],
      ],
    });

    const pending: PendingHandoff = {
      handoffId,
      sourceSessionId: sourceSession?.sessionId ?? "",
      sourceAgent,
      targetAgent,
      reason,
      contextSummary,
      chatId,
      threadId,
      companyId,
    };
    await ctx.state.set(
      { scopeKind: "instance", stateKey: `handoff_${handoffId}` },
      pending,
    );

    return { content: JSON.stringify({ status: "pending_approval", handoffId }) };
  }

  await sendMessage(ctx, token, chatId, handoffText, {
    parseMode: "MarkdownV2",
    messageThreadId: threadId,
  });

  await executeHandoff(ctx, token, chatId, threadId, targetAgent, contextSummary, sessions, companyId);
  return { content: JSON.stringify({ status: "handed_off", handoffId }) };
}

// --- Handoff callback handlers ---

export async function handleHandoffApproval(
  ctx: PluginContext,
  token: string,
  handoffId: string,
  actor: string,
  callbackQueryId: string,
  chatId: string | null,
  messageId: number | undefined,
): Promise<void> {
  const pending = await ctx.state.get({
    scopeKind: "instance",
    stateKey: `handoff_${handoffId}`,
  }) as PendingHandoff | null;

  if (!pending) return;

  const sessions = await getSessions(ctx, pending.chatId, pending.threadId);
  await executeHandoff(ctx, token, pending.chatId, pending.threadId, pending.targetAgent, pending.contextSummary, sessions, pending.companyId);

  await ctx.state.set(
    { scopeKind: "instance", stateKey: `handoff_${handoffId}` },
    null,
  );

  ctx.logger.info("Handoff approved", { handoffId, actor, targetAgent: pending.targetAgent });
}

export async function handleHandoffRejection(
  ctx: PluginContext,
  token: string,
  handoffId: string,
  actor: string,
  callbackQueryId: string,
  chatId: string | null,
  messageId: number | undefined,
): Promise<void> {
  const pending = await ctx.state.get({
    scopeKind: "instance",
    stateKey: `handoff_${handoffId}`,
  }) as PendingHandoff | null;

  if (!pending) return;

  await sendMessage(
    ctx,
    token,
    pending.chatId,
    `${escapeMarkdownV2("\u274c")} Handoff to *${escapeMarkdownV2(pending.targetAgent)}* rejected by ${escapeMarkdownV2(actor)}`,
    { parseMode: "MarkdownV2", messageThreadId: pending.threadId },
  );

  await ctx.state.set(
    { scopeKind: "instance", stateKey: `handoff_${handoffId}` },
    null,
  );

  ctx.logger.info("Handoff rejected", { handoffId, actor, targetAgent: pending.targetAgent });
}

async function executeHandoff(
  ctx: PluginContext,
  token: string,
  chatId: string,
  threadId: number,
  targetAgent: string,
  contextSummary: string,
  sessions: ChatSession[],
  companyId: string,
): Promise<void> {
  const activeSessions = sessions.filter((s) => s.status === "active");
  const lowerTarget = targetAgent.toLowerCase();
  let targetSession = activeSessions.find(
    (s) => s.agentName.toLowerCase() === lowerTarget || s.agentDisplayName.toLowerCase() === lowerTarget,
  );

  if (!targetSession) {
    // Auto-spawn the target agent using native-first approach
    let transport: "native" | "acp" = "acp";
    let sessionId: string;
    let agentId = "";

    try {
      const agent = await ctx.agents.get(targetAgent, companyId);
      if (agent) {
        agentId = agent.id;
        const session = await ctx.agents.sessions.create(agentId, companyId, {
          reason: `Handoff from Telegram thread ${chatId}/${threadId}`,
        });
        sessionId = session.sessionId;
        transport = "native";
      } else {
        sessionId = `acp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      }
    } catch {
      sessionId = `acp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    }

    const displayName = targetAgent.charAt(0).toUpperCase() + targetAgent.slice(1);
    const now = new Date().toISOString();

    targetSession = {
      sessionId,
      agentId,
      agentName: targetAgent,
      agentDisplayName: displayName,
      transport,
      spawnedAt: now,
      status: "active",
      lastActivityAt: now,
    };

    sessions.push(targetSession);
    await saveSessions(ctx, chatId, threadId, sessions);

    if (transport === "acp") {
      ctx.events.emit(ACP_SPAWN_EVENT, companyId, {
        type: "spawn",
        sessionId,
        agentName: targetAgent,
        chatId,
        threadId,
      });
    }

    await sendMessage(
      ctx,
      token,
      chatId,
      `${escapeMarkdownV2("\ud83d\udd0c")} Auto\\-spawned *${escapeMarkdownV2(displayName)}* \\[${escapeMarkdownV2(transport)}\\] for handoff`,
      { parseMode: "MarkdownV2", messageThreadId: threadId },
    );
  }

  // Send context to target agent
  if (targetSession.transport === "native") {
    try {
      await ctx.agents.sessions.sendMessage(targetSession.sessionId, companyId, {
        prompt: `[Handoff context] ${contextSummary}`,
        reason: "handoff",
      });
    } catch (err) {
      ctx.logger.error("Failed to send handoff context to native session", { error: String(err) });
    }
  } else {
    ctx.events.emit(ACP_SPAWN_EVENT, companyId, {
      type: "message",
      sessionId: targetSession.sessionId,
      chatId,
      threadId,
      text: `[Handoff context] ${contextSummary}`,
    });
  }
}

// --- Discuss tool handler ---

export async function handleDiscussToolCall(
  ctx: PluginContext,
  token: string,
  params: Record<string, unknown>,
  companyId: string,
  sourceAgentId: string,
): Promise<{ content?: string; error?: string }> {
  const targetAgent = String(params.targetAgent ?? "");
  const topic = String(params.topic ?? "");
  const initialMessage = String(params.initialMessage ?? "");
  const maxTurns = Math.min(Number(params.maxTurns ?? DEFAULT_CONVERSATION_TURNS), MAX_CONVERSATION_TURNS);
  const humanCheckpointAt = params.humanCheckpointAt != null ? Number(params.humanCheckpointAt) : undefined;
  const chatId = String(params.chatId ?? "");
  const threadId = Number(params.threadId ?? 0);

  if (!targetAgent || !initialMessage || !chatId || !threadId) {
    return { error: "Missing required fields: targetAgent, initialMessage, chatId, threadId" };
  }

  const sessions = await getSessions(ctx, chatId, threadId);
  const activeSessions = sessions.filter((s) => s.status === "active");
  const initiatorSession = sessions.find((s) => s.agentId === sourceAgentId);

  // Find or spawn target
  const lowerTarget = targetAgent.toLowerCase();
  let targetSession = activeSessions.find(
    (s) => s.agentName.toLowerCase() === lowerTarget || s.agentDisplayName.toLowerCase() === lowerTarget,
  );

  if (!targetSession) {
    let transport: "native" | "acp" = "acp";
    let sessionId: string;
    let agentId = "";

    try {
      const agent = await ctx.agents.get(targetAgent, companyId);
      if (agent) {
        agentId = agent.id;
        const session = await ctx.agents.sessions.create(agentId, companyId, {
          reason: `Discussion from Telegram thread ${chatId}/${threadId}`,
        });
        sessionId = session.sessionId;
        transport = "native";
      } else {
        sessionId = `acp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      }
    } catch {
      sessionId = `acp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    }

    const displayName = targetAgent.charAt(0).toUpperCase() + targetAgent.slice(1);
    const now = new Date().toISOString();

    targetSession = {
      sessionId,
      agentId,
      agentName: targetAgent,
      agentDisplayName: displayName,
      transport,
      spawnedAt: now,
      status: "active",
      lastActivityAt: now,
    };

    sessions.push(targetSession);
    await saveSessions(ctx, chatId, threadId, sessions);

    if (transport === "acp") {
      ctx.events.emit(ACP_SPAWN_EVENT, companyId, {
        type: "spawn",
        sessionId,
        agentName: targetAgent,
        chatId,
        threadId,
      });
    }

    await sendMessage(
      ctx,
      token,
      chatId,
      `${escapeMarkdownV2("\ud83d\udd0c")} Auto\\-spawned *${escapeMarkdownV2(displayName)}* for discussion`,
      { parseMode: "MarkdownV2", messageThreadId: threadId },
    );
  }

  const loopId = `loop_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const loop: ConversationLoop = {
    loopId,
    initiatorSessionId: initiatorSession?.sessionId ?? "",
    targetSessionId: targetSession.sessionId,
    initiatorAgent: initiatorSession?.agentDisplayName ?? "Agent",
    targetAgent: targetSession.agentDisplayName,
    topic,
    maxTurns,
    humanCheckpointAt,
    currentTurn: 0,
    lastOutputHash: null,
    previousOutputHash: null,
    status: "active",
    chatId,
    threadId,
  };

  await ctx.state.set(
    { scopeKind: "instance", stateKey: `loop_${chatId}_${threadId}` },
    loop,
  );

  await sendMessage(
    ctx,
    token,
    chatId,
    [
      `${escapeMarkdownV2("\ud83d\udcac")} *Discussion Started*`,
      "",
      `Topic: ${escapeMarkdownV2(topic)}`,
      `Between: *${escapeMarkdownV2(loop.initiatorAgent)}* and *${escapeMarkdownV2(loop.targetAgent)}*`,
      `Max turns: ${escapeMarkdownV2(String(maxTurns))}`,
      humanCheckpointAt ? `Human checkpoint at turn: ${escapeMarkdownV2(String(humanCheckpointAt))}` : "",
    ].filter(Boolean).join("\n"),
    { parseMode: "MarkdownV2", messageThreadId: threadId },
  );

  // Send initial message to target via correct transport
  if (targetSession.transport === "native") {
    try {
      await ctx.agents.sessions.sendMessage(targetSession.sessionId, companyId, {
        prompt: `[Discussion: ${topic}] ${initialMessage}`,
        reason: "discussion",
      });
    } catch (err) {
      ctx.logger.error("Failed to send discussion message to native session", { error: String(err) });
    }
  } else {
    ctx.events.emit(ACP_SPAWN_EVENT, companyId, {
      type: "message",
      sessionId: targetSession.sessionId,
      chatId,
      threadId,
      text: `[Discussion: ${topic}] ${initialMessage}`,
    });
  }

  return { content: JSON.stringify({ status: "started", loopId, maxTurns }) };
}

// --- Conversation loop continuation ---

async function checkConversationLoopContinuation(
  ctx: PluginContext,
  token: string,
  chatId: string,
  threadId: number,
  sessionId: string,
  text: string,
  done?: boolean,
): Promise<void> {
  const loop = await ctx.state.get({
    scopeKind: "instance",
    stateKey: `loop_${chatId}_${threadId}`,
  }) as ConversationLoop | null;

  if (!loop || loop.status !== "active") return;

  const isInitiator = sessionId === loop.initiatorSessionId;
  const isTarget = sessionId === loop.targetSessionId;
  if (!isInitiator && !isTarget) return;

  loop.currentTurn += 1;

  // Stale loop detection
  const outputHash = simpleHash(text);
  if (outputHash === loop.lastOutputHash && outputHash === loop.previousOutputHash) {
    loop.status = "paused";
    await ctx.state.set(
      { scopeKind: "instance", stateKey: `loop_${chatId}_${threadId}` },
      loop,
    );
    await sendMessage(
      ctx,
      token,
      chatId,
      `${escapeMarkdownV2("\u26a0\ufe0f")} *Discussion Paused* \\- Stale loop detected \\(same output repeated\\)\\. Send a message to resume\\.`,
      { parseMode: "MarkdownV2", messageThreadId: threadId },
    );
    return;
  }

  loop.previousOutputHash = loop.lastOutputHash;
  loop.lastOutputHash = outputHash;

  if (loop.currentTurn >= loop.maxTurns) {
    loop.status = "completed";
    await ctx.state.set(
      { scopeKind: "instance", stateKey: `loop_${chatId}_${threadId}` },
      loop,
    );
    await sendMessage(
      ctx,
      token,
      chatId,
      `${escapeMarkdownV2("\u2705")} *Discussion Completed* \\- Reached ${escapeMarkdownV2(String(loop.maxTurns))} turns\\.`,
      { parseMode: "MarkdownV2", messageThreadId: threadId },
    );
    return;
  }

  if (loop.humanCheckpointAt && loop.currentTurn === loop.humanCheckpointAt) {
    loop.status = "paused";
    await ctx.state.set(
      { scopeKind: "instance", stateKey: `loop_${chatId}_${threadId}` },
      loop,
    );
    await sendMessage(
      ctx,
      token,
      chatId,
      `${escapeMarkdownV2("\u270b")} *Discussion Paused* at turn ${escapeMarkdownV2(String(loop.currentTurn))} for human review\\. Send a message to resume\\.`,
      { parseMode: "MarkdownV2", messageThreadId: threadId },
    );
    return;
  }

  await ctx.state.set(
    { scopeKind: "instance", stateKey: `loop_${chatId}_${threadId}` },
    loop,
  );

  // Route to the OTHER participant (only if not done)
  if (!done) {
    const nextSessionId = isInitiator ? loop.targetSessionId : loop.initiatorSessionId;
    const sessions = await getSessions(ctx, chatId, threadId);
    const nextSession = sessions.find((s) => s.sessionId === nextSessionId);

    if (nextSession) {
      const resolvedCompanyId = await resolveCompanyIdFromChat(ctx, chatId);

      if (nextSession.transport === "native") {
        try {
          await ctx.agents.sessions.sendMessage(nextSessionId, resolvedCompanyId, {
            prompt: `[Discussion: ${loop.topic}] ${text}`,
            reason: "discussion_turn",
          });
        } catch (err) {
          ctx.logger.error("Failed to send discussion turn to native session", { error: String(err) });
        }
      } else {
        ctx.events.emit(ACP_SPAWN_EVENT, resolvedCompanyId, {
          type: "message",
          sessionId: nextSessionId,
          chatId,
          threadId,
          text: `[Discussion: ${loop.topic}] ${text}`,
        });
      }
    }
  }
}

// --- Session state helpers ---

export async function getSessions(
  ctx: PluginContext,
  chatId: string,
  threadId: number,
): Promise<ChatSession[]> {
  const sessions = await ctx.state.get({
    scopeKind: "instance",
    stateKey: `sessions_${chatId}_${threadId}`,
  }) as ChatSession[] | null;
  return sessions ?? [];
}

async function saveSessions(
  ctx: PluginContext,
  chatId: string,
  threadId: number,
  sessions: ChatSession[],
): Promise<void> {
  await ctx.state.set(
    { scopeKind: "instance", stateKey: `sessions_${chatId}_${threadId}` },
    sessions,
  );
}

async function resolveCompanyIdFromChat(ctx: PluginContext, chatId: string): Promise<string> {
  const mapping = await ctx.state.get({
    scopeKind: "instance",
    stateKey: `chat_${chatId}`,
  }) as { companyId?: string; companyName?: string } | null;
  return mapping?.companyId ?? mapping?.companyName ?? chatId;
}

function simpleHash(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return String(hash);
}
