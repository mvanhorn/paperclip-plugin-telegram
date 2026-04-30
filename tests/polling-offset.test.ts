import { describe, it, expect, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  getPersistedTelegramUpdateOffset,
  handleTelegramUpdateThenPersistOffset,
  persistTelegramUpdateOffset,
  processTelegramUpdateBatch,
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

describe("handleTelegramUpdateThenPersistOffset", () => {
  it("persists the update offset only after handling succeeds", async () => {
    const calls: string[] = [];
    const logger = { error: vi.fn() };

    const nextOffset = await handleTelegramUpdateThenPersistOffset({
      updateId: 42,
      lastUpdateId: 41,
      handleUpdate: vi.fn(async () => {
        calls.push("handle");
      }),
      persistOffset: vi.fn(async (updateId) => {
        calls.push(`persist:${updateId}`);
      }),
      logger,
    });

    expect(nextOffset).toBe(42);
    expect(calls).toEqual(["handle", "persist:42"]);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("does not advance or persist the offset when handling fails", async () => {
    const persistOffset = vi.fn(async () => undefined);
    const logger = { error: vi.fn() };

    const nextOffset = await handleTelegramUpdateThenPersistOffset({
      updateId: 42,
      lastUpdateId: 41,
      handleUpdate: vi.fn(async () => {
        throw new Error("boom");
      }),
      persistOffset,
      logger,
    });

    expect(nextOffset).toBe(41);
    expect(persistOffset).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith("Telegram update handling failed", {
      updateId: 42,
      error: "Error: boom",
    });
  });
});

describe("processTelegramUpdateBatch", () => {
  it("stops after a failed update so later updates cannot advance past it", async () => {
    const handledUpdateIds: number[] = [];
    const persistOffset = vi.fn(async () => undefined);
    const logger = { error: vi.fn() };

    const nextOffset = await processTelegramUpdateBatch({
      updates: [{ update_id: 42 }, { update_id: 43 }],
      lastUpdateId: 41,
      handleUpdate: vi.fn(async (update) => {
        handledUpdateIds.push(update.update_id);
        if (update.update_id === 42) {
          throw new Error("boom");
        }
      }),
      persistOffset,
      logger,
    });

    expect(nextOffset).toBe(41);
    expect(handledUpdateIds).toEqual([42]);
    expect(persistOffset).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith("Telegram update handling failed", {
      updateId: 42,
      error: "Error: boom",
    });
  });

  it("persists each contiguous successfully handled update", async () => {
    const persistOffset = vi.fn(async () => undefined);
    const logger = { error: vi.fn() };

    const nextOffset = await processTelegramUpdateBatch({
      updates: [{ update_id: 42 }, { update_id: 43 }],
      lastUpdateId: 41,
      handleUpdate: vi.fn(async () => undefined),
      persistOffset,
      logger,
    });

    expect(nextOffset).toBe(43);
    expect(persistOffset).toHaveBeenNthCalledWith(1, 42);
    expect(persistOffset).toHaveBeenNthCalledWith(2, 43);
    expect(logger.error).not.toHaveBeenCalled();
  });
});
