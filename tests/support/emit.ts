import { expect } from "vitest";

/**
 * Assert that a failed host emit was logged by `emitOrLog`.
 *
 * Every emit call site logs through the one helper in src/events.ts, so
 * every one of these assertions is the same shape: one message, the call
 * site's `site` label, whatever ids that site carries, and the error text.
 */
export function expectEmitFailureLogged(
  ctx: { logger: { error: unknown } },
  site: string,
  ids: Record<string, unknown> = {},
): void {
  expect(ctx.logger.error).toHaveBeenCalledWith(
    "Failed to emit host event",
    expect.objectContaining({
      site,
      ...ids,
      error: expect.stringContaining("host RPC unavailable"),
    }),
  );
}

/**
 * Make the next `ctx.events.emit` reject, the way a failed host RPC does.
 * Pairs with `expectEmitFailureLogged` — one setup line, one assertion.
 */
export function rejectEmitOnce(ctx: { events: { emit: unknown } }): void {
  (ctx.events.emit as { mockRejectedValueOnce: (e: Error) => void }).mockRejectedValueOnce(
    new Error("host RPC unavailable"),
  );
}
