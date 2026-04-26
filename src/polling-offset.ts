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
