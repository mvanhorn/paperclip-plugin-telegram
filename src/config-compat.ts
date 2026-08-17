import type { PluginContext } from "@paperclipai/plugin-sdk";

type Logger = PluginContext["logger"];

function logConfigFallback(
  logger: Logger,
  message: string,
  companyId: string | null | undefined,
  err: unknown,
): void {
  logger.warn(message, {
    companyId,
    error: String(err),
  });
}

/**
 * Load the unscoped, startup-time plugin config.
 *
 * On hosts that enforce per-invocation company scoping, `ctx.config.get()`
 * with no companyId fails from setup() with "company context is required" —
 * the same class of scoping failure `listCompaniesForStartup` works around
 * for `companies.list()`. When that happens, retry once against the company
 * id already known from board-access state (passed in as `fallbackCompanyId`)
 * rather than silently running on defaults until some later event happens to
 * carry a company scope.
 */
export async function loadStartupConfig<T extends Record<string, unknown>>(
  ctx: PluginContext,
  fallback: T,
  fallbackCompanyId?: string | null,
): Promise<T> {
  try {
    const rawConfig = await ctx.config.get();
    return { ...fallback, ...rawConfig } as T;
  } catch (err) {
    if (fallbackCompanyId) {
      try {
        const scopedConfig = await ctx.config.get(fallbackCompanyId);
        return { ...fallback, ...scopedConfig } as T;
      } catch (scopedErr) {
        logConfigFallback(
          ctx.logger,
          "Failed to load Telegram plugin config; using defaults",
          fallbackCompanyId,
          scopedErr,
        );
        return fallback;
      }
    }
    logConfigFallback(ctx.logger, "Failed to load Telegram plugin config; using defaults", null, err);
    return fallback;
  }
}

export async function resolveCompatibleConfig<T extends Record<string, unknown>>(
  ctx: PluginContext,
  fallback: T,
  companyId?: string | null,
): Promise<T> {
  try {
    const scopedConfig = await ctx.config.get(companyId ?? undefined);
    return { ...fallback, ...scopedConfig } as T;
  } catch (err) {
    logConfigFallback(
      ctx.logger,
      "Company-scoped Telegram plugin config unavailable; using global config",
      companyId,
      err,
    );
    return fallback;
  }
}
