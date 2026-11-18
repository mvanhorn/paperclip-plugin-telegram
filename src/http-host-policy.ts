/**
 * Outbound host policy for custom-command `http_request` steps.
 *
 * Deny-by-default: with an empty allowlist every `http_request` step is
 * refused. Entries are exact hostnames ("api.example.com"), wildcard
 * subdomains ("*.example.com", which does NOT match the bare apex), and may
 * carry an explicit port ("api.example.com:8443"). An entry without a port only
 * permits the default HTTPS port. Only https:// URLs are accepted, and URLs
 * with embedded credentials are refused.
 *
 * The check runs on the URL AFTER {{arg}} / {{step.result}} interpolation, so
 * chat-supplied arguments cannot redirect a request to another host.
 */

const HOST_ENTRY_PATTERN = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/;

export type HttpUrlCheck = { ok: true; url: string } | { ok: false; error: string };

export function normalizeHostAllowlist(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return values
    .map((value) => String(value).trim().toLowerCase())
    .filter((value) => value.length > 0);
}

export function validateHostAllowlist(values: unknown): string[] {
  if (values === undefined) return [];
  if (!Array.isArray(values)) {
    return ["allowedHttpRequestHosts must be an array of hostnames. Leave it empty to block all http_request steps."];
  }
  const errors: string[] = [];
  for (const entry of normalizeHostAllowlist(values)) {
    if (!HOST_ENTRY_PATTERN.test(entry)) {
      errors.push(
        `allowedHttpRequestHosts entry "${entry.slice(0, 80)}" is invalid. Use a bare hostname such as "api.example.com", "*.example.com", or "api.example.com:8443" (no scheme or path).`,
      );
    }
  }
  return errors;
}

function entryMatches(entry: string, hostname: string, port: string): boolean {
  const [entryHost, entryPort] = entry.split(":") as [string, string | undefined];
  if ((entryPort ?? "443") !== port) return false;
  if (entryHost.startsWith("*.")) {
    return hostname.endsWith(entryHost.slice(1)) && hostname.length > entryHost.length - 1;
  }
  return hostname === entryHost;
}

export function checkHttpRequestUrl(rawUrl: string, allowedHosts: readonly string[]): HttpUrlCheck {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, error: "http_request URL is not a valid absolute URL." };
  }
  if (parsed.protocol !== "https:") {
    return { ok: false, error: "http_request only allows https:// URLs." };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, error: "http_request URLs must not contain embedded credentials." };
  }
  if (allowedHosts.length === 0) {
    return {
      ok: false,
      error: "http_request is disabled: allowedHttpRequestHosts is empty. Add the host in plugin settings to allow it.",
    };
  }
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
  const port = parsed.port || "443";
  if (!allowedHosts.some((entry) => entryMatches(entry, hostname, port))) {
    return { ok: false, error: `http_request host "${hostname.slice(0, 80)}" is not in allowedHttpRequestHosts.` };
  }
  return { ok: true, url: parsed.toString() };
}
