import type { PluginContext } from "@paperclipai/plugin-sdk";

export const TELEGRAM_LAST_UPDATE_ID_STATE_KEY = "telegram-last-update-id";

export async function getPersistedTelegramUpdateOffset(ctx: PluginContext): Promise<number> {
  const saved = await ctx.state.get({
    scopeKind: "instance",
    stateKey: TELEGRAM_LAST_UPDATE_ID_STATE_KEY,
  });

  const updateId =
    typeof saved === "number"
      ? saved
      : typeof saved === "string"
        ? Number.parseInt(saved, 10)
        : null;

  return updateId !== null && Number.isSafeInteger(updateId) && updateId >= 0
    ? updateId
    : 0;
}

export async function persistTelegramUpdateOffset(
  ctx: PluginContext,
  updateId: number,
): Promise<void> {
  if (!Number.isSafeInteger(updateId) || updateId < 0) return;

  await ctx.state.set(
    {
      scopeKind: "instance",
      stateKey: TELEGRAM_LAST_UPDATE_ID_STATE_KEY,
    },
    updateId,
  );
}

type PollingLogger = Pick<PluginContext["logger"], "error">;

export async function handleTelegramUpdateThenPersistOffset(options: {
  updateId: number;
  lastUpdateId: number;
  handleUpdate: () => Promise<void>;
  persistOffset: (updateId: number) => Promise<void>;
  logger: PollingLogger;
}): Promise<number> {
  const { updateId, lastUpdateId, handleUpdate, persistOffset, logger } = options;

  try {
    await handleUpdate();
  } catch (err) {
    logger.error("Telegram update handling failed", {
      updateId,
      error: String(err),
    });
    return lastUpdateId;
  }

  const nextUpdateId = Math.max(lastUpdateId, updateId);
  if (nextUpdateId <= lastUpdateId) return lastUpdateId;

  try {
    await persistOffset(nextUpdateId);
  } catch (err) {
    logger.error("Failed to persist Telegram polling offset", {
      updateId: nextUpdateId,
      error: String(err),
    });
  }

  return nextUpdateId;
}

export async function processTelegramUpdateBatch<TUpdate extends { update_id: number }>(options: {
  updates: TUpdate[];
  lastUpdateId: number;
  handleUpdate: (update: TUpdate) => Promise<void>;
  persistOffset: (updateId: number) => Promise<void>;
  logger: PollingLogger;
}): Promise<number> {
  const { updates, handleUpdate, persistOffset, logger } = options;
  let lastUpdateId = options.lastUpdateId;

  for (const update of updates) {
    const nextUpdateId = await handleTelegramUpdateThenPersistOffset({
      updateId: update.update_id,
      lastUpdateId,
      handleUpdate: () => handleUpdate(update),
      persistOffset,
      logger,
    });

    if (nextUpdateId === lastUpdateId && update.update_id > lastUpdateId) {
      break;
    }

    lastUpdateId = nextUpdateId;
  }

  return lastUpdateId;
}
