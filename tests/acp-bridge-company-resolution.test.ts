import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { handleAcpOutput, routeMessageToAgent } from "../src/acp-bridge.js";
import { ACP_SPAWN_EVENT } from "../src/constants.js";

/**
 * BLA-162: the bridge used to resolve an unlinked chat's company id to the raw
 * Telegram `chatId`. Nothing threw and nothing logged, so the failure surfaced
 * only as host calls that could never succeed — and the discussion loop
 * re-resolved once per turn, spending a fake id on every remaining turn.
 *
 * The invariant these tests hold: a Telegram chat id is NEVER used as a
 * Paperclip company id, and a chat that cannot be resolved says so.
 */

let sentMessages: Array<{ chatId: string; text: string; options?: Record<string, unknown> }> = [];
let stateStore: Record<string, unknown> = {};

vi.mock("../src/telegram-api.js", async () => {
  const actual = await vi.importActual("../src/telegram-api.js") as Record<string, unknown>;
  return {
    ...actual,
    sendMessage: vi.fn(async (_ctx: unknown, _token: string, chatId: string, text: string, options?: Record<string, unknown>) => {
      sentMessages.push({ chatId, text, options });
      return 100;
    }),
    sendChatAction: vi.fn(async () => undefined),
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
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    events: { emit: vi.fn(), on: vi.fn() },
  } as unknown as PluginContext;
}

function acpSession(sessionId: string, name: string) {
  return {
    sessionId,
    agentId: `agent-${sessionId}`,
    agentName: name,
    agentDisplayName: name,
    transport: "acp",
    spawnedAt: "2026-01-01T00:00:00Z",
    status: "active",
    lastActivityAt: "2026-01-01T00:00:00Z",
  };
}

/** Two ACP sessions mid-discussion, the shape that made this bug expensive. */
function seedLoop() {
  stateStore["sessions_chat-1_42"] = [acpSession("s1", "Builder"), acpSession("s2", "Reviewer")];
  stateStore["loop_chat-1_42"] = {
    loopId: "loop-1",
    initiatorSessionId: "s1",
    targetSessionId: "s2",
    initiatorAgent: "Builder",
    targetAgent: "Reviewer",
    topic: "schema",
    maxTurns: 6,
    currentTurn: 0,
    lastOutputHash: null,
    previousOutputHash: null,
    status: "active",
    chatId: "chat-1",
    threadId: 42,
  };
}

const outputEvent = { sessionId: "s1", chatId: "chat-1", threadId: 42, text: "your turn", done: false };

/** The company id every ACP_SPAWN_EVENT was emitted with. */
function emittedCompanyIds(ctx: PluginContext): unknown[] {
  return (ctx.events.emit as unknown as { mock: { calls: unknown[][] } }).mock.calls
    .filter((c) => c[0] === ACP_SPAWN_EVENT)
    .map((c) => c[1]);
}

beforeEach(() => {
  sentMessages = [];
  stateStore = {};
});

describe("discussion loop company resolution", () => {
  it("routes the next turn with the company id the host put on the event", async () => {
    seedLoop();
    // A stale chat mapping is deliberately present and different: the envelope
    // is the host's own value and must win over anything cached in chat state.
    stateStore["chat_chat-1"] = { companyId: "stale-company" };
    const ctx = mockCtx();

    await handleAcpOutput(ctx, "token", outputEvent, "company-from-host");

    expect(emittedCompanyIds(ctx)).toEqual(["company-from-host"]);
  });

  it("falls back to the chat's linked company when the event carries none", async () => {
    seedLoop();
    stateStore["chat_chat-1"] = { companyId: "linked-company" };
    const ctx = mockCtx();

    await handleAcpOutput(ctx, "token", outputEvent);

    expect(emittedCompanyIds(ctx)).toEqual(["linked-company"]);
  });

  it("never spends the Telegram chat id as a company id", async () => {
    // The regression itself. An unlinked chat used to resolve to "chat-1",
    // which is a Telegram identifier and cannot address any company.
    seedLoop();
    const ctx = mockCtx();

    await handleAcpOutput(ctx, "token", outputEvent);

    expect(emittedCompanyIds(ctx)).not.toContain("chat-1");
  });

  it("pauses the discussion instead of continuing it with an unresolved company", async () => {
    seedLoop();
    const ctx = mockCtx();

    await handleAcpOutput(ctx, "token", outputEvent);

    expect(emittedCompanyIds(ctx)).toHaveLength(0);
    expect((stateStore["loop_chat-1_42"] as { status: string }).status).toBe("paused");
  });

  it("says why the discussion stopped rather than going quiet", async () => {
    // Silence here is indistinguishable from the agent having nothing to say.
    seedLoop();
    const ctx = mockCtx();

    await handleAcpOutput(ctx, "token", outputEvent);

    const paused = sentMessages.find((m) => m.text.includes("Paused"));
    expect(paused).toBeDefined();
    expect(paused!.text).toContain("/connect");
  });

  it("still routes normally once the chat is linked", async () => {
    // Guards against "fix" by disabling the feature: the happy path must work.
    seedLoop();
    stateStore["chat_chat-1"] = { companyId: "linked-company" };
    const ctx = mockCtx();

    await handleAcpOutput(ctx, "token", outputEvent);

    expect(emittedCompanyIds(ctx)).toEqual(["linked-company"]);
    expect((stateStore["loop_chat-1_42"] as { status: string }).status).toBe("active");
  });
});

describe("routeMessageToAgent company resolution", () => {
  beforeEach(() => {
    stateStore["sessions_chat-1_42"] = [acpSession("s1", "Builder")];
  });

  it("tells an unlinked chat to /connect instead of routing to a fake company", async () => {
    const ctx = mockCtx();

    const routed = await routeMessageToAgent(ctx, "token", "chat-1", 42, "do the thing");

    expect(emittedCompanyIds(ctx)).toHaveLength(0);
    expect(sentMessages[0]?.text).toContain("/connect");
    // Reported as handled: the message was addressed to a live session, so
    // falling through would leave the user with no reply at all.
    expect(routed).toBe(true);
  });

  it("routes with the caller's company id when one is supplied", async () => {
    const ctx = mockCtx();

    await routeMessageToAgent(ctx, "token", "chat-1", 42, "do the thing", undefined, "company-abc");

    expect(emittedCompanyIds(ctx)).toEqual(["company-abc"]);
  });
});
