import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { resolveTelegramBotToken, type TelegramRuntimeHealth } from "../src/runtime-token.js";

function makeContext(resolve: (...args: unknown[]) => Promise<string>): PluginContext {
  return {
    secrets: { resolve: vi.fn(resolve) },
    logger: {
      error: vi.fn(),
    },
  } as unknown as PluginContext;
}

describe("resolveTelegramBotToken", () => {
  it("returns the resolved bot token and marks health ok", async () => {
    const health: TelegramRuntimeHealth[] = [];
    const ctx = makeContext(async () => "bot-token");

    const token = await resolveTelegramBotToken(ctx, "secret-ref", (next) => health.push(next), "company-1");

    expect(token).toBe("bot-token");
    expect(health).toEqual([{ status: "ok" }]);
    expect(ctx.secrets.resolve).toHaveBeenCalledWith("secret-ref", {
      companyId: "company-1",
      configPath: "telegramBotTokenRef",
    });
  });

  it("degrades health and does not throw when Paperclip secret resolution fails", async () => {
    const health: TelegramRuntimeHealth[] = [];
    const ctx = makeContext(async () => {
      throw new Error("temporary secret store failure");
    });

    const token = await resolveTelegramBotToken(ctx, "secret-ref", (next) => health.push(next), "company-1");

    expect(token).toBeUndefined();
    expect(health).toEqual([{
      status: "degraded",
      message: "Bot token secret resolution failed: Error: temporary secret store failure",
      details: {
        error: "Error: temporary secret store failure",
      },
    }]);
    expect(ctx.logger.error).toHaveBeenCalledWith(
      "Telegram plugin cannot resolve bot token secret; runtime features are disabled",
      {
        error: "Error: temporary secret store failure",
      },
    );
  });
});
