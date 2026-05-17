import { describe, expect, it, vi } from "vitest";
import { loadStartupConfig, resolveCompatibleConfig } from "../src/config-compat.js";

function createContext(configGet: (...args: unknown[]) => Promise<Record<string, unknown>>) {
  return {
    config: { get: configGet },
    logger: {
      warn: vi.fn(),
    },
  } as any;
}

describe("loadStartupConfig", () => {
  it("merges startup config with defaults", async () => {
    const ctx = createContext(async () => ({ enableCommands: true }));

    await expect(loadStartupConfig(ctx, {
      enableCommands: false,
      telegramBotTokenRef: "",
    })).resolves.toEqual({
      enableCommands: true,
      telegramBotTokenRef: "",
    });
  });

  it("falls back to defaults when startup config cannot load", async () => {
    const ctx = createContext(async () => {
      throw new Error("config unavailable");
    });
    const fallback = { telegramBotTokenRef: "global-secret" };

    await expect(loadStartupConfig(ctx, fallback)).resolves.toEqual(fallback);
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      "Failed to load Telegram plugin config; using defaults",
      expect.objectContaining({ companyId: null }),
    );
  });
});

describe("resolveCompatibleConfig", () => {
  it("uses company-scoped config when Paperclip supports it", async () => {
    const ctx = createContext(async (params) => (
      params && typeof params === "object" && "companyId" in params
        ? { defaultChatId: "company-chat" }
        : { defaultChatId: "global-chat" }
    ));

    await expect(resolveCompatibleConfig(ctx, {
      defaultChatId: "fallback-chat",
      telegramBotTokenRef: "global-secret",
    }, "company-1")).resolves.toEqual({
      defaultChatId: "company-chat",
      telegramBotTokenRef: "global-secret",
    });
  });

  it("falls back to global config when scoped config is unsupported", async () => {
    const ctx = createContext(async (params) => {
      if (params) throw new Error("scoped plugin config unsupported");
      return { defaultChatId: "global-chat" };
    });
    const fallback = {
      defaultChatId: "global-chat",
      telegramBotTokenRef: "global-secret",
    };

    await expect(resolveCompatibleConfig(ctx, fallback, "company-1")).resolves.toEqual(fallback);
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      "Company-scoped Telegram plugin config unavailable; using global config",
      expect.objectContaining({ companyId: "company-1" }),
    );
  });
});
