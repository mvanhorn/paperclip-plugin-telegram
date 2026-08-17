import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { handleAcpCommand } from "../src/acp-bridge.js";

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
    sendChatAction: vi.fn(),
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
    events: {
      emit: vi.fn((event: string, companyId: string, payload: unknown) => {
        emittedEvents.push({ event, companyId, payload });
      }),
      on: vi.fn(),
    },
    agents: {
      get: vi.fn().mockRejectedValue(new Error("agents.get requires a UUID, not a name")),
      list: vi.fn(agentsListImpl ?? (async () => [])),
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
    projects: { list: vi.fn().mockResolvedValue([]) },
  } as unknown as PluginContext;
}

async function spawn(ctx: PluginContext, agentName: string, chatId = "chat-1", threadId = 42, companyId = "company-1") {
  await handleAcpCommand(ctx, "token", chatId, `spawn ${agentName}`, threadId, companyId);
}

function savedSessions(chatId = "chat-1", threadId = 42) {
  return (stateStore[`sessions_${chatId}_${threadId}`] as Array<Record<string, unknown>>) ?? [];
}

beforeEach(() => {
  sentMessages = [];
  stateStore = {};
  emittedEvents = [];
});

describe("agent resolution via /acp spawn (regression: ctx.agents.get() requires a UUID, not a name)", () => {
  it("resolves the agent by exact name match and creates a native session", async () => {
    const ctx = mockCtx(async () => [{ id: "uuid-1", name: "builder", urlKey: "builder" }]);
    await spawn(ctx, "builder");

    // The bug this pins: the plugin must never call ctx.agents.get() with a bare
    // agent name — that always failed with a Postgres UUID-cast error.
    expect(ctx.agents.get).not.toHaveBeenCalled();
    expect(ctx.agents.list).toHaveBeenCalledWith({ companyId: "company-1" });
    expect(ctx.agents.sessions.create).toHaveBeenCalledWith("uuid-1", "company-1", expect.anything());

    const sessions = savedSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].transport).toBe("native");
    expect(sessions[0].agentId).toBe("uuid-1");
  });

  it("matches by urlKey when the name does not match directly", async () => {
    const ctx = mockCtx(async () => [{ id: "uuid-2", name: "The Builder", urlKey: "builder-agent" }]);
    await spawn(ctx, "builder-agent");

    const sessions = savedSessions();
    expect(sessions[0].transport).toBe("native");
    expect(sessions[0].agentId).toBe("uuid-2");
  });

  it("matches case-insensitively", async () => {
    const ctx = mockCtx(async () => [{ id: "uuid-3", name: "CEO", urlKey: "ceo" }]);
    await spawn(ctx, "ceo");

    const sessions = savedSessions();
    expect(sessions[0].transport).toBe("native");
    expect(sessions[0].agentId).toBe("uuid-3");
  });

  it("falls back to ACP transport (not a thrown error) when no agent matches the name", async () => {
    const ctx = mockCtx(async () => [{ id: "uuid-1", name: "builder", urlKey: "builder" }]);
    await spawn(ctx, "nonexistent-agent");

    const sessions = savedSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].transport).toBe("acp");
    expect(sessions[0].agentId).toBe("");
    expect(ctx.agents.sessions.create).not.toHaveBeenCalled();
    expect(emittedEvents.some((e) => e.event === "acp-spawn")).toBe(true);
  });

  it("falls back to ACP transport (not a thrown error) when ctx.agents.list() itself throws", async () => {
    const ctx = mockCtx(async () => {
      throw new Error("no invocation scope");
    });

    await expect(spawn(ctx, "builder")).resolves.toBeUndefined();
    const sessions = savedSessions();
    expect(sessions[0].transport).toBe("acp");
    expect(ctx.logger.error).toHaveBeenCalledWith(
      "Failed to resolve agent by name",
      expect.objectContaining({ agentName: "builder" }),
    );
  });

  it("prefers the agentId field over id when agentId looks like a real UUID (regression: SDK returns UUID under different field names)", async () => {
    const ctx = mockCtx(async () => [
      { id: "not-a-uuid-slug", agentId: "11111111-2222-3333-4444-555555555555", name: "builder", urlKey: "builder" },
    ]);
    await spawn(ctx, "builder");

    expect(ctx.agents.sessions.create).toHaveBeenCalledWith(
      "11111111-2222-3333-4444-555555555555",
      "company-1",
      expect.anything(),
    );
  });

  it("falls back to the id field when agentId does not look like a UUID", async () => {
    const ctx = mockCtx(async () => [
      { id: "11111111-2222-3333-4444-555555555555", agentId: "not-a-real-uuid", name: "builder", urlKey: "builder" },
    ]);
    await spawn(ctx, "builder");

    expect(ctx.agents.sessions.create).toHaveBeenCalledWith(
      "11111111-2222-3333-4444-555555555555",
      "company-1",
      expect.anything(),
    );
  });

  it("falls back to ACP transport (without losing the spawn) when native session creation throws after a successful match", async () => {
    const ctx = mockCtx(async () => [{ id: "uuid-1", name: "builder", urlKey: "builder" }]);
    (ctx.agents.sessions.create as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("session service down"));

    await spawn(ctx, "builder");

    const sessions = savedSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].transport).toBe("acp");
    expect(ctx.logger.error).toHaveBeenCalledWith(
      "Native session creation failed, falling back to ACP",
      expect.objectContaining({ agentName: "builder" }),
    );
  });
});

describe("/acp spawn - guard rails", () => {
  it("rejects spawn/cancel/close on an unlinked chat without ever touching agent resolution", async () => {
    const ctx = mockCtx();
    await handleAcpCommand(ctx, "token", "chat-1", "spawn builder", 42, undefined);

    expect(ctx.agents.list).not.toHaveBeenCalled();
    expect(sentMessages.some((m) => m.text.includes("not linked"))).toBe(true);
  });

  it("requires a thread — spawning outside a topic thread does not create a session", async () => {
    const ctx = mockCtx(async () => [{ id: "uuid-1", name: "builder", urlKey: "builder" }]);
    await handleAcpCommand(ctx, "token", "chat-1", "spawn builder", undefined, "company-1");

    expect(savedSessions()).toHaveLength(0);
    expect(ctx.agents.list).not.toHaveBeenCalled();
  });

  it("refuses to spawn a 6th agent when maxAgentsPerThread is 5", async () => {
    stateStore["sessions_chat-1_42"] = Array.from({ length: 5 }, (_, i) => ({
      sessionId: `s${i}`,
      agentId: `a${i}`,
      agentName: `agent${i}`,
      agentDisplayName: `Agent${i}`,
      transport: "acp",
      spawnedAt: "2026-01-01T00:00:00Z",
      status: "active",
      lastActivityAt: "2026-01-01T00:00:00Z",
    }));
    const ctx = mockCtx(async () => [{ id: "uuid-x", name: "one-more", urlKey: "one-more" }]);
    await spawn(ctx, "one-more");

    expect(savedSessions()).toHaveLength(5);
    expect(sentMessages.some((m) => m.text.includes("already has 5 active agents"))).toBe(true);
  });
});
