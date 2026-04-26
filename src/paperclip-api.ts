import type { PluginContext } from "@paperclipai/plugin-sdk";

function isLoopbackUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname);
  } catch {
    return false;
  }
}

export async function fetchPaperclipApi(
  ctx: PluginContext,
  url: string,
  init?: RequestInit,
): Promise<Response> {
  const response = isLoopbackUrl(url)
    ? await fetch(url, init)
    : await ctx.http.fetch(url, init);

  if (!response.ok) {
    let body = "";
    try {
      body = await response.text();
    } catch {
      body = "";
    }
    const detail = body ? `: ${body.slice(0, 300)}` : "";
    throw new Error(`Paperclip API request failed with ${response.status}${detail}`);
  }

  return response;
}

export function buildPaperclipAuthHeaders(
  boardApiToken?: string,
): Record<string, string> {
  return boardApiToken
    ? {
        Authorization: `Bearer ${boardApiToken}`,
      }
    : {};
}
