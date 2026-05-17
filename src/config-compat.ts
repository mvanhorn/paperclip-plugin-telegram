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

export async function loadStartupConfig<T extends Record<string, unknown>>(
  ctx: PluginContext,
  fallback: T,
): Promise<T> {
  try {
    const rawConfig = await ctx.config.get();
    return { ...fallback, ...rawConfig } as T;
  } catch (err) {
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
    const getConfig = ctx.config.get as unknown as (
      params?: { companyId?: string | null },
    ) => Promise<Record<string, unknown>>;
    const scopedConfig = await getConfig(companyId ? { companyId } : undefined);
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
