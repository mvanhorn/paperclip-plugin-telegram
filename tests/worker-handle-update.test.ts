import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";

let sentMessages: Array<{ chatId: string; text: string }> = [];
let editedMessages: Array<{ chatId: string; messageId: number; text: string }> = [];
let answeredCallbacks: Array<{ id: string; text?: string }> = [];
let handleCommandCalls: Array<unknown[]> = [];
let tryCustomCommandResult = false;
let routeMessageToAgentResult = false;
let routeMessageToAgentCalls: Array<unknown[]> = [];
let fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
let handoffApprovalCalls: Array<unknown[]> = [];
let handoffRejectionCalls: Array<unknown[]> = [];

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
    editMessage: vi.fn(async (_ctx: unknown, _token: string, chatId: string, messageId: number, text: string) => {
      editedMessages.push({ chatId, messageId, text });
      return true;
    }),
    answerCallbackQuery: vi.fn(async (_ctx: unknown, _token: string, id: string, text?: string) => {
      answeredCallbacks.push({ id, text });
      return true;
    }),
    sendChatAction: vi.fn(),
  };
});

vi.mock("../src/commands.js", async () => {
  const actual = await vi.importActual("../src/commands.js") as Record<string, unknown>;
  return {
    ...actual,
    handleCommand: vi.fn(async (...args: unknown[]) => {
      handleCommandCalls.push(args);
    }),
  };
});

vi.mock("../src/command-registry.js", async () => {
  const actual = await vi.importActual("../src/command-registry.js") as Record<string, unknown>;
  return {
    ...actual,
    tryCustomCommand: vi.fn(async () => tryCustomCommandResult),
    handleCommandsCommand: vi.fn(),
  };
});

vi.mock("../src/acp-bridge.js", async () => {
  const actual = await vi.importActual("../src/acp-bridge.js") as Record<string, unknown>;
  return {
    ...actual,
    routeMessageToAgent: vi.fn(async (...args: unknown[]) => {
      routeMessageToAgentCalls.push(args);
      return routeMessageToAgentResult;
    }),
    handleHandoffApproval: vi.fn(async (...args: unknown[]) => {
      handoffApprovalCalls.push(args);
    }),
    handleHandoffRejection: vi.fn(async (...args: unknown[]) => {
      handoffRejectionCalls.push(args);
    }),
    setupAcpOutputListener: vi.fn(),
  };
});

let handleMediaMessageCalls: Array<unknown[]> = [];
let handleMediaMessageResult = false;

vi.mock("../src/media-pipeline.js", async () => {
  const actual = await vi.importActual("../src/media-pipeline.js") as Record<string, unknown>;
  return {
    ...actual,
    handleMediaMessage: vi.fn(async (...args: unknown[]) => {
      handleMediaMessageCalls.push(args);
      return handleMediaMessageResult;
    }),
  };
});

let escalationRespondCalls: Array<unknown[]> = [];

vi.mock("../src/escalation.js", async () => {
  const actual = await vi.importActual("../src/escalation.js") as Record<string, unknown>;
  return {
    ...actual,
    EscalationManager: vi.fn().mockImplementation(() => ({
      respond: vi.fn(async (...args: unknown[]) => {
        escalationRespondCalls.push(args);
      }),
      handleCallback: vi.fn(),
    })),
  };
});

const originalFetch = global.fetch;

import { handleUpdate } from "../src/worker.js";

const LINKED_CHAT_ID = 111;
const COMPANY_ID = "company-1";

function mockCtx(): PluginContext {
  return {
    http: { fetch: vi.fn().mockResolvedValue({ json: () => Promise.resolve({ ok: true }) }) },
    metrics: { write: vi.fn().mockResolvedValue(undefined) },
    state: {
      get: vi.fn(async (key: { stateKey: string }) => {
        if (key.stateKey === `chat_${LINKED_CHAT_ID}`) return { companyId: COMPANY_ID };
        return null;
      }),
      set: vi.fn().mockResolvedValue(undefined),
    },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    companies: { get: vi.fn().mockResolvedValue(null) },
    projects: { list: vi.fn().mockResolvedValue([]) },
    agents: { list: vi.fn().mockResolvedValue([]) },
    issues: { list: vi.fn().mockResolvedValue([]) },
    secrets: { resolve: vi.fn().mockResolvedValue("secret") },
  } as unknown as PluginContext;
}

const config = { enableCommands: true, enableInbound: true } as Parameters<typeof handleUpdate>[2];
const baseUrl = "http://localhost:3100";

beforeEach(() => {
  sentMessages = [];
  editedMessages = [];
  answeredCallbacks = [];
  handleCommandCalls = [];
  tryCustomCommandResult = false;
  routeMessageToAgentResult = false;
  routeMessageToAgentCalls = [];
  fetchCalls = [];
  handoffApprovalCalls = [];
  handoffRejectionCalls = [];
  handleMediaMessageCalls = [];
  handleMediaMessageResult = false;
  escalationRespondCalls = [];
  global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    fetchCalls.push({ url, init });
    return { ok: true, json: async () => ({ ok: true }) } as Response;
  }) as unknown as typeof fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe("handleUpdate - command dispatch", () => {
  it("routes a bot command to handleCommand with the resolved companyId", async () => {
    const ctx = mockCtx();
    const update = {
      update_id: 1,
      message: {
        message_id: 1,
        chat: { id: LINKED_CHAT_ID },
        from: { id: 42 },
        text: "/status",
        entities: [{ type: "bot_command", offset: 0, length: 7 }],
      },
    } as Parameters<typeof handleUpdate>[3];

    await handleUpdate(ctx, "token", config, update, baseUrl);

    expect(handleCommandCalls).toHaveLength(1);
    const [, , chatIdArg, commandArg, , , , , companyIdArg] = handleCommandCalls[0] as [
      unknown, string, string, string, string, number | undefined, string, string, string,
    ];
    expect(chatIdArg).toBe(String(LINKED_CHAT_ID));
    expect(commandArg).toBe("status");
    expect(companyIdArg).toBe(COMPANY_ID);
  });

  it("gives custom commands precedence over built-in commands", async () => {
    tryCustomCommandResult = true;
    const ctx = mockCtx();
    const update = {
      update_id: 2,
      message: {
        message_id: 2,
        chat: { id: LINKED_CHAT_ID },
        from: { id: 42 },
        text: "/mycustom",
        entities: [{ type: "bot_command", offset: 0, length: 9 }],
      },
    } as Parameters<typeof handleUpdate>[3];

    await handleUpdate(ctx, "token", config, update, baseUrl);

    // handleCommand must NOT be called once a custom command has already handled it,
    // otherwise the bot would answer the same command twice.
    expect(handleCommandCalls).toHaveLength(0);
  });

  it("does not dispatch commands when enableCommands is false", async () => {
    const ctx = mockCtx();
    const disabledConfig = { ...config, enableCommands: false } as Parameters<typeof handleUpdate>[2];
    const update = {
      update_id: 3,
      message: {
        message_id: 3,
        chat: { id: LINKED_CHAT_ID },
        from: { id: 42 },
        text: "/status",
        entities: [{ type: "bot_command", offset: 0, length: 7 }],
      },
    } as Parameters<typeof handleUpdate>[3];

    await handleUpdate(ctx, "token", disabledConfig, update, baseUrl);
    expect(handleCommandCalls).toHaveLength(0);
  });
});

describe("handleUpdate - thread message routing to agents", () => {
  it("routes non-command thread text to an agent session when the chat is linked", async () => {
    routeMessageToAgentResult = true;
    const ctx = mockCtx();
    const update = {
      update_id: 4,
      message: {
        message_id: 4,
        chat: { id: LINKED_CHAT_ID },
        from: { id: 42 },
        message_thread_id: 7,
        text: "please continue",
      },
    } as Parameters<typeof handleUpdate>[3];

    await handleUpdate(ctx, "token", config, update, baseUrl);

    expect(routeMessageToAgentCalls).toHaveLength(1);
  });

  it("does not attempt agent routing for command text even inside a thread", async () => {
    const ctx = mockCtx();
    const update = {
      update_id: 5,
      message: {
        message_id: 5,
        chat: { id: LINKED_CHAT_ID },
        from: { id: 42 },
        message_thread_id: 7,
        text: "/status",
        entities: [{ type: "bot_command", offset: 0, length: 7 }],
      },
    } as Parameters<typeof handleUpdate>[3];

    await handleUpdate(ctx, "token", config, update, baseUrl);
    expect(routeMessageToAgentCalls).toHaveLength(0);
  });
});

describe("handleUpdate - callback query dispatch", () => {
  function callbackUpdate(data: string, updateId: number) {
    return {
      update_id: updateId,
      callback_query: {
        id: `cb-${updateId}`,
        from: { id: 42, username: "alice" },
        message: { message_id: 99, chat: { id: LINKED_CHAT_ID }, text: "Approval Requested" },
        data,
      },
    } as Parameters<typeof handleUpdate>[3];
  }

  it("approves via the board API and edits the message on approve_", async () => {
    const ctx = mockCtx();
    await handleUpdate(ctx, "token", config, callbackUpdate("approve_apr-1", 10), baseUrl);

    expect(fetchCalls.some((c) => c.url.includes("/api/approvals/apr-1/approve"))).toBe(true);
    expect(answeredCallbacks.some((a) => a.text === "Approved")).toBe(true);
    expect(editedMessages).toHaveLength(1);
    expect(editedMessages[0].text).toContain("Approved");
  });

  it("rejects via the board API and edits the message on reject_", async () => {
    const ctx = mockCtx();
    await handleUpdate(ctx, "token", config, callbackUpdate("reject_apr-2", 11), baseUrl);

    expect(fetchCalls.some((c) => c.url.includes("/api/approvals/apr-2/reject"))).toBe(true);
    expect(answeredCallbacks.some((a) => a.text === "Rejected")).toBe(true);
  });

  it("answers with the failure reason when the approval API call fails, rather than throwing", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => "boom" }) as unknown as typeof fetch;
    const ctx = mockCtx();

    await expect(
      handleUpdate(ctx, "token", config, callbackUpdate("approve_apr-3", 12), baseUrl),
    ).resolves.toBeUndefined();

    expect(answeredCallbacks.some((a) => a.text?.startsWith("Failed"))).toBe(true);
    // Must not have edited the message on failure — that would show a false "Approved" state.
    expect(editedMessages).toHaveLength(0);
  });

  it("dispatches handoff_approve_ to handleHandoffApproval", async () => {
    const ctx = mockCtx();
    await handleUpdate(ctx, "token", config, callbackUpdate("handoff_approve_h1", 13), baseUrl);
    expect(handoffApprovalCalls).toHaveLength(1);
    expect(answeredCallbacks.some((a) => a.text === "Handoff approved")).toBe(true);
  });

  it("dispatches handoff_reject_ to handleHandoffRejection", async () => {
    const ctx = mockCtx();
    await handleUpdate(ctx, "token", config, callbackUpdate("handoff_reject_h2", 14), baseUrl);
    expect(handoffRejectionCalls).toHaveLength(1);
    expect(answeredCallbacks.some((a) => a.text === "Handoff rejected")).toBe(true);
  });

  it("answers Unknown action for unrecognized callback data instead of hanging silently", async () => {
    const ctx = mockCtx();
    await handleUpdate(ctx, "token", config, callbackUpdate("something_bogus", 15), baseUrl);
    expect(answeredCallbacks.some((a) => a.text === "Unknown action")).toBe(true);
  });
});

describe("handleUpdate - allowlist enforcement (regression: blocked updates must not reach any handler)", () => {
  it("drops a message from a chat outside the allowlist without dispatching a command", async () => {
    const ctx = mockCtx();
    const restrictedConfig = {
      ...config,
      allowedTelegramChatIds: ["999999"],
      allowedTelegramUserIds: [],
    } as Parameters<typeof handleUpdate>[2];
    const update = {
      update_id: 20,
      message: {
        message_id: 20,
        chat: { id: LINKED_CHAT_ID },
        from: { id: 42 },
        text: "/status",
        entities: [{ type: "bot_command", offset: 0, length: 7 }],
      },
    } as Parameters<typeof handleUpdate>[3];

    await handleUpdate(ctx, "token", restrictedConfig, update, baseUrl);
    expect(handleCommandCalls).toHaveLength(0);
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      "Blocked unauthorized Telegram update",
      expect.anything(),
    );
  });
});

describe("handleUpdate - media message dispatch", () => {
  function mediaUpdate(updateId: number, chatId: number) {
    return {
      update_id: updateId,
      message: {
        message_id: updateId,
        chat: { id: chatId },
        from: { id: 42 },
        voice: { file_id: "f1", duration: 3 },
      },
    } as Parameters<typeof handleUpdate>[3];
  }

  it("dispatches to handleMediaMessage with the resolved companyId when the chat is linked", async () => {
    const ctx = mockCtx();
    await handleUpdate(ctx, "token", config, mediaUpdate(30, LINKED_CHAT_ID), baseUrl);

    expect(handleMediaMessageCalls).toHaveLength(1);
    const [, , , , companyIdArg] = handleMediaMessageCalls[0] as [unknown, unknown, unknown, unknown, string];
    expect(companyIdArg).toBe(COMPANY_ID);
  });

  it("never calls handleMediaMessage for an unlinked chat (regression: must not spend transcription budget on unknown chats)", async () => {
    const ctx = mockCtx();
    const UNLINKED = 555;
    await handleUpdate(ctx, "token", config, mediaUpdate(31, UNLINKED), baseUrl);

    expect(handleMediaMessageCalls).toHaveLength(0);
  });

  it("falls through to text handling when handleMediaMessage reports it did not handle the message", async () => {
    handleMediaMessageResult = false;
    const ctx = mockCtx();
    const update = mediaUpdate(32, LINKED_CHAT_ID);
    // no text on this message, so falling through should simply return without dispatching a command
    await handleUpdate(ctx, "token", config, update, baseUrl);
    expect(handleMediaMessageCalls).toHaveLength(1);
    expect(handleCommandCalls).toHaveLength(0);
  });
});

describe("handleUpdate - bot-reply routing (inbound)", () => {
  function replyUpdate(updateId: number, replyToId: number, text: string) {
    return {
      update_id: updateId,
      message: {
        message_id: updateId,
        chat: { id: LINKED_CHAT_ID },
        from: { id: 42, username: "alice" },
        text,
        reply_to_message: { message_id: replyToId, from: { is_bot: true } },
      },
    } as Parameters<typeof handleUpdate>[3];
  }

  it("routes a reply mapped to an escalation through EscalationManager.respond", async () => {
    const ctx = mockCtx();
    (ctx.state.get as ReturnType<typeof vi.fn>).mockImplementation(async (key: { stateKey: string }) => {
      if (key.stateKey === `chat_${LINKED_CHAT_ID}`) return { companyId: COMPANY_ID };
      if (key.stateKey === `msg_${LINKED_CHAT_ID}_500`) {
        return { entityId: "esc-1", entityType: "escalation", companyId: COMPANY_ID };
      }
      return null;
    });

    await handleUpdate(ctx, "token", config, replyUpdate(40, 500, "here's my answer"), baseUrl);

    expect(escalationRespondCalls).toHaveLength(1);
    const [, , , payload] = escalationRespondCalls[0] as [unknown, unknown, unknown, { responseText: string }];
    expect(payload.responseText).toBe("here's my answer");
  });

  it("routes a reply mapped to an issue through ctx.issues.createComment", async () => {
    const ctx = mockCtx();
    (ctx.issues as unknown as { createComment: ReturnType<typeof vi.fn> }).createComment = vi.fn().mockResolvedValue(undefined);
    (ctx.state.get as ReturnType<typeof vi.fn>).mockImplementation(async (key: { stateKey: string }) => {
      if (key.stateKey === `chat_${LINKED_CHAT_ID}`) return { companyId: COMPANY_ID };
      if (key.stateKey === `msg_${LINKED_CHAT_ID}_501`) {
        return { entityId: "issue-1", entityType: "issue", companyId: COMPANY_ID };
      }
      return null;
    });

    await handleUpdate(ctx, "token", config, replyUpdate(41, 501, "fixed in the latest commit"), baseUrl);

    expect(ctx.issues.createComment).toHaveBeenCalledWith("issue-1", "fixed in the latest commit", COMPANY_ID);
  });

  it("does nothing (no throw) when the reply target has no mapping at all", async () => {
    const ctx = mockCtx();
    await expect(
      handleUpdate(ctx, "token", config, replyUpdate(42, 999, "orphan reply"), baseUrl),
    ).resolves.toBeUndefined();
    expect(escalationRespondCalls).toHaveLength(0);
  });

  it("does not route replies when enableInbound is false", async () => {
    const ctx = mockCtx();
    (ctx.state.get as ReturnType<typeof vi.fn>).mockImplementation(async (key: { stateKey: string }) => {
      if (key.stateKey === `chat_${LINKED_CHAT_ID}`) return { companyId: COMPANY_ID };
      if (key.stateKey === `msg_${LINKED_CHAT_ID}_500`) {
        return { entityId: "esc-1", entityType: "escalation", companyId: COMPANY_ID };
      }
      return null;
    });
    const disabledInbound = { ...config, enableInbound: false } as Parameters<typeof handleUpdate>[2];

    await handleUpdate(ctx, "token", disabledInbound, replyUpdate(43, 500, "should not route"), baseUrl);
    expect(escalationRespondCalls).toHaveLength(0);
  });
});
