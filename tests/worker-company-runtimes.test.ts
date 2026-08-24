import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { resolveCompanyRuntimes } from "../src/worker.js";

const tokenRef = "11111111-2222-4333-8444-555555555555";

function context(config: Record<string, unknown>, companies = [{ id: "co-1" }]) {
  const resolve = vi.fn(async () => "bot-token");
  return {
    ctx: {
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      companies: { list: vi.fn(async () => companies) },
      config: { get: vi.fn(async () => config) },
      secrets: { resolve },
      state: { get: vi.fn(async () => null), set: vi.fn() },
    } as unknown as PluginContext,
    resolve,
  };
}

describe("resolveCompanyRuntimes", () => {
  it("keeps a sole company when gated startup config equals scoped config", async () => {
    const config = { telegramBotTokenRef: tokenRef, defaultChatId: "company-chat" };
    const { ctx } = context(config);

    const runtimes = await resolveCompanyRuntimes(ctx, config as never, () => true);

    expect(runtimes).toHaveLength(1);
    expect(runtimes[0].companyId).toBe("co-1");
  });

  it("normalizes object secret refs before resolving and uses their id as identity", async () => {
    const config = {
      telegramBotTokenRef: { type: "secret_ref", secretId: tokenRef },
      defaultChatId: "company-chat",
    };
    const { ctx, resolve } = context(config, [{ id: "co-1" }, { id: "co-2" }]);

    const runtimes = await resolveCompanyRuntimes(ctx, config as never, () => true);

    expect(runtimes).toHaveLength(2);
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(resolve).toHaveBeenCalledWith(
      { type: "secret_ref", secretId: tokenRef },
      { companyId: expect.any(String), configPath: "telegramBotTokenRef" },
    );
  });
});
