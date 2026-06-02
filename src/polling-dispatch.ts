export type TelegramDispatchConfig = {
  defaultChatId?: unknown;
  approvalsChatId?: unknown;
  errorsChatId?: unknown;
  digestChatId?: unknown;
  escalationChatId?: unknown;
  allowedTelegramChatIds?: unknown;
  briefAgentChatIds?: unknown;
};

export type TelegramDispatchRuntime = {
  companyId: string;
  config: TelegramDispatchConfig;
};

export type TelegramDispatchUpdate = {
  message?: {
    chat: { id: number };
  };
  callback_query?: {
    message?: {
      chat: { id: number };
    };
  };
};

function addStringValue(values: Set<string>, value: unknown): void {
  if (typeof value !== "string" && typeof value !== "number") return;
  const normalized = String(value).trim();
  if (normalized) values.add(normalized);
}

function addStringArray(values: Set<string>, source: unknown): void {
  if (!Array.isArray(source)) return;
  for (const value of source) addStringValue(values, value);
}

export function getTelegramUpdateChatId(update: TelegramDispatchUpdate): string | null {
  const chatId = update.message?.chat.id ?? update.callback_query?.message?.chat.id;
  return typeof chatId === "number" ? String(chatId) : null;
}

export function telegramRuntimeChatIds(config: TelegramDispatchConfig): Set<string> {
  const values = new Set<string>();
  addStringValue(values, config.defaultChatId);
  addStringValue(values, config.approvalsChatId);
  addStringValue(values, config.errorsChatId);
  addStringValue(values, config.digestChatId);
  addStringValue(values, config.escalationChatId);
  addStringArray(values, config.allowedTelegramChatIds);
  addStringArray(values, config.briefAgentChatIds);
  return values;
}

export function selectTelegramRuntimeForUpdate<TRuntime extends TelegramDispatchRuntime>(
  runtimes: TRuntime[],
  update: TelegramDispatchUpdate,
): TRuntime | null {
  if (runtimes.length === 0) return null;

  const chatId = getTelegramUpdateChatId(update);
  if (!chatId) return runtimes.length === 1 ? runtimes[0] : null;

  const matches = runtimes.filter((runtime) => telegramRuntimeChatIds(runtime.config).has(chatId));
  if (matches.length === 1) return matches[0];

  return runtimes.length === 1 ? runtimes[0] : null;
}
