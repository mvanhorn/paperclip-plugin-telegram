import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";

import { listCompaniesForStartup, resolveCompanyRuntimes } from "../src/worker.js";

let stateStore: Record<string, unknown> = {};
let configByCompany: Record<string, Record<string, unknown>> = {};

function mockCtx(overrides: Partial<PluginContext> = {}): PluginContext {
  return {
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    state: {
      get: vi.fn(async (key: { stateKey: string }) => stateStore[key.stateKey] ?? null),
      set: vi.fn(async (key: { stateKey: string }, value: unknown) => {
        stateStore[key.stateKey] = value;
      }),
    },
    companies: {
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue(null),
    },
    config: {
      get: vi.fn(async (companyId: string) => configByCompany[companyId] ?? {}),
    },
    secrets: {
      resolve: vi.fn().mockResolvedValue("bot-token-123"),
    },
    ...overrides,
  } as unknown as PluginContext;
}

beforeEach(() => {
  stateStore = {};
  configByCompany = {};
});

describe("listCompaniesForStartup (regression: companies.list returning [] must not silently disable polling)", () => {
  it("returns the companies.list result when it is non-empty", async () => {
    const ctx = mockCtx({
      companies: { list: vi.fn().mockResolvedValue([{ id: "co-1" }, { id: "co-2" }]), get: vi.fn() } as unknown as PluginContext["companies"],
    });

    const result = await listCompaniesForStartup(ctx);
    expect(result).toEqual([{ id: "co-1" }, { id: "co-2" }]);
  });

  it("falls back to the board-access companyId when companies.list SUCCEEDS but returns []", async () => {
    stateStore["telegram.board-access.v1"] = { companyId: "co-fallback" };
    const ctx = mockCtx({
      companies: { list: vi.fn().mockResolvedValue([]), get: vi.fn() } as unknown as PluginContext["companies"],
    });

    const result = await listCompaniesForStartup(ctx);

    // This is the exact bug this function exists to prevent: an empty array
    // returned WITHOUT a thrown error must still fall back, or polling never starts.
    expect(result).toEqual([{ id: "co-fallback" }]);
  });

  it("falls back to the board-access companyId when companies.list throws", async () => {
    stateStore["telegram.board-access.v1"] = { companyId: "co-fallback" };
    const ctx = mockCtx({
      companies: { list: vi.fn().mockRejectedValue(new Error("no invocation scope")), get: vi.fn() } as unknown as PluginContext["companies"],
    });

    const result = await listCompaniesForStartup(ctx);
    expect(result).toEqual([{ id: "co-fallback" }]);
  });

  it("returns [] and logs a warning when there is no fallback company id either", async () => {
    const ctx = mockCtx({
      companies: { list: vi.fn().mockResolvedValue([]), get: vi.fn() } as unknown as PluginContext["companies"],
    });

    const result = await listCompaniesForStartup(ctx);
    expect(result).toEqual([]);
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("no fallback company id is known"),
      expect.anything(),
    );
  });
});

describe("resolveCompanyRuntimes (config merge + company-runtime resolution)", () => {
  const startupConfig = {
    telegramBotTokenRef: "",
    defaultChatId: "",
    paperclipBaseUrl: "http://startup-base",
  } as unknown as Parameters<typeof resolveCompanyRuntimes>[1];

  it("skips a company whose scoped config throws instead of aborting the whole resolution", async () => {
    stateStore["telegram.board-access.v1"] = { companyId: "co-1" };
    configByCompany = {
      "co-1": undefined as unknown as Record<string, unknown>,
      "co-2": { telegramBotTokenRef: "ref-2", defaultChatId: "chat-2" },
    };
    const ctx = mockCtx({
      companies: { list: vi.fn().mockResolvedValue([{ id: "co-1" }, { id: "co-2" }]), get: vi.fn() } as unknown as PluginContext["companies"],
      config: {
        get: vi.fn(async (companyId: string) => {
          if (companyId === "co-1") throw new Error("scope unavailable");
          return configByCompany[companyId] ?? {};
        }),
      } as unknown as PluginContext["config"],
    });

    const runtimes = await resolveCompanyRuntimes(ctx, startupConfig, () => true);

    expect(runtimes).toHaveLength(1);
    expect(runtimes[0].companyId).toBe("co-2");
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("config unavailable"),
      expect.objectContaining({ companyId: "co-1" }),
    );
  });

  it("skips companies with no telegramBotTokenRef key at all in scoped config", async () => {
    configByCompany = { "co-1": { someOtherKey: "x" } };
    const ctx = mockCtx({
      companies: { list: vi.fn().mockResolvedValue([{ id: "co-1" }]), get: vi.fn() } as unknown as PluginContext["companies"],
    });

    const runtimes = await resolveCompanyRuntimes(ctx, startupConfig, () => true);
    expect(runtimes).toEqual([]);
  });

  it("merges scoped config over startup config so company-specific values win", async () => {
    configByCompany = {
      "co-1": { telegramBotTokenRef: "ref-1", defaultChatId: "company-chat" },
    };
    const ctx = mockCtx({
      companies: { list: vi.fn().mockResolvedValue([{ id: "co-1" }]), get: vi.fn() } as unknown as PluginContext["companies"],
    });

    const runtimes = await resolveCompanyRuntimes(ctx, startupConfig, () => true);

    expect(runtimes).toHaveLength(1);
    expect(runtimes[0].config.defaultChatId).toBe("company-chat");
    // paperclipBaseUrl was not overridden by the company, so the startup value survives the merge
    expect(runtimes[0].baseUrl).toBe("http://startup-base");
  });

  it("excludes a company when the predicate rejects its effective config", async () => {
    configByCompany = {
      "co-1": { telegramBotTokenRef: "ref-1", defaultChatId: "company-chat", enableCommands: false, enableInbound: false },
    };
    const ctx = mockCtx({
      companies: { list: vi.fn().mockResolvedValue([{ id: "co-1" }]), get: vi.fn() } as unknown as PluginContext["companies"],
    });

    const runtimes = await resolveCompanyRuntimes(
      ctx,
      startupConfig,
      (config) => Boolean(config.enableCommands || config.enableInbound),
    );
    expect(runtimes).toEqual([]);
  });

  it("skips a company when the bot token secret fails to resolve", async () => {
    configByCompany = {
      "co-1": { telegramBotTokenRef: "ref-1", defaultChatId: "company-chat" },
    };
    const ctx = mockCtx({
      companies: { list: vi.fn().mockResolvedValue([{ id: "co-1" }]), get: vi.fn() } as unknown as PluginContext["companies"],
      secrets: { resolve: vi.fn().mockRejectedValue(new Error("secret gone")) } as unknown as PluginContext["secrets"],
    });

    const runtimes = await resolveCompanyRuntimes(ctx, startupConfig, () => true);
    expect(runtimes).toEqual([]);
  });

  it("excludes a company whose scoped routing values are identical to startup's (no real per-company override)", async () => {
    // hasCompanyTelegramRoute requires at least one routing key to differ from
    // the startup value. A company that echoes back the same blank/startup
    // values has no real Telegram route configured and must be skipped.
    configByCompany = {
      "co-1": { telegramBotTokenRef: "", defaultChatId: "" },
    };
    const ctx = mockCtx({
      companies: { list: vi.fn().mockResolvedValue([{ id: "co-1" }]), get: vi.fn() } as unknown as PluginContext["companies"],
    });

    const runtimes = await resolveCompanyRuntimes(ctx, startupConfig, () => true);
    expect(runtimes).toEqual([]);
  });
});
