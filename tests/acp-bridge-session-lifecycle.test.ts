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
    events: { emit: vi.fn((e: string, c: string, p: unknown) => emittedEvents.push({ event: e, companyId: c, payload: p })), on: vi.fn() },
    agents: {
      get: vi.fn(),
      list: vi.fn().mockResolvedValue([]),
      sessions: { create: vi.fn(), sendMessage: vi.fn(), close: vi.fn().mockResolvedValue(undefined) },
    },
    issues: { create: vi.fn(), update: vi.fn() },
    projects: { list: vi.fn().mockResolvedValue([]) },
  } as unknown as PluginContext;
}

function session(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    sessionId: "s1",
    agentId: "a1",
    agentName: "builder",
    agentDisplayName: "Builder",
    transport: "native",
    spawnedAt: "2026-01-01T00:00:00Z",
    status: "active",
    lastActivityAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

beforeEach(() => {
  sentMessages = [];
  stateStore = {};
  emittedEvents = [];
});

describe("/acp status", () => {
  it("asks the user to run it inside a thread when there is no messageThreadId", async () => {
    const ctx = mockCtx();
    await handleAcpCommand(ctx, "token", "chat-1", "status", undefined, "company-1");
    expect(sentMessages[0].text).toContain("inside a thread");
  });

  it("reports no sessions bound to an empty thread", async () => {
    const ctx = mockCtx();
    await handleAcpCommand(ctx, "token", "chat-1", "status", 42, "company-1");
    expect(sentMessages[0].text).toContain("No agent sessions bound");
  });

  it("lists only active sessions, not closed ones", async () => {
    stateStore["sessions_chat-1_42"] = [
      session({ sessionId: "s1", agentDisplayName: "Builder", status: "active" }),
      session({ sessionId: "s2", agentDisplayName: "Tester", status: "closed" }),
    ];
    const ctx = mockCtx();
    await handleAcpCommand(ctx, "token", "chat-1", "status", 42, "company-1");
    expect(sentMessages[0].text).toContain("Builder");
    expect(sentMessages[0].text).not.toContain("Tester");
  });
});

describe("/acp cancel", () => {
  it("cancels the most recently active native session via ctx.agents.sessions.close", async () => {
    stateStore["sessions_chat-1_42"] = [
      session({ sessionId: "older", lastActivityAt: "2026-01-01T00:00:00Z" }),
      session({ sessionId: "newer", lastActivityAt: "2026-01-02T00:00:00Z" }),
    ];
    const ctx = mockCtx();
    await handleAcpCommand(ctx, "token", "chat-1", "cancel", 42, "company-1");

    expect(ctx.agents.sessions.close).toHaveBeenCalledWith("newer", "company-1");
  });

  it("emits an acp-spawn cancel event for ACP-transport sessions instead of calling sessions.close", async () => {
    stateStore["sessions_chat-1_42"] = [session({ transport: "acp" })];
    const ctx = mockCtx();
    await handleAcpCommand(ctx, "token", "chat-1", "cancel", 42, "company-1");

    expect(ctx.agents.sessions.close).not.toHaveBeenCalled();
    expect(emittedEvents.some((e) => e.event === "acp-spawn" && (e.payload as { type: string }).type === "cancel")).toBe(true);
  });

  it("still answers the user (does not throw) when native session close fails", async () => {
    stateStore["sessions_chat-1_42"] = [session()];
    const ctx = mockCtx();
    (ctx.agents.sessions.close as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("gone"));

    await expect(handleAcpCommand(ctx, "token", "chat-1", "cancel", 42, "company-1")).resolves.toBeUndefined();
    expect(ctx.logger.error).toHaveBeenCalledWith("Failed to close native session", expect.anything());
    expect(sentMessages.some((m) => m.text.includes("Cancellation requested"))).toBe(true);
  });
});

describe("/acp close", () => {
  it("closes by exact agent name match, case-insensitively", async () => {
    stateStore["sessions_chat-1_42"] = [
      session({ sessionId: "s1", agentName: "builder" }),
      session({ sessionId: "s2", agentName: "tester" }),
    ];
    const ctx = mockCtx();
    await handleAcpCommand(ctx, "token", "chat-1", "close Builder", 42, "company-1");

    expect(ctx.agents.sessions.close).toHaveBeenCalledWith("s1", "company-1");
    const sessions = stateStore["sessions_chat-1_42"] as Array<Record<string, unknown>>;
    expect(sessions.find((s) => s.sessionId === "s1")!.status).toBe("closed");
    expect(sessions.find((s) => s.sessionId === "s2")!.status).toBe("active");
  });

  it("closes by partial agent name match when no exact match exists", async () => {
    stateStore["sessions_chat-1_42"] = [session({ sessionId: "s1", agentName: "codebuilder" })];
    const ctx = mockCtx();
    await handleAcpCommand(ctx, "token", "chat-1", "close build", 42, "company-1");

    expect(ctx.agents.sessions.close).toHaveBeenCalledWith("s1", "company-1");
  });

  it("lists active agents and closes nothing when the requested name matches no one", async () => {
    stateStore["sessions_chat-1_42"] = [session({ sessionId: "s1", agentName: "builder", agentDisplayName: "Builder" })];
    const ctx = mockCtx();
    await handleAcpCommand(ctx, "token", "chat-1", "close nonexistent", 42, "company-1");

    expect(ctx.agents.sessions.close).not.toHaveBeenCalled();
    expect(sentMessages[0].text).toContain('No agent named "nonexistent" found');
    expect(sentMessages[0].text).toContain("Builder");
    const sessions = stateStore["sessions_chat-1_42"] as Array<Record<string, unknown>>;
    expect(sessions[0].status).toBe("active");
  });

  it("closes the most recently active session when no name is given", async () => {
    stateStore["sessions_chat-1_42"] = [
      session({ sessionId: "older", lastActivityAt: "2026-01-01T00:00:00Z" }),
      session({ sessionId: "newer", lastActivityAt: "2026-01-02T00:00:00Z" }),
    ];
    const ctx = mockCtx();
    await handleAcpCommand(ctx, "token", "chat-1", "close", 42, "company-1");

    expect(ctx.agents.sessions.close).toHaveBeenCalledWith("newer", "company-1");
  });
});
