import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { handleHandoffApproval, handleHandoffRejection } from "../src/acp-bridge.js";

let sentMessages: Array<{ chatId: string; text: string }> = [];
let stateStore: Record<string, unknown> = {};
let emittedEvents: Array<{ event: string; companyId: string; payload: unknown }> = [];

vi.mock("../src/telegram-api.js", async () => {
  const actual = await vi.importActual("../src/telegram-api.js") as Record<string, unknown>;
  return {
    ...actual,
    sendMessage: vi.fn(async (_ctx: unknown, _token: string, chatId: string, text: string) => {
      sentMessages.push({ chatId, text });
      return 100;
    }),
  };
});

function mockCtx(agentsListImpl?: () => Promise<unknown[]>): PluginContext {
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
    events: { emit: vi.fn((e: string, c: string, p: unknown) => emittedEvents.push({ event: e, companyId: c, payload: p })), on: vi.fn() },
    agents: {
      list: vi.fn(agentsListImpl ?? (async () => [])),
      sessions: { create: vi.fn().mockResolvedValue({ sessionId: "native-2" }), close: vi.fn() },
    },
    issues: {
      create: vi.fn().mockResolvedValue({ id: "issue-1" }),
      update: vi.fn().mockResolvedValue({ id: "issue-1" }),
    },
    projects: { list: vi.fn().mockResolvedValue([]) },
  } as unknown as PluginContext;
}

function pendingHandoff(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    handoffId: "h1",
    sourceSessionId: "s1",
    sourceAgent: "Builder",
    targetAgent: "tester",
    reason: "needs testing",
    contextSummary: "code is ready",
    chatId: "chat-1",
    threadId: 42,
    companyId: "company-1",
    ...overrides,
  };
}

beforeEach(() => {
  sentMessages = [];
  stateStore = {};
  emittedEvents = [];
});

describe("handleHandoffApproval", () => {
  it("does nothing when the handoff id has no pending record (expired or already resolved)", async () => {
    const ctx = mockCtx();
    await handleHandoffApproval(ctx, "token", "missing-id", "alice", "cb-1", "chat-1", 99);
    expect(sentMessages).toHaveLength(0);
    expect(emittedEvents).toHaveLength(0);
  });

  it("routes to the existing target session when one is already active, without auto-spawning", async () => {
    stateStore["handoff_h1"] = pendingHandoff();
    stateStore["sessions_chat-1_42"] = [
      { sessionId: "s1", agentId: "a1", agentName: "builder", agentDisplayName: "Builder", transport: "native", spawnedAt: "2026-01-01T00:00:00Z", status: "active", lastActivityAt: "2026-01-01T00:00:00Z" },
      { sessionId: "s2", agentId: "a2", agentName: "tester", agentDisplayName: "Tester", transport: "native", spawnedAt: "2026-01-01T00:00:00Z", status: "active", lastActivityAt: "2026-01-01T00:00:00Z" },
    ];
    const ctx = mockCtx();

    await handleHandoffApproval(ctx, "token", "h1", "alice", "cb-1", "chat-1", 99);

    // No auto-spawn message because "tester" already has an active session
    expect(sentMessages.some((m) => m.text.includes("Auto") && m.text.includes("spawned"))).toBe(false);
    expect(ctx.issues.create).toHaveBeenCalledWith(expect.objectContaining({ assigneeAgentId: "a2" }));
    // Pending handoff record must be cleared so a duplicate button press is a no-op
    expect(stateStore["handoff_h1"]).toBeNull();
  });

  it("auto-spawns the target agent by resolved UUID (not by name) when no session exists yet", async () => {
    stateStore["handoff_h1"] = pendingHandoff();
    const ctx = mockCtx(async () => [{ id: "uuid-tester", name: "tester", urlKey: "tester" }]);

    await handleHandoffApproval(ctx, "token", "h1", "alice", "cb-1", "chat-1", 99);

    expect(ctx.agents.sessions.create).toHaveBeenCalledWith("uuid-tester", "company-1", expect.anything());
    const sessions = stateStore["sessions_chat-1_42"] as Array<Record<string, unknown>>;
    expect(sessions).toHaveLength(1);
    expect(sessions[0].transport).toBe("native");
    expect(sentMessages.some((m) => m.text.includes("Auto") && m.text.includes("spawned"))).toBe(true);
  });

  it("falls back to ACP transport when the target agent cannot be resolved by name", async () => {
    stateStore["handoff_h1"] = pendingHandoff();
    const ctx = mockCtx(async () => []);

    await handleHandoffApproval(ctx, "token", "h1", "alice", "cb-1", "chat-1", 99);

    const sessions = stateStore["sessions_chat-1_42"] as Array<Record<string, unknown>>;
    expect(sessions[0].transport).toBe("acp");
    expect(emittedEvents.some((e) => (e.payload as { type: string }).type === "spawn")).toBe(true);
  });
});

describe("handleHandoffRejection", () => {
  it("does nothing when the handoff id has no pending record", async () => {
    const ctx = mockCtx();
    await handleHandoffRejection(ctx, "token", "missing-id", "alice", "cb-1", "chat-1", 99);
    expect(sentMessages).toHaveLength(0);
  });

  it("notifies the chat and clears the pending handoff so it cannot be approved after rejection", async () => {
    stateStore["handoff_h1"] = pendingHandoff();
    const ctx = mockCtx();

    await handleHandoffRejection(ctx, "token", "h1", "alice", "cb-1", "chat-1", 99);

    expect(sentMessages[0].text).toContain("rejected");
    expect(stateStore["handoff_h1"]).toBeNull();
  });
});
