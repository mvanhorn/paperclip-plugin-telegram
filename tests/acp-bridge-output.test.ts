import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { handleAcpOutput } from "../src/acp-bridge.js";

let sentMessages: Array<{ chatId: string; text: string; options?: Record<string, unknown> }> = [];
let stateStore: Record<string, unknown> = {};
let nextMessageId = 100;

vi.mock("../src/telegram-api.js", async () => {
  const actual = await vi.importActual("../src/telegram-api.js") as Record<string, unknown>;
  return {
    ...actual,
    sendMessage: vi.fn(async (_ctx: unknown, _token: string, chatId: string, text: string, options?: Record<string, unknown>) => {
      sentMessages.push({ chatId, text, options });
      return nextMessageId++;
    }),
  };
});

function mockCtx(): PluginContext {
  return {
    state: {
      get: vi.fn(async (key: { stateKey: string }) => stateStore[key.stateKey] ?? null),
      set: vi.fn(async (key: { stateKey: string }, value: unknown) => {
        stateStore[key.stateKey] = value;
      }),
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    events: { emit: vi.fn(), on: vi.fn() },
  } as unknown as PluginContext;
}

function activeSession(overrides: Partial<Record<string, unknown>> = {}) {
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
  nextMessageId = 100;
});

describe("handleAcpOutput - chunking (regression: Telegram rejects messages over 4096 chars)", () => {
  it("splits output longer than the chunk limit into multiple sendMessage calls", async () => {
    stateStore["sessions_chat-1_42"] = [activeSession()];
    const ctx = mockCtx();
    const longText = "line\n".repeat(1000); // ~5000 chars, well over the 4000-char chunk budget

    await handleAcpOutput(ctx, "token", { sessionId: "s1", chatId: "chat-1", threadId: 42, text: longText, done: true });

    expect(sentMessages.length).toBeGreaterThan(1);
    // No individual chunk may exceed Telegram's hard limit
    for (const msg of sentMessages) {
      expect(msg.text.length).toBeLessThanOrEqual(4096);
    }
  });

  it("does not split output at or under the limit", async () => {
    stateStore["sessions_chat-1_42"] = [activeSession()];
    const ctx = mockCtx();
    const shortText = "all good here";

    await handleAcpOutput(ctx, "token", { sessionId: "s1", chatId: "chat-1", threadId: 42, text: shortText, done: true });

    expect(sentMessages).toHaveLength(1);
  });

  it("maps the reply-to state key to the LAST chunk's message id, not the first (regression: multi-chunk replies must route to the same agent)", async () => {
    stateStore["sessions_chat-1_42"] = [activeSession()];
    const ctx = mockCtx();
    const longText = "line\n".repeat(1000);

    await handleAcpOutput(ctx, "token", { sessionId: "s1", chatId: "chat-1", threadId: 42, text: longText, done: true });

    const lastMessageId = nextMessageId - 1;
    expect(stateStore[`agent_msg_chat-1_${lastMessageId}`]).toEqual({ sessionId: "s1" });
    // Earlier chunks must NOT have a reply-to mapping — only the final one does
    for (let id = 100; id < lastMessageId; id++) {
      expect(stateStore[`agent_msg_chat-1_${id}`]).toBeUndefined();
    }
  });
});

describe("handleAcpOutput - session bookkeeping", () => {
  it("updates lastActivityAt for the matching session", async () => {
    stateStore["sessions_chat-1_42"] = [activeSession({ lastActivityAt: "2020-01-01T00:00:00Z" })];
    const ctx = mockCtx();

    await handleAcpOutput(ctx, "token", { sessionId: "s1", chatId: "chat-1", threadId: 42, text: "hi", done: false });

    const sessions = stateStore["sessions_chat-1_42"] as Array<Record<string, unknown>>;
    expect(sessions[0].lastActivityAt).not.toBe("2020-01-01T00:00:00Z");
  });

  it("still sends output under the generic 'Agent' label when the session is unknown", async () => {
    const ctx = mockCtx();
    await handleAcpOutput(ctx, "token", { sessionId: "unknown-session", chatId: "chat-1", threadId: 42, text: "hi", done: true });

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].text).toContain("Agent");
  });
});

describe("handleAcpOutput - multi-agent output sequencing (regression: interleaved agent output must not garble the transcript)", () => {
  it("queues a second agent's output while a first agent is still mid-stream, then flushes it once the first is done", async () => {
    stateStore["sessions_chat-1_42"] = [
      activeSession({ sessionId: "s1", agentDisplayName: "Builder" }),
      activeSession({ sessionId: "s2", agentDisplayName: "Tester" }),
    ];
    const ctx = mockCtx();

    // Builder starts speaking (not done yet) — becomes the current speaker.
    await handleAcpOutput(ctx, "token", { sessionId: "s1", chatId: "chat-1", threadId: 42, text: "building...", done: false });
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].text).toContain("Builder");

    // Tester tries to speak while Builder still holds the floor — must be queued, not sent immediately.
    await handleAcpOutput(ctx, "token", { sessionId: "s2", chatId: "chat-1", threadId: 42, text: "waiting to test", done: false });
    expect(sentMessages).toHaveLength(1);

    // Builder finishes — this should flush Tester's queued output.
    await handleAcpOutput(ctx, "token", { sessionId: "s1", chatId: "chat-1", threadId: 42, text: "build complete", done: true });

    expect(sentMessages).toHaveLength(3);
    // The queued Tester output is flushed as soon as Builder yields the floor,
    // before Builder's own "done" message is sent.
    expect(sentMessages[1].text).toContain("Tester");
    expect(sentMessages[1].text).toContain("waiting to test");
    expect(sentMessages[2].text).toContain("Builder");
    expect(sentMessages[2].text).toContain("build complete");
  });

  it("does not engage sequencing when only one agent is active in the thread", async () => {
    stateStore["sessions_chat-1_42"] = [activeSession({ sessionId: "s1" })];
    const ctx = mockCtx();

    await handleAcpOutput(ctx, "token", { sessionId: "s1", chatId: "chat-1", threadId: 42, text: "solo output", done: false });

    expect(sentMessages).toHaveLength(1);
  });
});
