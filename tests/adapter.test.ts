import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";

let sendMessageCalls: Array<unknown[]> = [];
let editMessageCalls: Array<unknown[]> = [];

vi.mock("../src/telegram-api.js", async () => {
  const actual = await vi.importActual("../src/telegram-api.js") as Record<string, unknown>;
  return {
    ...actual,
    sendMessage: vi.fn(async (...args: unknown[]) => {
      sendMessageCalls.push(args);
      return 555;
    }),
    editMessage: vi.fn(async (...args: unknown[]) => {
      editMessageCalls.push(args);
      return true;
    }),
  };
});

import { TelegramAdapter } from "../src/adapter.js";

function mockCtx(): PluginContext {
  return {} as PluginContext;
}

beforeEach(() => {
  sendMessageCalls = [];
  editMessageCalls = [];
});

describe("TelegramAdapter", () => {
  it("reports the telegram platform id", () => {
    const adapter = new TelegramAdapter(mockCtx(), "token");
    expect(adapter.platformId).toBe("telegram");
  });

  it("sendText forwards thread, reply-to, and silent options and returns a MessageRef", async () => {
    const adapter = new TelegramAdapter(mockCtx(), "token");
    const ref = await adapter.sendText("chat-1", "42", "hello", { replyTo: "10", silent: true });

    expect(sendMessageCalls).toHaveLength(1);
    const [, , chatId, text, options] = sendMessageCalls[0] as [unknown, unknown, string, string, Record<string, unknown>];
    expect(chatId).toBe("chat-1");
    expect(text).toBe("hello");
    expect(options.messageThreadId).toBe(42);
    expect(options.replyToMessageId).toBe(10);
    expect(options.disableNotification).toBe(true);
    expect(ref).toEqual({ chatId: "chat-1", threadId: "42", messageId: "555" });
  });

  it("sendText omits messageThreadId when no thread is given", async () => {
    const adapter = new TelegramAdapter(mockCtx(), "token");
    await adapter.sendText("chat-1", undefined, "hello");

    const [, , , , options] = sendMessageCalls[0] as [unknown, unknown, unknown, unknown, Record<string, unknown>];
    expect(options.messageThreadId).toBeUndefined();
  });

  it("sendButtons chunks buttons two per row", async () => {
    const adapter = new TelegramAdapter(mockCtx(), "token");
    await adapter.sendButtons("chat-1", undefined, "pick one", [
      { label: "A", callbackData: "a" },
      { label: "B", callbackData: "b" },
      { label: "C", callbackData: "c" },
    ]);

    const [, , , , options] = sendMessageCalls[0] as [unknown, unknown, unknown, unknown, { inlineKeyboard: Array<Array<{ text: string }>> }];
    expect(options.inlineKeyboard).toHaveLength(2);
    expect(options.inlineKeyboard[0]).toHaveLength(2);
    expect(options.inlineKeyboard[1]).toHaveLength(1);
    expect(options.inlineKeyboard[0][0].text).toBe("A");
    expect(options.inlineKeyboard[1][0].text).toBe("C");
  });

  it("editMessage passes numeric messageId and rebuilds the keyboard from buttons", async () => {
    const adapter = new TelegramAdapter(mockCtx(), "token");
    await adapter.editMessage(
      { chatId: "chat-1", threadId: "", messageId: "999" },
      "updated text",
      [{ label: "OK", callbackData: "ok" }],
    );

    expect(editMessageCalls).toHaveLength(1);
    const [, , chatId, messageId, text, options] = editMessageCalls[0] as [
      unknown, unknown, string, number, string, { inlineKeyboard: Array<Array<{ text: string }>> },
    ];
    expect(chatId).toBe("chat-1");
    expect(messageId).toBe(999);
    expect(text).toBe("updated text");
    expect(options.inlineKeyboard[0][0].text).toBe("OK");
  });

  it("editMessage passes an undefined keyboard when no buttons are given", async () => {
    const adapter = new TelegramAdapter(mockCtx(), "token");
    await adapter.editMessage({ chatId: "chat-1", threadId: "", messageId: "999" }, "updated text");

    const [, , , , , options] = editMessageCalls[0] as [unknown, unknown, unknown, unknown, unknown, { inlineKeyboard: unknown }];
    expect(options.inlineKeyboard).toBeUndefined();
  });

  it("formatAgentLabel escapes MarkdownV2 special characters", () => {
    const adapter = new TelegramAdapter(mockCtx(), "token");
    expect(adapter.formatAgentLabel("builder-agent")).toBe("*\\[builder\\-agent\\]*");
  });

  it("formatMention escapes the user id", () => {
    const adapter = new TelegramAdapter(mockCtx(), "token");
    expect(adapter.formatMention("user.name")).toBe("@user\\.name");
  });

  it("formatCodeBlock wraps with a language fence when given", () => {
    const adapter = new TelegramAdapter(mockCtx(), "token");
    expect(adapter.formatCodeBlock("const x = 1;", "ts")).toBe("```ts\nconst x = 1;\n```");
  });

  it("formatCodeBlock wraps without a language fence when omitted", () => {
    const adapter = new TelegramAdapter(mockCtx(), "token");
    expect(adapter.formatCodeBlock("plain text")).toBe("```\nplain text\n```");
  });
});
