import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";

let sentMessages: Array<{ chatId: string; text: string }> = [];

vi.mock("@paperclipai/plugin-sdk", async () => {
  const actual = await vi.importActual("@paperclipai/plugin-sdk") as Record<string, unknown>;
  return {
    ...actual,
    runWorker: vi.fn(),
  };
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

import { handleUpdate } from "../src/worker.js";
import { processTelegramUpdateBatch } from "../src/polling-offset.js";

const UNLINKED_CHAT_ID = 5851857072;

function mockCtx(): PluginContext {
  return {
    http: { fetch: vi.fn().mockResolvedValue({ json: () => Promise.resolve({ ok: true }) }) },
    metrics: { write: vi.fn().mockResolvedValue(undefined) },
    state: {
      // No chat_* mapping stored anywhere — every chat is unlinked.
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
    },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    companies: { get: vi.fn().mockResolvedValue(null) },
    projects: { list: vi.fn().mockResolvedValue([]) },
    agents: { list: vi.fn().mockResolvedValue([]) },
    issues: { list: vi.fn().mockResolvedValue([]) },
  } as unknown as PluginContext;
}

const config = { enableCommands: true } as Parameters<typeof handleUpdate>[2];
const baseUrl = "http://localhost:3100";

function commandUpdate(updateId: number): Parameters<typeof handleUpdate>[3] {
  return {
    update_id: updateId,
    message: {
      message_id: 1,
      chat: { id: UNLINKED_CHAT_ID },
      from: { id: 42 },
      text: "/status",
      entities: [{ type: "bot_command", offset: 0, length: 7 }],
    },
  } as Parameters<typeof handleUpdate>[3];
}

beforeEach(() => {
  sentMessages = [];
});

describe("handleUpdate on an unlinked chat (regression: BEL-183 poller wedge)", () => {
  it("/status does not throw and answers with not-linked guidance", async () => {
    const ctx = mockCtx();

    await expect(
      handleUpdate(ctx, "token", config, commandUpdate(101), baseUrl),
    ).resolves.toBeUndefined();

    expect(sentMessages.length).toBeGreaterThan(0);
    expect(sentMessages.some((m) => m.text.includes("Make sure this chat is linked"))).toBe(true);
    // The raw chatId must never reach the API as a companyId
    expect(ctx.agents.list).not.toHaveBeenCalledWith(
      expect.objectContaining({ companyId: String(UNLINKED_CHAT_ID) }),
    );
  });

  it("media message does not throw and is skipped", async () => {
    const ctx = mockCtx();
    const update = {
      update_id: 102,
      message: {
        message_id: 2,
        chat: { id: UNLINKED_CHAT_ID },
        from: { id: 42 },
        voice: { file_id: "f1", duration: 3 },
      },
    } as Parameters<typeof handleUpdate>[3];

    await expect(handleUpdate(ctx, "token", config, update, baseUrl)).resolves.toBeUndefined();
  });

  it("thread message does not throw and is not routed", async () => {
    const ctx = mockCtx();
    const update = {
      update_id: 103,
      message: {
        message_id: 3,
        chat: { id: UNLINKED_CHAT_ID },
        from: { id: 42 },
        message_thread_id: 9,
        text: "hello agents",
      },
    } as Parameters<typeof handleUpdate>[3];

    await expect(handleUpdate(ctx, "token", config, update, baseUrl)).resolves.toBeUndefined();
  });

  it("polling offset advances past an unlinked-chat command", async () => {
    const ctx = mockCtx();
    const persisted: number[] = [];

    const lastUpdateId = await processTelegramUpdateBatch({
      updates: [commandUpdate(101)],
      lastUpdateId: 100,
      handleUpdate: (u) => handleUpdate(ctx, "token", config, u, baseUrl),
      persistOffset: async (updateId) => {
        persisted.push(updateId);
      },
      logger: ctx.logger,
    });

    expect(lastUpdateId).toBe(101);
    expect(persisted).toEqual([101]);
  });
});
