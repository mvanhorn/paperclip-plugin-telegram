import { describe, it, expect, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  getPersistedTelegramUpdateOffset,
  persistTelegramUpdateOffset,
  TELEGRAM_LAST_UPDATE_ID_STATE_KEY,
} from "../src/polling-offset.js";

function mockCtx(saved: unknown = null): PluginContext {
  return {
    state: {
      get: vi.fn(async () => saved),
      set: vi.fn(async () => undefined),
    },
  } as unknown as PluginContext;
}

describe("Telegram polling offset persistence", () => {
  it("returns zero when no offset is stored", async () => {
    const ctx = mockCtx(null);
    await expect(getPersistedTelegramUpdateOffset(ctx)).resolves.toBe(0);
  });

  it("loads a numeric offset", async () => {
    const ctx = mockCtx(335106053);
    await expect(getPersistedTelegramUpdateOffset(ctx)).resolves.toBe(335106053);
  });

  it("loads a string offset", async () => {
    const ctx = mockCtx("335106053");
    await expect(getPersistedTelegramUpdateOffset(ctx)).resolves.toBe(335106053);
  });

  it("ignores invalid stored offsets", async () => {
    await expect(getPersistedTelegramUpdateOffset(mockCtx("not-a-number"))).resolves.toBe(0);
    await expect(getPersistedTelegramUpdateOffset(mockCtx(-1))).resolves.toBe(0);
  });

  it("persists a valid update id in instance state", async () => {
    const ctx = mockCtx();
    await persistTelegramUpdateOffset(ctx, 335106054);
    expect(ctx.state.set).toHaveBeenCalledWith(
      { scopeKind: "instance", stateKey: TELEGRAM_LAST_UPDATE_ID_STATE_KEY },
      335106054,
    );
  });

  it("does not persist invalid update ids", async () => {
    const ctx = mockCtx();
    await persistTelegramUpdateOffset(ctx, -1);
    await persistTelegramUpdateOffset(ctx, Number.NaN);
    expect(ctx.state.set).not.toHaveBeenCalled();
  });
});
