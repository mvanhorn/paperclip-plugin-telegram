import { describe, expect, it, vi, beforeEach } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  sendMessage,
  editMessage,
  setMyCommands,
  answerCallbackQuery,
  isForum,
} from "../src/telegram-api.js";
import { METRIC_NAMES } from "../src/constants.js";

/**
 * Every user-visible byte this plugin produces goes through sendMessage, and it
 * was entirely untested — the existing telegram-api tests only cover the two
 * pure string helpers. The transport is where a message gets silently dropped:
 * on failure it returns null and logs, so a caller sees nothing wrong.
 */

// A real backoff, kept sub-millisecond so the retry path runs for real rather
// than behind fake timers.
const TINY_RETRY_AFTER = 0.001;

type FetchCall = { url: string; init: { body: string } };

let calls: FetchCall[] = [];
let responses: unknown[] = [];

function makeCtx(): PluginContext {
  return {
    http: {
      fetch: vi.fn(async (url: string, init: { body: string }) => {
        calls.push({ url, init });
        const next = responses.shift() ?? { ok: true, result: { message_id: 1 } };
        if (next instanceof Error) throw next;
        return { json: async () => next };
      }),
    },
    metrics: { write: vi.fn(async () => {}) },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as PluginContext;
}

function bodyOf(call: FetchCall): Record<string, unknown> {
  return JSON.parse(call.init.body) as Record<string, unknown>;
}

beforeEach(() => {
  calls = [];
  responses = [];
});

describe("sendMessage", () => {
  it("posts to the bot's sendMessage endpoint and returns the message id", async () => {
    responses = [{ ok: true, result: { message_id: 4242 } }];
    const ctx = makeCtx();

    const id = await sendMessage(ctx, "tok", "chat-1", "hello");

    expect(id).toBe(4242);
    expect(calls[0].url).toBe("https://api.telegram.org/bottok/sendMessage");
    expect(bodyOf(calls[0])).toMatchObject({ chat_id: "chat-1", text: "hello" });
    expect(ctx.metrics.write).toHaveBeenCalledWith(METRIC_NAMES.sent, 1);
  });

  it("omits optional fields rather than sending nulls Telegram would reject", async () => {
    const ctx = makeCtx();
    await sendMessage(ctx, "tok", "chat-1", "hello");

    const body = bodyOf(calls[0]);
    expect(body).not.toHaveProperty("parse_mode");
    expect(body).not.toHaveProperty("message_thread_id");
    expect(body).not.toHaveProperty("reply_markup");
  });

  it("passes the thread id through, which is what keeps forum replies in-topic", async () => {
    const ctx = makeCtx();
    await sendMessage(ctx, "tok", "chat-1", "hi", { messageThreadId: 77 });

    expect(bodyOf(calls[0])).toMatchObject({ message_thread_id: 77 });
  });

  it("wraps an inline keyboard in reply_markup", async () => {
    const ctx = makeCtx();
    await sendMessage(ctx, "tok", "chat-1", "pick", {
      inlineKeyboard: [[{ text: "Yes", callback_data: "y" }]],
    });

    expect(bodyOf(calls[0]).reply_markup).toEqual({
      inline_keyboard: [[{ text: "Yes", callback_data: "y" }]],
    });
  });

  it("retries a failed MarkdownV2 send as plain text instead of dropping it", async () => {
    // This is the safety net under /decisions: a single unescaped character
    // makes Telegram reject the whole message. Without the retry the user gets
    // silence, which reads as "nothing is pending".
    responses = [
      { ok: false, description: "Bad Request: can't parse entities" },
      { ok: true, result: { message_id: 9 } },
    ];
    const ctx = makeCtx();

    const id = await sendMessage(ctx, "tok", "chat-1", "*bold* \\.", { parseMode: "MarkdownV2" });

    expect(id).toBe(9);
    expect(calls).toHaveLength(2);
    expect(bodyOf(calls[1])).not.toHaveProperty("parse_mode");
    // The retry strips the markup rather than resending characters that failed.
    expect(bodyOf(calls[1]).text).toBe("bold .");
  });

  it("records a failure metric when a plain-text send is rejected", async () => {
    responses = [{ ok: false, description: "chat not found" }];
    const ctx = makeCtx();

    expect(await sendMessage(ctx, "tok", "chat-1", "hi")).toBeNull();
    expect(ctx.metrics.write).toHaveBeenCalledWith(METRIC_NAMES.failed, 1);
    expect(ctx.logger.error).toHaveBeenCalled();
  });

  it("returns null instead of throwing when the network fails", async () => {
    // Callers are fire-and-forget; a throw here would kill the polling loop.
    responses = [new Error("ECONNREFUSED")];
    const ctx = makeCtx();

    await expect(sendMessage(ctx, "tok", "chat-1", "hi")).resolves.toBeNull();
    expect(ctx.metrics.write).toHaveBeenCalledWith(METRIC_NAMES.failed, 1);
  });

  it("retries once when Telegram rate limits, then succeeds", async () => {
    responses = [
      { ok: false, parameters: { retry_after: TINY_RETRY_AFTER } },
      { ok: true, result: { message_id: 5 } },
    ];
    const ctx = makeCtx();

    expect(await sendMessage(ctx, "tok", "chat-1", "hi")).toBe(5);
    expect(calls).toHaveLength(2);
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      "Telegram rate limited, retrying",
      expect.objectContaining({ retryAfter: TINY_RETRY_AFTER }),
    );
  });

  it("gives up after the third rate-limited attempt rather than looping", async () => {
    responses = [
      { ok: false, parameters: { retry_after: TINY_RETRY_AFTER } },
      { ok: false, parameters: { retry_after: TINY_RETRY_AFTER } },
      { ok: false, parameters: { retry_after: TINY_RETRY_AFTER }, description: "Too Many Requests" },
    ];
    const ctx = makeCtx();

    expect(await sendMessage(ctx, "tok", "chat-1", "hi")).toBeNull();
    expect(calls).toHaveLength(3);
  });

  it("treats retry_after: 0 as a plain failure, not a retry", async () => {
    // Documenting real behaviour, not endorsing it: `retry_after` is checked
    // for truthiness, so a zero-second backoff falls through to the error path.
    // Harmless in practice — Telegram does not send 0 — but a reader comparing
    // this code to the API docs would otherwise expect a retry here.
    responses = [{ ok: false, parameters: { retry_after: 0 }, description: "Too Many Requests" }];
    const ctx = makeCtx();

    expect(await sendMessage(ctx, "tok", "chat-1", "hi")).toBeNull();
    expect(calls).toHaveLength(1);
  });
});

describe("editMessage", () => {
  it("clears the keyboard by default, so a pressed button cannot be pressed twice", async () => {
    const ctx = makeCtx();
    await editMessage(ctx, "tok", "chat-1", 12, "done");

    expect(bodyOf(calls[0])).toMatchObject({
      message_id: 12,
      reply_markup: { inline_keyboard: [] },
    });
  });

  it("returns false rather than throwing when the edit fails", async () => {
    responses = [new Error("boom")];
    const ctx = makeCtx();

    await expect(editMessage(ctx, "tok", "chat-1", 12, "x")).resolves.toBe(false);
  });
});

describe("setMyCommands", () => {
  it("sends the command list that populates the / menu", async () => {
    responses = [{ ok: true }];
    const ctx = makeCtx();

    const ok = await setMyCommands(ctx, "tok", [{ command: "decisions", description: "d" }]);

    expect(ok).toBe(true);
    expect(bodyOf(calls[0])).toEqual({ commands: [{ command: "decisions", description: "d" }] });
  });

  it("reports false when Telegram rejects the list", async () => {
    responses = [{ ok: false }];
    expect(await setMyCommands(makeCtx(), "tok", [])).toBe(false);
  });
});

describe("answerCallbackQuery", () => {
  it("swallows failures — a missed spinner must not break the handler", async () => {
    responses = [new Error("gone")];
    const ctx = makeCtx();

    await expect(answerCallbackQuery(ctx, "tok", "cbq-1", "ok")).resolves.toBeUndefined();
    expect(ctx.logger.error).toHaveBeenCalled();
  });
});

describe("isForum", () => {
  it("caches per chat, so repeated sends do not re-query getChat", async () => {
    responses = [{ ok: true, result: { is_forum: true } }];
    const ctx = makeCtx();

    expect(await isForum(ctx, "tok", "chat-cache-probe")).toBe(true);
    expect(await isForum(ctx, "tok", "chat-cache-probe")).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("treats an unreachable getChat as not-a-forum rather than failing the send", async () => {
    responses = [new Error("offline")];
    expect(await isForum(makeCtx(), "tok", "chat-offline-probe")).toBe(false);
  });
});
