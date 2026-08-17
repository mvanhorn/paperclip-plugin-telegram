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

  it("falls back to defaults when startup config cannot load and no fallback company id is given", async () => {
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

  it("retries with the fallback company id when the unscoped call fails for lack of company context", async () => {
    // Regression: on hosts that enforce per-invocation company scoping,
    // ctx.config.get() with no companyId fails from setup() with "company
    // context is required" every single time. Without this retry, the plugin
    // silently runs on defaults forever — paperclipBoardApiTokenRef stays
    // empty and board access looks broken even though the token is fine.
    const ctx = createContext(async (companyId?: string) => {
      if (!companyId) throw new Error("company context is required");
      return companyId === "co-fallback" ? { defaultChatId: "company-chat" } : {};
    });
    const fallback = { telegramBotTokenRef: "global-secret", defaultChatId: "" };

    await expect(loadStartupConfig(ctx, fallback, "co-fallback")).resolves.toEqual({
      telegramBotTokenRef: "global-secret",
      defaultChatId: "company-chat",
    });
    expect(ctx.logger.warn).not.toHaveBeenCalled();
  });

  it("falls back to defaults when both the unscoped and the scoped retry fail", async () => {
    const ctx = createContext(async () => {
      throw new Error("company context is required");
    });
    const fallback = { telegramBotTokenRef: "global-secret" };

    await expect(loadStartupConfig(ctx, fallback, "co-fallback")).resolves.toEqual(fallback);
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      "Failed to load Telegram plugin config; using defaults",
      expect.objectContaining({ companyId: "co-fallback" }),
    );
  });
});

describe("resolveCompatibleConfig", () => {
  it("uses company-scoped config when Paperclip supports it", async () => {
    const ctx = createContext(async (companyId) => (
      companyId === "company-1"
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
