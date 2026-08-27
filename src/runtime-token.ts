import type { PluginContext, PluginHealthDiagnostics } from "@paperclipai/plugin-sdk";
import { normalizeSecretRef } from "./secret-ref-validation.js";

export type TelegramRuntimeHealth = PluginHealthDiagnostics & {
  message?: string;
  details?: Record<string, unknown>;
};

export const SECRET_RESOLUTION_DISABLED_MESSAGE = "Plugin secret references are disabled until company-scoped plugin config lands";
export const SECRET_RESOLUTION_ISSUE_URL = "https://github.com/mvanhorn/paperclip-plugin-telegram/issues/63";

/**
 * Resolve the Telegram bot token secret for a company-scoped configuration
 * delivery.
 *
 * Called from `onConfigChanged`, never from `setup()` — an unscoped
 * `ctx.secrets.resolve()` throws "company context is required" on governed
 * hosts (paperclipai/paperclip#9557), so this must always run with the
 * companyId the delivery was attributed to.
 */
export async function resolveTelegramBotToken(
  ctx: PluginContext,
  tokenRef: unknown,
  setHealth: (health: TelegramRuntimeHealth) => void,
  companyId?: string,
): Promise<string | undefined> {
  try {
    const normalizedRef = normalizeSecretRef(tokenRef) ?? tokenRef;
    const token = await ctx.secrets.resolve(normalizedRef as string, {
      companyId,
      configPath: "telegramBotTokenRef",
    });
    setHealth({ status: "ok" });
    return token;
  } catch (err) {
    const error = String(err);
    setHealth({
      status: "degraded",
      message: SECRET_RESOLUTION_DISABLED_MESSAGE,
      details: {
        issue: "paperclip-plugin-secret-resolution-disabled",
        reference: SECRET_RESOLUTION_ISSUE_URL,
      },
    });
    ctx.logger.error("Telegram plugin cannot resolve bot token secret; runtime features are disabled", {
      error,
      reference: SECRET_RESOLUTION_ISSUE_URL,
    });
    return undefined;
  }
}
