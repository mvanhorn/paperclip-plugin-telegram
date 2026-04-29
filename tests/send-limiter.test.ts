import { describe, it, expect, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { sendMessage } from "../src/telegram-api.js";

function makeMockCtx() {
  const store = new Map<string, unknown>();
  const fetchMock = vi.fn(async () =>
    new Response(JSON.stringify({ ok: true, result: { message_id: 42 } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
  const ctx = {
    state: {
      get: vi.fn(async (scope: { stateKey: string }) => store.get(scope.stateKey) ?? null),
      set: vi.fn(async (scope: { stateKey: string }, value: unknown) => {
        store.set(scope.stateKey, value);
      }),
    },
    metrics: { write: vi.fn(async () => undefined) },
    http: { fetch: fetchMock },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  } as unknown as PluginContext;
  return { ctx, fetchMock };
}

describe("sendMessage hard send limiter", () => {
  it("hard-caps at 5 sends per minute and drops the 6th", async () => {
    // Acceptance: More than 5 sends/min hits limiter.
    const { ctx, fetchMock } = makeMockCtx();
    for (let i = 0; i < 5; i++) {
      const result = await sendMessage(ctx, "TOKEN", "chat-1", `msg ${i}`);
      expect(result).toBe(42);
    }
    expect(fetchMock).toHaveBeenCalledTimes(5);

    const dropped = await sendMessage(ctx, "TOKEN", "chat-1", "msg 6");
    expect(dropped).toBeNull();
    // No new outbound fetch — limiter dropped without sleep/retry.
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(ctx.logger.error).toHaveBeenCalledWith(
      "Telegram send hard-limited",
      expect.objectContaining({ chatId: "chat-1", limit: 5 }),
    );
  });

  it("limiter is shared across all chat ids on the same plugin instance", async () => {
    // The runaway flood was driven by sendMessage to many chats from one
    // worker; the limiter must be instance-scoped, not per-chat.
    const { ctx, fetchMock } = makeMockCtx();
    for (let i = 0; i < 5; i++) {
      await sendMessage(ctx, "TOKEN", `chat-${i}`, "x");
    }
    const dropped = await sendMessage(ctx, "TOKEN", "chat-other", "x");
    expect(dropped).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("resets the window after 60s and allows new sends", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-04-29T00:00:00Z"));
      const { ctx, fetchMock } = makeMockCtx();
      for (let i = 0; i < 5; i++) {
        await sendMessage(ctx, "TOKEN", "chat-1", "x");
      }
      expect(await sendMessage(ctx, "TOKEN", "chat-1", "x")).toBeNull();

      vi.setSystemTime(new Date("2026-04-29T00:01:01Z"));
      const result = await sendMessage(ctx, "TOKEN", "chat-1", "x");
      expect(result).toBe(42);
      expect(fetchMock).toHaveBeenCalledTimes(6);
    } finally {
      vi.useRealTimers();
    }
  });
});
