import type { PluginContext, PluginHealthDiagnostics } from "@paperclipai/plugin-sdk";

export type TelegramRuntimeHealth = PluginHealthDiagnostics & {
  message?: string;
  details?: Record<string, unknown>;
};

export const SECRET_RESOLUTION_FAILED_MESSAGE = "Telegram bot token secret could not be resolved";

export async function resolveStartupTelegramBotToken(
  ctx: PluginContext,
  tokenRef: string,
  setHealth: (health: TelegramRuntimeHealth) => void,
): Promise<string | undefined> {
  try {
    const token = await ctx.secrets.resolve(tokenRef);
    setHealth({ status: "ok" });
    return token;
  } catch (err) {
    const error = String(err);
    setHealth({
      status: "degraded",
      message: SECRET_RESOLUTION_FAILED_MESSAGE,
      details: {
        issue: "telegram-bot-token-resolution-failed",
        error,
      },
    });
    ctx.logger.error("Telegram plugin cannot resolve bot token secret; runtime features are disabled", {
      error,
    });
    return undefined;
  }
}
