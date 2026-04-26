import { useState } from "react";
import {
  usePluginAction,
  usePluginData,
  type PluginSettingsPageProps,
} from "@paperclipai/plugin-sdk/ui";

type BoardAccessRegistration = {
  configured: boolean;
  paperclipBoardApiTokenRef: string | null;
  identity: string | null;
  companyId: string | null;
  updatedAt: string | null;
};

type CliAuthChallengeResponse = {
  token?: string;
  boardApiToken?: string;
  approvalUrl?: string;
  approvalPath?: string;
  pollUrl?: string;
  pollPath?: string;
  expiresAt?: string;
  suggestedPollIntervalMs?: number;
};

type CliAuthChallengePollResponse = {
  status?: string;
  boardApiToken?: string;
};

type CliAuthIdentityResponse = {
  user?: {
    displayName?: string | null;
    name?: string | null;
    login?: string | null;
    email?: string | null;
  } | null;
  displayName?: string | null;
  name?: string | null;
  login?: string | null;
  email?: string | null;
};

type Notice = {
  tone: "success" | "error";
  title: string;
  text?: string;
};

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function fetchHostJson<T>(input: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");

  if (typeof init.body === "string" && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  const response = await fetch(input, {
    ...init,
    headers,
    credentials: init.credentials ?? "same-origin",
  });
  const rawBody = await response.text();
  const normalizedBody = rawBody.trim();
  const contentType = response.headers.get("content-type") ?? "";

  if (
    contentType.includes("text/html") ||
    normalizedBody.startsWith("<!DOCTYPE html") ||
    normalizedBody.startsWith("<html")
  ) {
    throw new Error("Paperclip returned HTML instead of JSON.");
  }

  let payload: unknown = null;
  if (normalizedBody) {
    try {
      payload = JSON.parse(normalizedBody);
    } catch {
      throw new Error("Paperclip returned an unexpected response.");
    }
  }

  if (!response.ok) {
    const message =
      typeof payload === "object" &&
      payload !== null &&
      "error" in payload &&
      typeof payload.error === "string"
        ? payload.error
        : `Request failed with status ${response.status}.`;
    throw new Error(message);
  }

  return payload as T;
}

function resolveBrowserOrigin(): string | null {
  if (typeof window === "undefined" || typeof window.location?.origin !== "string") {
    return null;
  }

  const origin = window.location.origin.trim();
  if (!origin || origin === "null") {
    return null;
  }

  try {
    const normalizedOrigin = new URL(origin);
    if (normalizedOrigin.protocol !== "http:" && normalizedOrigin.protocol !== "https:") {
      return null;
    }
    return normalizedOrigin.origin;
  } catch {
    return null;
  }
}

function buildPaperclipUrl(input: string): string | null {
  const origin = resolveBrowserOrigin();
  if (!origin || !input.trim() || input.trim().startsWith("//")) {
    return null;
  }

  try {
    const candidate = new URL(input.trim(), origin);
    return candidate.origin === origin ? candidate.toString() : null;
  } catch {
    return null;
  }
}

function resolveCliAuthUrl(url?: string, path?: string): string | null {
  if (typeof url === "string" && url.trim()) {
    return buildPaperclipUrl(url.trim());
  }

  if (typeof path !== "string" || !path.trim()) {
    return null;
  }

  return buildPaperclipUrl(path.trim());
}

function resolveCliAuthPollUrl(urlOrPath?: string): string | null {
  if (typeof urlOrPath !== "string" || !urlOrPath.trim()) {
    return null;
  }

  const trimmed = urlOrPath.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed)) {
    return buildPaperclipUrl(trimmed);
  }

  const normalizedPath = trimmed.startsWith("/api/")
    ? trimmed
    : `/api${trimmed.startsWith("/") ? "" : "/"}${trimmed}`;

  return buildPaperclipUrl(normalizedPath);
}

function normalizePollIntervalMs(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 1500;
  }

  return Math.min(5000, Math.max(750, Math.floor(value)));
}

function waitForDuration(durationMs: number): Promise<void> {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, durationMs);
  });
}

async function requestBoardAccessChallenge(companyId: string): Promise<CliAuthChallengeResponse> {
  return fetchHostJson<CliAuthChallengeResponse>("/api/cli-auth/challenges", {
    method: "POST",
    body: JSON.stringify({
      command: "paperclip plugin telegram settings",
      clientName: "Telegram plugin",
      requestedAccess: "board",
      requestedCompanyId: companyId,
    }),
  });
}

async function waitForBoardAccessApproval(challenge: CliAuthChallengeResponse): Promise<string> {
  const challengeToken = typeof challenge.token === "string" ? challenge.token.trim() : "";
  const pollUrl = resolveCliAuthPollUrl(challenge.pollUrl ?? challenge.pollPath);
  if (!challengeToken || !pollUrl) {
    throw new Error("Paperclip did not return a trusted board access challenge.");
  }

  const expiresAtTimeMs =
    typeof challenge.expiresAt === "string" ? Date.parse(challenge.expiresAt) : Number.NaN;
  const pollIntervalMs = normalizePollIntervalMs(challenge.suggestedPollIntervalMs);

  while (true) {
    const pollUrlWithToken = new URL(pollUrl);
    pollUrlWithToken.searchParams.set("token", challengeToken);
    const pollResult = await fetchHostJson<CliAuthChallengePollResponse>(
      pollUrlWithToken.toString(),
    );
    const status =
      typeof pollResult.status === "string" ? pollResult.status.trim().toLowerCase() : "pending";

    if (status === "approved") {
      const boardApiToken =
        typeof pollResult.boardApiToken === "string" && pollResult.boardApiToken.trim()
          ? pollResult.boardApiToken.trim()
          : typeof challenge.boardApiToken === "string" && challenge.boardApiToken.trim()
            ? challenge.boardApiToken.trim()
            : "";
      if (!boardApiToken) {
        throw new Error("Paperclip approved board access but did not return a usable API token.");
      }

      return boardApiToken;
    }

    if (status === "cancelled") {
      throw new Error("Board access approval was cancelled.");
    }

    if (status === "expired") {
      throw new Error("Board access approval expired. Start the connection flow again.");
    }

    if (Number.isFinite(expiresAtTimeMs) && Date.now() >= expiresAtTimeMs) {
      throw new Error("Board access approval expired. Start the connection flow again.");
    }

    await waitForDuration(pollIntervalMs);
  }
}

function getIdentityLabel(identity: CliAuthIdentityResponse): string | null {
  const candidates = [
    identity.user?.displayName,
    identity.user?.name,
    identity.user?.login,
    identity.user?.email,
    identity.displayName,
    identity.name,
    identity.login,
    identity.email,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }

  return null;
}

async function fetchBoardAccessIdentity(boardApiToken: string): Promise<string | null> {
  const identity = await fetchHostJson<CliAuthIdentityResponse>("/api/cli-auth/me", {
    headers: {
      authorization: `Bearer ${boardApiToken.trim()}`,
    },
  });

  return getIdentityLabel(identity);
}

async function resolveOrCreateCompanySecret(
  companyId: string,
  name: string,
  value: string,
): Promise<{ id: string; name: string }> {
  const existingSecrets = await fetchHostJson<Array<{ id: string; name: string }>>(
    `/api/companies/${encodeURIComponent(companyId)}/secrets`,
  );
  const existing = existingSecrets.find(
    (secret) => secret.name.trim().toLowerCase() === name.trim().toLowerCase(),
  );

  if (existing) {
    return fetchHostJson<{ id: string; name: string }>(
      `/api/secrets/${encodeURIComponent(existing.id)}/rotate`,
      {
        method: "POST",
        body: JSON.stringify({ value }),
      },
    );
  }

  return fetchHostJson<{ id: string; name: string }>(
    `/api/companies/${encodeURIComponent(companyId)}/secrets`,
    {
      method: "POST",
      body: JSON.stringify({ name, value }),
    },
  );
}

export function TelegramSettingsPage({ context }: PluginSettingsPageProps): React.JSX.Element {
  const boardAccess = usePluginData<BoardAccessRegistration>("board-access.read");
  const updateBoardAccess = usePluginAction("board-access.update");
  const [connecting, setConnecting] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const companyId = context.companyId ?? "";
  const companyLabel = context.companyPrefix?.trim() || "this company";
  const configured = Boolean(boardAccess.data?.configured);
  const identity = boardAccess.data?.identity?.trim() || null;

  async function handleConnectBoardAccess(): Promise<void> {
    if (!companyId) {
      setNotice({
        tone: "error",
        title: "Open company settings first",
        text: "Board access tokens are saved as company secrets, so this flow needs a company context.",
      });
      return;
    }

    setConnecting(true);
    setNotice(null);
    let approvalWindow: Window | null = null;

    try {
      if (typeof window !== "undefined") {
        approvalWindow = window.open("about:blank", "_blank");
      }

      const challenge = await requestBoardAccessChallenge(companyId);
      const approvalUrl = resolveCliAuthUrl(challenge.approvalUrl, challenge.approvalPath);
      if (!approvalUrl) {
        throw new Error("Paperclip did not return a trusted board approval URL.");
      }

      if (!approvalWindow && typeof window !== "undefined") {
        approvalWindow = window.open(approvalUrl, "_blank");
      } else {
        approvalWindow?.location.replace(approvalUrl);
      }

      if (!approvalWindow) {
        throw new Error("Allow pop-ups for Paperclip, then try connecting board access again.");
      }

      const boardApiToken = await waitForBoardAccessApproval(challenge);
      const nextIdentity = await fetchBoardAccessIdentity(boardApiToken);
      const secretName = `telegram_board_api_${companyId.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}`;
      const secret = await resolveOrCreateCompanySecret(companyId, secretName, boardApiToken);

      await updateBoardAccess({
        companyId,
        paperclipBoardApiTokenRef: secret.id,
        identity: nextIdentity,
      });
      await boardAccess.refresh();

      setNotice({
        tone: "success",
        title: nextIdentity ? `Connected as ${nextIdentity}` : "Board access connected",
        text: "Telegram approval actions can now authenticate with Paperclip.",
      });
    } catch (error) {
      setNotice({
        tone: "error",
        title: "Board access could not be connected",
        text: getErrorMessage(error),
      });
    } finally {
      setConnecting(false);
      try {
        approvalWindow?.close();
      } catch {
        // Ignore browser close restrictions.
      }
    }
  }

  return (
    <main style={{ display: "grid", gap: 24, padding: 24, color: "#111827" }}>
      <section style={{ display: "grid", gap: 8 }}>
        <h1 style={{ fontSize: 24, lineHeight: "32px", margin: 0 }}>Telegram Bot</h1>
        <p style={{ color: "#6b7280", margin: 0, maxWidth: 760 }}>
          Configure board access for Telegram approval actions. Chat IDs, topics, allowlists, and notification toggles remain in the standard plugin configuration form.
        </p>
      </section>

      {notice ? (
        <div
          style={{
            border: `1px solid ${notice.tone === "success" ? "#99f6e4" : "#fecaca"}`,
            borderRadius: 8,
            background: notice.tone === "success" ? "#f0fdfa" : "#fef2f2",
            color: notice.tone === "success" ? "#115e59" : "#991b1b",
            padding: 14,
          }}
        >
          <strong>{notice.title}</strong>
          {notice.text ? <p style={{ margin: "6px 0 0" }}>{notice.text}</p> : null}
        </div>
      ) : null}

      <section
        style={{
          border: "1px solid #e5e7eb",
          borderRadius: 8,
          display: "grid",
          gap: 18,
          padding: 18,
        }}
      >
        <div style={{ alignItems: "start", display: "flex", gap: 16, justifyContent: "space-between" }}>
          <div style={{ display: "grid", gap: 4 }}>
            <h2 style={{ fontSize: 18, lineHeight: "28px", margin: 0 }}>Board Access Connection</h2>
            <p style={{ color: "#6b7280", margin: 0 }}>
              Telegram approval buttons need board access when Paperclip requires authenticated approval mutations.
            </p>
          </div>
          <span
            style={{
              background: configured ? "#ccfbf1" : "#f3f4f6",
              borderRadius: 999,
              color: configured ? "#0f766e" : "#4b5563",
              fontSize: 12,
              fontWeight: 700,
              padding: "5px 10px",
              whiteSpace: "nowrap",
            }}
          >
            {connecting ? "Connecting" : configured ? "Connected" : "Not connected"}
          </span>
        </div>

        <div
          style={{
            alignItems: "center",
            background: "#f9fafb",
            border: "1px solid #e5e7eb",
            borderRadius: 8,
            display: "flex",
            gap: 16,
            justifyContent: "space-between",
            padding: 14,
          }}
        >
          <div style={{ display: "grid", gap: 4 }}>
            <strong>
              {!companyId
                ? "Open this page inside a company"
                : configured
                  ? identity
                    ? `Connected as ${identity}`
                    : `Connected for ${companyLabel}`
                  : `Connect board access for ${companyLabel}`}
            </strong>
            <span style={{ color: "#6b7280" }}>
              {configured
                ? "The board token is stored as a Paperclip secret; the plugin keeps only the secret reference."
                : "This opens a Paperclip approval page, then saves the resulting board token as a company secret."}
            </span>
          </div>
          <button
            disabled={!companyId || connecting || boardAccess.loading}
            onClick={() => {
              void handleConnectBoardAccess();
            }}
            style={{
              background: !companyId || connecting || boardAccess.loading ? "#9ca3af" : "#111827",
              border: 0,
              borderRadius: 8,
              color: "white",
              cursor: !companyId || connecting || boardAccess.loading ? "not-allowed" : "pointer",
              fontWeight: 700,
              minWidth: 190,
              padding: "10px 14px",
            }}
            type="button"
          >
            {connecting ? "Waiting for approval..." : configured ? "Reconnect board access" : "Connect board access"}
          </button>
        </div>

        {boardAccess.error ? (
          <p style={{ color: "#991b1b", margin: 0 }}>
            Could not read board access state: {boardAccess.error.message}
          </p>
        ) : null}
      </section>
    </main>
  );
}
