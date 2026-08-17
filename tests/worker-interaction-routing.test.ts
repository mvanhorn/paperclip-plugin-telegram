import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";

let sentMessages: Array<{ chatId: string; text: string }> = [];
let resolveCalls: unknown[][] = [];
let finalizeCalls: unknown[][] = [];
let stateStore: Record<string, unknown> = {};

vi.mock("@paperclipai/plugin-sdk", async () => {
  const actual = await vi.importActual("@paperclipai/plugin-sdk") as Record<string, unknown>;
  return { ...actual, runWorker: vi.fn() };
});

vi.mock("../src/telegram-api.js", async () => {
  const actual = await vi.importActual("../src/telegram-api.js") as Record<string, unknown>;
  return {
    ...actual,
    sendMessage: vi.fn(async (_ctx: unknown, _token: string, chatId: string, text: string) => {
      sentMessages.push({ chatId, text });
      return 1;
    }),
    sendChatAction: vi.fn(),
  };
});

vi.mock("../src/interaction-answers.js", async () => {
  const actual = await vi.importActual("../src/interaction-answers.js") as Record<string, unknown>;
  return {
    ...actual,
    resolveInteractionAnswerCallback: vi.fn(async (...args: unknown[]) => {
      resolveCalls.push(args);
      return true;
    }),
    finalizeReplyRejection: vi.fn(async (...args: unknown[]) => {
      finalizeCalls.push(args);
    }),
  };
});

import { handleUpdate } from "../src/worker.js";

// Mirrors ctx.state's real key shape ({scopeKind, scopeId, stateKey}) closely
// enough for routing tests: keyed by scopeId+stateKey since the reply mapping
// is written company-scoped.
function mockCtx(): PluginContext {
  return {
    http: { fetch: vi.fn().mockResolvedValue({ json: () => Promise.resolve({ ok: true }) }) },
    metrics: { write: vi.fn().mockResolvedValue(undefined) },
    config: { get: vi.fn().mockResolvedValue({}) },
    state: {
      get: vi.fn(async (key: { stateKey: string; scopeId?: string }) => stateStore[`${key.scopeId ?? ""}:${key.stateKey}`] ?? null),
      set: vi.fn(async (key: { stateKey: string; scopeId?: string }, value: unknown) => {
        stateStore[`${key.scopeId ?? ""}:${key.stateKey}`] = value;
      }),
      delete: vi.fn(async (key: { stateKey: string; scopeId?: string }) => {
        delete stateStore[`${key.scopeId ?? ""}:${key.stateKey}`];
      }),
    },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    companies: { get: vi.fn().mockResolvedValue(null) },
    issues: { list: vi.fn().mockResolvedValue([]), createComment: vi.fn() },
  } as unknown as PluginContext;
}

const config = { enableCommands: true, enableInbound: true } as Parameters<typeof handleUpdate>[2];
const baseUrl = "http://localhost:3100";

beforeEach(() => {
  sentMessages = [];
  resolveCalls = [];
  finalizeCalls = [];
  stateStore = {};
});

describe("handleUpdate — interaction-answer callback routing", () => {
  it("routes an int_-prefixed callback_query to resolveInteractionAnswerCallback", async () => {
    const ctx = mockCtx();
    const update = {
      update_id: 1,
      callback_query: {
        id: "cbq-1",
        from: { id: 1, username: "alice" },
        message: { message_id: 5, chat: { id: 999 }, text: "Ship it?" },
        data: "int_abc123_accept",
      },
    } as Parameters<typeof handleUpdate>[3];

    await handleUpdate(ctx, "token", config, update, baseUrl);

    expect(resolveCalls).toHaveLength(1);
    const [, , data, callbackQueryId, , , messageId] = resolveCalls[0]!;
    expect(data).toBe("int_abc123_accept");
    expect(callbackQueryId).toBe("cbq-1");
    expect(messageId).toBe(5);
  });
});

describe("handleUpdate — reply-to-reject routing", () => {
  it("routes a reply to a confirmation prompt to finalizeReplyRejection", async () => {
    const ctx = mockCtx();
    stateStore[":chat_777"] = { companyId: "co-1" };
    stateStore["co-1:msg_777_42"] = {
      entityId: "int-1",
      entityType: "interaction_reject_reason",
      companyId: "co-1",
      issueId: "issue-1",
    };

    const update = {
      update_id: 2,
      message: {
        message_id: 43,
        chat: { id: 777 },
        from: { id: 1, username: "alice" },
        text: "not ready for prod",
        reply_to_message: { message_id: 42, from: { is_bot: true } },
      },
    } as Parameters<typeof handleUpdate>[3];

    await handleUpdate(ctx, "token", config, update, baseUrl);

    expect(finalizeCalls).toHaveLength(1);
    const [, , , , mapping, reasonText, chatId] = finalizeCalls[0]!;
    expect(mapping).toMatchObject({ entityId: "int-1", issueId: "issue-1" });
    expect(reasonText).toBe("not ready for prod");
    expect(chatId).toBe("777");
  });

  it("does not treat a reply to an unrelated bot message as a rejection reason", async () => {
    const ctx = mockCtx();
    stateStore[":chat_778"] = { companyId: "co-1" };
    stateStore["co-1:msg_778_42"] = { entityId: "issue-1", entityType: "issue", companyId: "co-1" };

    const update = {
      update_id: 3,
      message: {
        message_id: 43,
        chat: { id: 778 },
        from: { id: 1, username: "alice" },
        text: "some comment",
        reply_to_message: { message_id: 42, from: { is_bot: true } },
      },
    } as Parameters<typeof handleUpdate>[3];

    await handleUpdate(ctx, "token", config, update, baseUrl);

    expect(finalizeCalls).toHaveLength(0);
    expect(ctx.issues.createComment).toHaveBeenCalledWith("issue-1", "some comment", "co-1");
  });
});
