/**
 * Event and tool payloads arrive as `Record<string, unknown>` off the wire.
 * `String(payload.field)` on such a value silently renders "[object Object]"
 * into a Telegram message when the field turns out to be an object rather
 * than a primitive. `str()` is the one place that decision gets made: coerce
 * primitives, fall back (and optionally log) for anything else.
 */

export interface CoerceLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
}

export function str(value: unknown, fallback = "", logger?: CoerceLogger): string {
  if (value === null || value === undefined) return fallback;
  switch (typeof value) {
    case "string":
      return value;
    case "number":
    case "bigint":
    case "boolean":
      return String(value);
    default:
      logger?.warn("Expected a primitive value but received a non-primitive; using fallback", {
        type: typeof value,
      });
      return fallback;
  }
}

/**
 * For values caught from a `try`/`catch`, not JSON payload fields: an `Error`
 * carries a message worth keeping even though its static type here is
 * `unknown`, so it is special-cased ahead of the generic primitive-only rule.
 */
export function errorMessage(err: unknown, fallback = "unknown error"): string {
  if (err instanceof Error) return err.message;
  return str(err, fallback);
}
