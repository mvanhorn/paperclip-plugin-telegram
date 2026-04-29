// Local policy (2026-04-29): pure helpers used by worker.ts polling loop and
// command dispatch. Extracted so they are unit-testable without a live
// Telegram API or PluginContext.

export const STALE_UPDATE_GRACE_SECONDS = 30;

export type TelegramUpdateLite = {
  update_id: number;
  message?: { date?: number; entities?: Array<{ type: string; offset: number }> };
  callback_query?: { message?: { date?: number } };
};

export type UpdateFilterDecision =
  | { action: "skip"; reason: "duplicate" | "stale" }
  | { action: "process" };

/**
 * Decide whether to process or skip a Telegram polling update.
 *
 * - Duplicates (update_id <= lastUpdateId) are dropped to prevent replay floods.
 * - Updates older than `pollingStartedAtSeconds - graceSeconds` are dropped
 *   so a plugin restart does not reprocess pre-restart commands.
 */
export function classifyUpdate(
  update: TelegramUpdateLite,
  lastUpdateId: number,
  pollingStartedAtSeconds: number,
  graceSeconds: number = STALE_UPDATE_GRACE_SECONDS,
): UpdateFilterDecision {
  if (update.update_id <= lastUpdateId) {
    return { action: "skip", reason: "duplicate" };
  }
  const updateDate = update.message?.date ?? update.callback_query?.message?.date;
  if (typeof updateDate === "number" && updateDate < pollingStartedAtSeconds - graceSeconds) {
    return { action: "skip", reason: "stale" };
  }
  return { action: "process" };
}

/**
 * Decide whether a Telegram message text should be dispatched as a slash
 * command. Commands are only dispatched when the bot has `enableCommands=true`
 * AND the first entity is a `bot_command` at offset 0.
 */
export function shouldDispatchCommand(
  text: string | undefined,
  entities: Array<{ type: string; offset: number }> | undefined,
  enableCommands: boolean,
): boolean {
  if (!enableCommands) return false;
  if (!text || !text.startsWith("/")) return false;
  const botCommand = entities?.find((e) => e.type === "bot_command" && e.offset === 0);
  return Boolean(botCommand);
}
