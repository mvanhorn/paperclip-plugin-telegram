import { describe, it, expect, vi, beforeEach } from "vitest";
import { getSessions, routeMessageToAgent, handleHandoffToolCall } from "../src/acp-bridge.js";
import type { PluginContext } from "@paperclipai/plugin-sdk";

let sentMessages: Array<{ chatId: string; text: string; options?: Record<string, unknown> }> = [];
let stateStore: Record<string, unknown> = {};
let emittedEvents: Array<{ event: string; companyId: string; payload: unknown }> = [];

vi.mock("../src/telegram-api.js", async () => {
  const actual = await vi.importActual("../src/telegram-api.js") as Record<string, unknown>;
  return {
    ...actual,
    sendMessage: vi.fn(async (_ctx: unknown, _token: string, chatId: string, text: string, options?: Record<string, unknown>) => {
      sentMessages.push({ chatId, text, options });
      return 100;
    }),
    sendChatAction: vi.fn(),
    editMessage: vi.fn().mockResolvedValue(true),
  };
});

function mockCtx(): PluginContext {
  return {
    http: { fetch: vi.fn() },
    metrics: { write: vi.fn() },
    state: {
      get: vi.fn(async (key: { stateKey: string }) => stateStore[key.stateKey] ?? null),
      set: vi.fn(async (key: { stateKey: string }, value: unknown) => {
        stateStore[key.stateKey] = value;
      }),
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    events: {
      emit: vi.fn((event: string, companyId: string, payload: unknown) => {
        emittedEvents.push({ event, companyId, payload });
      }),
      on: vi.fn(),
    },
    agents: {
      get: vi.fn().mockResolvedValue(null),
      sessions: {
        create: vi.fn().mockResolvedValue({ sessionId: "native-session-1" }),
        sendMessage: vi.fn(),
        close: vi.fn(),
      },
    },
    issues: {
      create: vi.fn().mockResolvedValue({ id: "issue-1" }),
      update: vi.fn().mockResolvedValue({ id: "issue-1" }),
    },
    projects: {
      list: vi.fn().mockResolvedValue([]),
    },
  } as unknown as PluginContext;
}

beforeEach(() => {
  sentMessages = [];
  stateStore = {};
  emittedEvents = [];
});

describe("getSessions", () => {
  it("returns empty array when no sessions exist", async () => {
    const ctx = mockCtx();
    const sessions = await getSessions(ctx, "chat-1", 42);
    expect(sessions).toEqual([]);
  });

  it("returns stored sessions", async () => {
    const session = {
      sessionId: "s1",
      agentId: "a1",
      agentName: "builder",
      agentDisplayName: "Builder",
      transport: "acp",
      spawnedAt: "2026-01-01T00:00:00Z",
      status: "active",
      lastActivityAt: "2026-01-01T00:00:00Z",
    };
    stateStore["sessions_chat-1_42"] = [session];
    const ctx = mockCtx();
    const sessions = await getSessions(ctx, "chat-1", 42);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe("s1");
  });
});

describe("routeMessageToAgent - @mention extraction", () => {
  it("routes to agent matching @mention (exact match)", async () => {
    const ctx = mockCtx();
    stateStore["sessions_chat-1_42"] = [
      {
        sessionId: "s1",
        agentId: "a1",
        agentName: "builder",
        agentDisplayName: "Builder",
        transport: "acp",
        spawnedAt: "2026-01-01T00:00:00Z",
        status: "active",
        lastActivityAt: "2026-01-01T00:00:00Z",
      },
      {
        sessionId: "s2",
        agentId: "a2",
        agentName: "tester",
        agentDisplayName: "Tester",
        transport: "acp",
        spawnedAt: "2026-01-01T00:00:00Z",
        status: "active",
        lastActivityAt: "2026-01-01T00:00:00Z",
      },
    ];

    const result = await routeMessageToAgent(ctx, "token", "chat-1", 42, "@builder hello", undefined, "company-1");

    expect(result).toBe(true);
    // Should have emitted to builder session (s1)
    const emitted = emittedEvents.find(e => e.event === "acp-spawn");
    expect(emitted).toBeDefined();
    expect((emitted!.payload as Record<string, unknown>).sessionId).toBe("s1");
  });

  it("routes to agent matching @mention case-insensitively", async () => {
    const ctx = mockCtx();
    stateStore["sessions_chat-1_42"] = [
      {
        sessionId: "s1",
        agentId: "a1",
        agentName: "builder",
        agentDisplayName: "Builder",
        transport: "acp",
        spawnedAt: "2026-01-01T00:00:00Z",
        status: "active",
        lastActivityAt: "2026-01-01T00:00:00Z",
      },
    ];

    const result = await routeMessageToAgent(ctx, "token", "chat-1", 42, "@BUILDER help me", undefined, "company-1");
    expect(result).toBe(true);
  });

  it("routes via partial @mention match", async () => {
    const ctx = mockCtx();
    stateStore["sessions_chat-1_42"] = [
      {
        sessionId: "s1",
        agentId: "a1",
        agentName: "codebuilder",
        agentDisplayName: "Codebuilder",
        transport: "acp",
        spawnedAt: "2026-01-01T00:00:00Z",
        status: "active",
        lastActivityAt: "2026-01-01T00:00:00Z",
      },
    ];

    const result = await routeMessageToAgent(ctx, "token", "chat-1", 42, "@code do this", undefined, "company-1");
    expect(result).toBe(true);
    const emitted = emittedEvents.find(e => e.event === "acp-spawn");
    expect((emitted!.payload as Record<string, unknown>).sessionId).toBe("s1");
  });
});

describe("routeMessageToAgent - reply-to fallback", () => {
  it("routes to agent via reply-to message mapping", async () => {
    const ctx = mockCtx();
    stateStore["sessions_chat-1_42"] = [
      {
        sessionId: "s1",
        agentId: "a1",
        agentName: "builder",
        agentDisplayName: "Builder",
        transport: "acp",
        spawnedAt: "2026-01-01T00:00:00Z",
        status: "active",
        lastActivityAt: "2026-01-01T00:00:00Z",
      },
      {
        sessionId: "s2",
        agentId: "a2",
        agentName: "tester",
        agentDisplayName: "Tester",
        transport: "acp",
        spawnedAt: "2026-01-01T00:00:00Z",
        status: "active",
        lastActivityAt: "2026-01-01T00:00:00Z",
      },
    ];
    stateStore["agent_msg_chat-1_99"] = { sessionId: "s2" };

    const result = await routeMessageToAgent(ctx, "token", "chat-1", 42, "continue this", 99, "company-1");
    expect(result).toBe(true);

    const emitted = emittedEvents.find(e => e.event === "acp-spawn");
    expect((emitted!.payload as Record<string, unknown>).sessionId).toBe("s2");
  });

  it("falls back to most recently active when no mention or reply match", async () => {
    const ctx = mockCtx();
    stateStore["sessions_chat-1_42"] = [
      {
        sessionId: "s1",
        agentId: "a1",
        agentName: "builder",
        agentDisplayName: "Builder",
        transport: "acp",
        spawnedAt: "2026-01-01T00:00:00Z",
        status: "active",
        lastActivityAt: "2026-01-01T00:00:00Z",
      },
      {
        sessionId: "s2",
        agentId: "a2",
        agentName: "tester",
        agentDisplayName: "Tester",
        transport: "acp",
        spawnedAt: "2026-01-01T00:00:00Z",
        status: "active",
        lastActivityAt: "2026-01-02T00:00:00Z", // more recent
      },
    ];

    await routeMessageToAgent(ctx, "token", "chat-1", 42, "do something", undefined, "company-1");

    const emitted = emittedEvents.find(e => e.event === "acp-spawn");
    expect((emitted!.payload as Record<string, unknown>).sessionId).toBe("s2");
  });

  it("returns false when no active sessions exist", async () => {
    const ctx = mockCtx();
    const result = await routeMessageToAgent(ctx, "token", "chat-1", 42, "hello", undefined, "company-1");
    expect(result).toBe(false);
  });

  it("creates native wake-up issues in the project mapped to the Telegram topic", async () => {
    const ctx = mockCtx();
    stateStore["topic-map-chat-1"] = {
      "Setup and Tests": {
        projectId: "project-1",
        projectName: "Setup and Tests",
        topicId: "42",
      },
    };
    stateStore["sessions_chat-1_42"] = [{
      sessionId: "s1",
      agentId: "agent-1",
      agentName: "ceo",
      agentDisplayName: "CEO",
      transport: "native",
      spawnedAt: "2026-01-01T00:00:00Z",
      status: "active",
      lastActivityAt: "2026-01-01T00:00:00Z",
    }];

    const result = await routeMessageToAgent(ctx, "token", "chat-1", 42, "hello from topic", undefined, "company-1");

    expect(result).toBe(true);
    expect(ctx.issues.create).toHaveBeenCalledWith(expect.objectContaining({
      companyId: "company-1",
      projectId: "project-1",
      assigneeAgentId: "agent-1",
    }));
  });
});

describe("Session registry - max enforcement", () => {
  it("getSessions returns sessions from state key based on chatId and threadId", async () => {
    const ctx = mockCtx();
    stateStore["sessions_chat-1_10"] = [{ sessionId: "a" }];
    stateStore["sessions_chat-1_20"] = [{ sessionId: "b" }];

    const s1 = await getSessions(ctx, "chat-1", 10);
    const s2 = await getSessions(ctx, "chat-1", 20);
    expect(s1[0].sessionId).toBe("a");
    expect(s2[0].sessionId).toBe("b");
  });
});

describe("handleHandoffToolCall - approval callback data", () => {
  it("returns error when required fields are missing", async () => {
    const ctx = mockCtx();
    const result = await handleHandoffToolCall(ctx, "token", {}, "company-1", "agent-1");
    expect(result.error).toContain("Missing required fields");
  });

  it("creates pending handoff with approval buttons when requiresApproval is true", async () => {
    const ctx = mockCtx();
    stateStore["sessions_chat-1_42"] = [{
      sessionId: "s1",
      agentId: "agent-1",
      agentName: "builder",
      agentDisplayName: "Builder",
      transport: "acp",
      spawnedAt: "2026-01-01T00:00:00Z",
      status: "active",
      lastActivityAt: "2026-01-01T00:00:00Z",
    }];

    const result = await handleHandoffToolCall(ctx, "token", {
      targetAgent: "tester",
      reason: "needs testing",
      contextSummary: "code is ready",
      requiresApproval: true,
      chatId: "chat-1",
      threadId: 42,
    }, "company-1", "agent-1");

    expect(result.content).toBeDefined();
    const parsed = JSON.parse(result.content!);
    expect(parsed.status).toBe("pending_approval");

    // Should have sent message with approve/reject buttons
    const msg = sentMessages.find(m => m.text.includes("Handing off"));
    expect(msg).toBeDefined();
    const keyboard = msg!.options?.inlineKeyboard as Array<Array<{ text: string; callback_data: string }>>;
    expect(keyboard).toBeDefined();
    const approveBtn = keyboard.flat().find((b: { text: string }) => b.text === "Approve");
    const rejectBtn = keyboard.flat().find((b: { text: string }) => b.text === "Reject");
    expect(approveBtn).toBeDefined();
    expect(rejectBtn).toBeDefined();
    expect(approveBtn!.callback_data).toMatch(/^handoff_approve_/);
    expect(rejectBtn!.callback_data).toMatch(/^handoff_reject_/);
  });

  it("executes handoff immediately when requiresApproval is false", async () => {
    const ctx = mockCtx();
    stateStore["sessions_chat-1_42"] = [{
      sessionId: "s1",
      agentId: "agent-1",
      agentName: "builder",
      agentDisplayName: "Builder",
      transport: "acp",
      spawnedAt: "2026-01-01T00:00:00Z",
      status: "active",
      lastActivityAt: "2026-01-01T00:00:00Z",
    }];

    const result = await handleHandoffToolCall(ctx, "token", {
      targetAgent: "tester",
      reason: "needs testing",
      contextSummary: "code is ready",
      requiresApproval: false,
      chatId: "chat-1",
      threadId: 42,
    }, "company-1", "agent-1");

    const parsed = JSON.parse(result.content!);
    expect(parsed.status).toBe("handed_off");
  });
});
