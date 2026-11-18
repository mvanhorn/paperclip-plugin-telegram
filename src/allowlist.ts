export type TelegramAllowlistConfig = {
  allowedTelegramUserIds?: unknown;
  allowedTelegramChatIds?: unknown;
};

export type TelegramAllowlistUpdate = {
  update_id: number;
  message?: {
    from?: { id: number };
    chat: { id: number };
  };
  callback_query?: {
    from: { id: number };
    message?: {
      chat: { id: number };
    };
  };
};

function normalizeAllowlist(values: unknown): Set<string> {
  if (!Array.isArray(values)) return new Set();
  return new Set(
    values
      .map((value) => String(value).trim())
      .filter((value) => value.length > 0),
  );
}

export function validateTelegramAllowlists(config: TelegramAllowlistConfig): string[] {
  const errors: string[] = [];
  for (const key of ["allowedTelegramUserIds", "allowedTelegramChatIds"] as const) {
    const value = config[key];
    if (value === undefined || Array.isArray(value)) continue;
    errors.push(`${key} must be an array of Telegram ID strings. At least one of allowedTelegramUserIds / allowedTelegramChatIds must be non-empty or all incoming Telegram updates are ignored.`);
  }
  return errors;
}

export function isTelegramUpdateAllowed(
  config: TelegramAllowlistConfig,
  update: TelegramAllowlistUpdate,
): boolean {
  const allowedUserIds = normalizeAllowlist(config.allowedTelegramUserIds);
  const allowedChatIds = normalizeAllowlist(config.allowedTelegramChatIds);

  // Fail closed: with no allowlist configured nobody may drive the bot.
  if (allowedUserIds.size === 0 && allowedChatIds.size === 0) {
    return false;
  }

  const fromId = update.message?.from?.id ?? update.callback_query?.from.id;
  const chatId = update.message?.chat.id ?? update.callback_query?.message?.chat.id;

  if (allowedUserIds.size > 0 && (!fromId || !allowedUserIds.has(String(fromId)))) {
    return false;
  }

  if (allowedChatIds.size > 0 && (!chatId || !allowedChatIds.has(String(chatId)))) {
    return false;
  }

  return true;
}

export function hasAnyAllowlist(config: TelegramAllowlistConfig): boolean {
  return normalizeAllowlist(config.allowedTelegramUserIds).size > 0
    || normalizeAllowlist(config.allowedTelegramChatIds).size > 0;
}
