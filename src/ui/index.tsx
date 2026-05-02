import { useEffect, useState } from "react";
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

type TelegramRoutingConfig = {
  defaultChatId: string;
  topicRouting: boolean;
  maxAgentsPerThread: number;
  notifyOnIssueCreated: boolean;
  notifyOnIssueDone: boolean;
  notifyOnIssueAssigned: boolean;
  onlyNotifyIfAssignedTo: string;
  approvalsChatId: string;
  approvalsTopicId: string;
  notifyOnApprovalCreated: boolean;
  onlyNotifyBoardApprovals: boolean;
  errorsChatId: string;
  errorsTopicId: string;
  notifyOnAgentError: boolean;
  notifyOnAgentRunStarted: boolean;
  notifyOnAgentRunFinished: boolean;
  digestChatId: string;
  digestTopicId: string;
  digestMode: "off" | "daily" | "bidaily" | "tridaily";
  dailyDigestTime: string;
  bidailySecondTime: string;
  tridailyTimes: string;
};

type TelegramConnectionConfig = {
  telegramBotTokenRef: string;
  paperclipBaseUrl: string;
  paperclipPublicUrl: string;
};

type TelegramBoardConfig = {
  paperclipBoardApiTokenRef: string;
};

type TelegramAccessConfig = {
  enableCommands: boolean;
  enableInbound: boolean;
  allowedTelegramUserIds: string[];
  allowedTelegramChatIds: string[];
};

type TelegramMediaConfig = {
  transcriptionApiKeyRef: string;
  briefAgentId: string;
  briefAgentChatIds: string[];
};

type TelegramEscalationConfig = {
  escalationChatId: string;
  escalationTimeoutMs: number;
  escalationDefaultAction: "defer" | "auto_reply" | "close";
  escalationHoldMessage: string;
};

type TelegramProactiveConfig = {
  maxSuggestionsPerHourPerCompany: number;
  watchDeduplicationWindowMs: number;
};

type PluginConfigResponse = {
  configJson?: Record<string, unknown> | null;
} | null;

const TELEGRAM_PLUGIN_ID = "paperclip-plugin-telegram";

const DEFAULT_ROUTING_CONFIG: TelegramRoutingConfig = {
  defaultChatId: "",
  topicRouting: false,
  maxAgentsPerThread: 5,
  notifyOnIssueCreated: true,
  notifyOnIssueDone: true,
  notifyOnIssueAssigned: false,
  onlyNotifyIfAssignedTo: "",
  approvalsChatId: "",
  approvalsTopicId: "",
  notifyOnApprovalCreated: true,
  onlyNotifyBoardApprovals: false,
  errorsChatId: "",
  errorsTopicId: "",
  notifyOnAgentError: true,
  notifyOnAgentRunStarted: false,
  notifyOnAgentRunFinished: false,
  digestChatId: "",
  digestTopicId: "",
  digestMode: "off",
  dailyDigestTime: "09:00",
  bidailySecondTime: "17:00",
  tridailyTimes: "07:00,13:00,19:00",
};

const DEFAULT_CONNECTION_CONFIG: TelegramConnectionConfig = {
  telegramBotTokenRef: "",
  paperclipBaseUrl: "http://localhost:3100",
  paperclipPublicUrl: "",
};

const DEFAULT_BOARD_CONFIG: TelegramBoardConfig = {
  paperclipBoardApiTokenRef: "",
};

const DEFAULT_ACCESS_CONFIG: TelegramAccessConfig = {
  enableCommands: true,
  enableInbound: true,
  allowedTelegramUserIds: [],
  allowedTelegramChatIds: [],
};

const DEFAULT_MEDIA_CONFIG: TelegramMediaConfig = {
  transcriptionApiKeyRef: "",
  briefAgentId: "",
  briefAgentChatIds: [],
};

const DEFAULT_ESCALATION_CONFIG: TelegramEscalationConfig = {
  escalationChatId: "",
  escalationTimeoutMs: 900000,
  escalationDefaultAction: "defer",
  escalationHoldMessage: "Let me check on that - I'll get back to you shortly.",
};

const DEFAULT_PROACTIVE_CONFIG: TelegramProactiveConfig = {
  maxSuggestionsPerHourPerCompany: 10,
  watchDeduplicationWindowMs: 86400000,
};

const standardInputStyle = {
  border: "1px solid #d1d5db",
  borderRadius: 8,
  fontSize: 14,
  minWidth: 0,
  padding: "9px 10px",
};

const helperTextStyle = {
  color: "#6b7280",
  fontSize: 12,
  lineHeight: "16px",
};

const twoColumnGridStyle = {
  alignItems: "stretch",
  display: "grid",
  gap: 10,
  gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
};

const pairedFieldStyle = {
  display: "grid",
  gap: 5,
  gridTemplateRows: "auto auto minmax(32px, auto)",
};

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean)
    : [];
}

function asDigestMode(value: unknown): TelegramRoutingConfig["digestMode"] {
  return value === "daily" || value === "bidaily" || value === "tridaily" ? value : "off";
}

function asEscalationDefaultAction(value: unknown): TelegramEscalationConfig["escalationDefaultAction"] {
  return value === "auto_reply" || value === "close" ? value : "defer";
}

function extractRoutingConfig(config: Record<string, unknown>): TelegramRoutingConfig {
  return {
    defaultChatId: asString(config.defaultChatId),
    topicRouting: asBoolean(config.topicRouting, DEFAULT_ROUTING_CONFIG.topicRouting),
    maxAgentsPerThread: asNumber(config.maxAgentsPerThread, DEFAULT_ROUTING_CONFIG.maxAgentsPerThread),
    notifyOnIssueCreated: asBoolean(
      config.notifyOnIssueCreated,
      DEFAULT_ROUTING_CONFIG.notifyOnIssueCreated,
    ),
    notifyOnIssueDone: asBoolean(
      config.notifyOnIssueDone,
      DEFAULT_ROUTING_CONFIG.notifyOnIssueDone,
    ),
    notifyOnIssueAssigned: asBoolean(
      config.notifyOnIssueAssigned,
      DEFAULT_ROUTING_CONFIG.notifyOnIssueAssigned,
    ),
    onlyNotifyIfAssignedTo: asString(config.onlyNotifyIfAssignedTo),
    approvalsChatId: asString(config.approvalsChatId),
    approvalsTopicId: asString(config.approvalsTopicId),
    notifyOnApprovalCreated: asBoolean(
      config.notifyOnApprovalCreated,
      DEFAULT_ROUTING_CONFIG.notifyOnApprovalCreated,
    ),
    onlyNotifyBoardApprovals: asBoolean(
      config.onlyNotifyBoardApprovals,
      DEFAULT_ROUTING_CONFIG.onlyNotifyBoardApprovals,
    ),
    errorsChatId: asString(config.errorsChatId),
    errorsTopicId: asString(config.errorsTopicId),
    notifyOnAgentError: asBoolean(
      config.notifyOnAgentError,
      DEFAULT_ROUTING_CONFIG.notifyOnAgentError,
    ),
    notifyOnAgentRunStarted: asBoolean(
      config.notifyOnAgentRunStarted,
      DEFAULT_ROUTING_CONFIG.notifyOnAgentRunStarted,
    ),
    notifyOnAgentRunFinished: asBoolean(
      config.notifyOnAgentRunFinished,
      DEFAULT_ROUTING_CONFIG.notifyOnAgentRunFinished,
    ),
    digestChatId: asString(config.digestChatId),
    digestTopicId: asString(config.digestTopicId),
    digestMode: asDigestMode(config.digestMode),
    dailyDigestTime: asString(config.dailyDigestTime) || DEFAULT_ROUTING_CONFIG.dailyDigestTime,
    bidailySecondTime: asString(config.bidailySecondTime) || DEFAULT_ROUTING_CONFIG.bidailySecondTime,
    tridailyTimes: asString(config.tridailyTimes) || DEFAULT_ROUTING_CONFIG.tridailyTimes,
  };
}

function extractConnectionConfig(config: Record<string, unknown>): TelegramConnectionConfig {
  return {
    telegramBotTokenRef: asString(config.telegramBotTokenRef),
    paperclipBaseUrl: asString(config.paperclipBaseUrl) || DEFAULT_CONNECTION_CONFIG.paperclipBaseUrl,
    paperclipPublicUrl: asString(config.paperclipPublicUrl),
  };
}

function extractBoardConfig(config: Record<string, unknown>): TelegramBoardConfig {
  return {
    paperclipBoardApiTokenRef: asString(config.paperclipBoardApiTokenRef),
  };
}

function extractAccessConfig(config: Record<string, unknown>): TelegramAccessConfig {
  return {
    enableCommands: asBoolean(config.enableCommands, DEFAULT_ACCESS_CONFIG.enableCommands),
    enableInbound: asBoolean(config.enableInbound, DEFAULT_ACCESS_CONFIG.enableInbound),
    allowedTelegramUserIds: asStringArray(config.allowedTelegramUserIds),
    allowedTelegramChatIds: asStringArray(config.allowedTelegramChatIds),
  };
}

function extractMediaConfig(config: Record<string, unknown>): TelegramMediaConfig {
  return {
    transcriptionApiKeyRef: asString(config.transcriptionApiKeyRef),
    briefAgentId: asString(config.briefAgentId),
    briefAgentChatIds: asStringArray(config.briefAgentChatIds),
  };
}

function extractEscalationConfig(config: Record<string, unknown>): TelegramEscalationConfig {
  return {
    escalationChatId: asString(config.escalationChatId),
    escalationTimeoutMs: asNumber(config.escalationTimeoutMs, DEFAULT_ESCALATION_CONFIG.escalationTimeoutMs),
    escalationDefaultAction: asEscalationDefaultAction(config.escalationDefaultAction),
    escalationHoldMessage: asString(config.escalationHoldMessage) || DEFAULT_ESCALATION_CONFIG.escalationHoldMessage,
  };
}

function extractProactiveConfig(config: Record<string, unknown>): TelegramProactiveConfig {
  return {
    maxSuggestionsPerHourPerCompany: asNumber(
      config.maxSuggestionsPerHourPerCompany,
      DEFAULT_PROACTIVE_CONFIG.maxSuggestionsPerHourPerCompany,
    ),
    watchDeduplicationWindowMs: asNumber(
      config.watchDeduplicationWindowMs,
      DEFAULT_PROACTIVE_CONFIG.watchDeduplicationWindowMs,
    ),
  };
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

async function fetchPluginConfig(): Promise<Record<string, unknown>> {
  const record = await fetchHostJson<PluginConfigResponse>(
    `/api/plugins/${encodeURIComponent(TELEGRAM_PLUGIN_ID)}/config`,
  );
  return record?.configJson && typeof record.configJson === "object" ? record.configJson : {};
}

async function savePluginConfig(configJson: Record<string, unknown>): Promise<void> {
  await fetchHostJson(`/api/plugins/${encodeURIComponent(TELEGRAM_PLUGIN_ID)}/config`, {
    method: "POST",
    body: JSON.stringify({ configJson }),
  });
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
  const [routingConfig, setRoutingConfig] = useState<TelegramRoutingConfig>(DEFAULT_ROUTING_CONFIG);
  const [routingSnapshot, setRoutingSnapshot] = useState<TelegramRoutingConfig>(DEFAULT_ROUTING_CONFIG);
  const [routingLoading, setRoutingLoading] = useState(true);
  const [routingSaving, setRoutingSaving] = useState(false);
  const [routingMessage, setRoutingMessage] = useState<Notice | null>(null);
  const [connectionConfig, setConnectionConfig] = useState<TelegramConnectionConfig>(DEFAULT_CONNECTION_CONFIG);
  const [connectionSnapshot, setConnectionSnapshot] = useState<TelegramConnectionConfig>(DEFAULT_CONNECTION_CONFIG);
  const [connectionLoading, setConnectionLoading] = useState(true);
  const [connectionSaving, setConnectionSaving] = useState(false);
  const [connectionMessage, setConnectionMessage] = useState<Notice | null>(null);
  const [boardConfig, setBoardConfig] = useState<TelegramBoardConfig>(DEFAULT_BOARD_CONFIG);
  const [boardSnapshot, setBoardSnapshot] = useState<TelegramBoardConfig>(DEFAULT_BOARD_CONFIG);
  const [boardConfigLoading, setBoardConfigLoading] = useState(true);
  const [boardConfigSaving, setBoardConfigSaving] = useState(false);
  const [boardConfigMessage, setBoardConfigMessage] = useState<Notice | null>(null);
  const [accessConfig, setAccessConfig] = useState<TelegramAccessConfig>(DEFAULT_ACCESS_CONFIG);
  const [accessSnapshot, setAccessSnapshot] = useState<TelegramAccessConfig>(DEFAULT_ACCESS_CONFIG);
  const [accessLoading, setAccessLoading] = useState(true);
  const [accessSaving, setAccessSaving] = useState(false);
  const [accessMessage, setAccessMessage] = useState<Notice | null>(null);
  const [mediaConfig, setMediaConfig] = useState<TelegramMediaConfig>(DEFAULT_MEDIA_CONFIG);
  const [mediaSnapshot, setMediaSnapshot] = useState<TelegramMediaConfig>(DEFAULT_MEDIA_CONFIG);
  const [mediaLoading, setMediaLoading] = useState(true);
  const [mediaSaving, setMediaSaving] = useState(false);
  const [mediaMessage, setMediaMessage] = useState<Notice | null>(null);
  const [escalationConfig, setEscalationConfig] = useState<TelegramEscalationConfig>(DEFAULT_ESCALATION_CONFIG);
  const [escalationSnapshot, setEscalationSnapshot] = useState<TelegramEscalationConfig>(DEFAULT_ESCALATION_CONFIG);
  const [escalationLoading, setEscalationLoading] = useState(true);
  const [escalationSaving, setEscalationSaving] = useState(false);
  const [escalationMessage, setEscalationMessage] = useState<Notice | null>(null);
  const [proactiveConfig, setProactiveConfig] = useState<TelegramProactiveConfig>(DEFAULT_PROACTIVE_CONFIG);
  const [proactiveSnapshot, setProactiveSnapshot] = useState<TelegramProactiveConfig>(DEFAULT_PROACTIVE_CONFIG);
  const [proactiveLoading, setProactiveLoading] = useState(true);
  const [proactiveSaving, setProactiveSaving] = useState(false);
  const [proactiveMessage, setProactiveMessage] = useState<Notice | null>(null);
  const companyId = context.companyId ?? "";
  const companyLabel = context.companyPrefix?.trim() || "this company";
  const configured = Boolean(boardAccess.data?.configured);
  const identity = boardAccess.data?.identity?.trim() || null;
  const routingDirty = JSON.stringify(routingConfig) !== JSON.stringify(routingSnapshot);
  const connectionDirty = JSON.stringify(connectionConfig) !== JSON.stringify(connectionSnapshot);
  const boardConfigDirty = JSON.stringify(boardConfig) !== JSON.stringify(boardSnapshot);
  const accessDirty = JSON.stringify(accessConfig) !== JSON.stringify(accessSnapshot);
  const mediaDirty = JSON.stringify(mediaConfig) !== JSON.stringify(mediaSnapshot);
  const escalationDirty = JSON.stringify(escalationConfig) !== JSON.stringify(escalationSnapshot);
  const proactiveDirty = JSON.stringify(proactiveConfig) !== JSON.stringify(proactiveSnapshot);

  useEffect(() => {
    let cancelled = false;

    async function loadRoutingConfig(): Promise<void> {
      setRoutingLoading(true);
      setRoutingMessage(null);
      try {
        const config = await fetchPluginConfig();
        if (cancelled) return;
        const nextRoutingConfig = extractRoutingConfig(config);
        setRoutingConfig(nextRoutingConfig);
        setRoutingSnapshot(nextRoutingConfig);
      } catch (error) {
        if (!cancelled) {
          setRoutingMessage({
            tone: "error",
            title: "Routing settings could not be loaded",
            text: getErrorMessage(error),
          });
        }
      } finally {
        if (!cancelled) {
          setRoutingLoading(false);
        }
      }
    }

    void loadRoutingConfig();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadProactiveConfig(): Promise<void> {
      setProactiveLoading(true);
      setProactiveMessage(null);
      try {
        const config = await fetchPluginConfig();
        if (cancelled) return;
        const nextProactiveConfig = extractProactiveConfig(config);
        setProactiveConfig(nextProactiveConfig);
        setProactiveSnapshot(nextProactiveConfig);
      } catch (error) {
        if (!cancelled) {
          setProactiveMessage({
            tone: "error",
            title: "Proactive suggestion settings could not be loaded",
            text: getErrorMessage(error),
          });
        }
      } finally {
        if (!cancelled) {
          setProactiveLoading(false);
        }
      }
    }

    void loadProactiveConfig();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadEscalationConfig(): Promise<void> {
      setEscalationLoading(true);
      setEscalationMessage(null);
      try {
        const config = await fetchPluginConfig();
        if (cancelled) return;
        const nextEscalationConfig = extractEscalationConfig(config);
        setEscalationConfig(nextEscalationConfig);
        setEscalationSnapshot(nextEscalationConfig);
      } catch (error) {
        if (!cancelled) {
          setEscalationMessage({
            tone: "error",
            title: "Human escalation settings could not be loaded",
            text: getErrorMessage(error),
          });
        }
      } finally {
        if (!cancelled) {
          setEscalationLoading(false);
        }
      }
    }

    void loadEscalationConfig();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadMediaConfig(): Promise<void> {
      setMediaLoading(true);
      setMediaMessage(null);
      try {
        const config = await fetchPluginConfig();
        if (cancelled) return;
        const nextMediaConfig = extractMediaConfig(config);
        setMediaConfig(nextMediaConfig);
        setMediaSnapshot(nextMediaConfig);
      } catch (error) {
        if (!cancelled) {
          setMediaMessage({
            tone: "error",
            title: "Media intake settings could not be loaded",
            text: getErrorMessage(error),
          });
        }
      } finally {
        if (!cancelled) {
          setMediaLoading(false);
        }
      }
    }

    void loadMediaConfig();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadAccessConfig(): Promise<void> {
      setAccessLoading(true);
      setAccessMessage(null);
      try {
        const config = await fetchPluginConfig();
        if (cancelled) return;
        const nextAccessConfig = extractAccessConfig(config);
        setAccessConfig(nextAccessConfig);
        setAccessSnapshot(nextAccessConfig);
      } catch (error) {
        if (!cancelled) {
          setAccessMessage({
            tone: "error",
            title: "Access settings could not be loaded",
            text: getErrorMessage(error),
          });
        }
      } finally {
        if (!cancelled) {
          setAccessLoading(false);
        }
      }
    }

    void loadAccessConfig();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadConnectionConfig(): Promise<void> {
      setConnectionLoading(true);
      setConnectionMessage(null);
      try {
        const config = await fetchPluginConfig();
        if (cancelled) return;
        const nextConnectionConfig = extractConnectionConfig(config);
        setConnectionConfig(nextConnectionConfig);
        setConnectionSnapshot(nextConnectionConfig);
      } catch (error) {
        if (!cancelled) {
          setConnectionMessage({
            tone: "error",
            title: "Connection settings could not be loaded",
            text: getErrorMessage(error),
          });
        }
      } finally {
        if (!cancelled) {
          setConnectionLoading(false);
        }
      }
    }

    void loadConnectionConfig();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadBoardConfig(): Promise<void> {
      setBoardConfigLoading(true);
      setBoardConfigMessage(null);
      try {
        const config = await fetchPluginConfig();
        if (cancelled) return;
        const nextBoardConfig = extractBoardConfig(config);
        setBoardConfig(nextBoardConfig);
        setBoardSnapshot(nextBoardConfig);
      } catch (error) {
        if (!cancelled) {
          setBoardConfigMessage({
            tone: "error",
            title: "Board fallback setting could not be loaded",
            text: getErrorMessage(error),
          });
        }
      } finally {
        if (!cancelled) {
          setBoardConfigLoading(false);
        }
      }
    }

    void loadBoardConfig();

    return () => {
      cancelled = true;
    };
  }, []);

  function updateRoutingField<K extends keyof TelegramRoutingConfig>(
    key: K,
    value: TelegramRoutingConfig[K],
  ): void {
    setRoutingConfig((current) => ({ ...current, [key]: value }));
    setRoutingMessage(null);
  }

  function updateBoardField<K extends keyof TelegramBoardConfig>(
    key: K,
    value: TelegramBoardConfig[K],
  ): void {
    setBoardConfig((current) => ({ ...current, [key]: value }));
    setBoardConfigMessage(null);
  }

  function updateAccessField<K extends keyof TelegramAccessConfig>(
    key: K,
    value: TelegramAccessConfig[K],
  ): void {
    setAccessConfig((current) => ({ ...current, [key]: value }));
    setAccessMessage(null);
  }

  function updateConnectionField<K extends keyof TelegramConnectionConfig>(
    key: K,
    value: TelegramConnectionConfig[K],
  ): void {
    setConnectionConfig((current) => ({ ...current, [key]: value }));
    setConnectionMessage(null);
  }

  function updateMediaField<K extends keyof TelegramMediaConfig>(
    key: K,
    value: TelegramMediaConfig[K],
  ): void {
    setMediaConfig((current) => ({ ...current, [key]: value }));
    setMediaMessage(null);
  }

  function updateEscalationField<K extends keyof TelegramEscalationConfig>(
    key: K,
    value: TelegramEscalationConfig[K],
  ): void {
    setEscalationConfig((current) => ({ ...current, [key]: value }));
    setEscalationMessage(null);
  }

  function updateProactiveField<K extends keyof TelegramProactiveConfig>(
    key: K,
    value: TelegramProactiveConfig[K],
  ): void {
    setProactiveConfig((current) => ({ ...current, [key]: value }));
    setProactiveMessage(null);
  }

  async function handleSaveBoardConfig(): Promise<void> {
    setBoardConfigSaving(true);
    setBoardConfigMessage(null);
    try {
      const currentConfig = await fetchPluginConfig();
      const nextConfig = { ...currentConfig, ...boardConfig };
      await savePluginConfig(nextConfig);
      setBoardSnapshot(boardConfig);
      setBoardConfigMessage({
        tone: "success",
        title: "Board fallback saved",
        text: "The connection workflow remains preferred. This secret reference is used only as a manual fallback.",
      });
    } catch (error) {
      setBoardConfigMessage({
        tone: "error",
        title: "Board fallback could not be saved",
        text: getErrorMessage(error),
      });
    } finally {
      setBoardConfigSaving(false);
    }
  }

  async function handleSaveAccessConfig(): Promise<void> {
    setAccessSaving(true);
    setAccessMessage(null);
    try {
      const currentConfig = await fetchPluginConfig();
      const nextConfig = { ...currentConfig, ...accessConfig };
      await savePluginConfig(nextConfig);
      setAccessSnapshot(accessConfig);
      setAccessMessage({
        tone: "success",
        title: "Bot access settings saved",
        text: "If the worker has already cached Telegram updates, restart the plugin if the new allowlist behavior is not picked up immediately.",
      });
    } catch (error) {
      setAccessMessage({
        tone: "error",
        title: "Bot access settings could not be saved",
        text: getErrorMessage(error),
      });
    } finally {
      setAccessSaving(false);
    }
  }

  async function handleSaveRoutingConfig(): Promise<void> {
    setRoutingSaving(true);
    setRoutingMessage(null);
    try {
      const currentConfig = await fetchPluginConfig();
      const nextConfig = { ...currentConfig, ...routingConfig };
      await savePluginConfig(nextConfig);
      setRoutingSnapshot(routingConfig);
      setRoutingMessage({
        tone: "success",
        title: "Notification routing saved",
        text: "Refresh the page if another browser tab edited these settings at the same time.",
      });
    } catch (error) {
      setRoutingMessage({
        tone: "error",
        title: "Notification routing could not be saved",
        text: getErrorMessage(error),
      });
    } finally {
      setRoutingSaving(false);
    }
  }

  async function handleSaveConnectionConfig(): Promise<void> {
    setConnectionSaving(true);
    setConnectionMessage(null);
    try {
      const currentConfig = await fetchPluginConfig();
      const nextConfig = { ...currentConfig, ...connectionConfig };
      await savePluginConfig(nextConfig);
      setConnectionSnapshot(connectionConfig);
      setConnectionMessage({
        tone: "success",
        title: "Connection settings saved",
        text: "These settings control the bot token and the Paperclip URLs used by Telegram messages and approval actions.",
      });
    } catch (error) {
      setConnectionMessage({
        tone: "error",
        title: "Connection settings could not be saved",
        text: getErrorMessage(error),
      });
    } finally {
      setConnectionSaving(false);
    }
  }

  async function handleSaveMediaConfig(): Promise<void> {
    setMediaSaving(true);
    setMediaMessage(null);
    try {
      const currentConfig = await fetchPluginConfig();
      const nextConfig = { ...currentConfig, ...mediaConfig };
      await savePluginConfig(nextConfig);
      setMediaSnapshot(mediaConfig);
      setMediaMessage({
        tone: "success",
        title: "Media intake settings saved",
        text: "Media in configured intake chats is routed to the Brief Agent. Media in other chats can still go to active topic agent sessions.",
      });
    } catch (error) {
      setMediaMessage({
        tone: "error",
        title: "Media intake settings could not be saved",
        text: getErrorMessage(error),
      });
    } finally {
      setMediaSaving(false);
    }
  }

  async function handleSaveEscalationConfig(): Promise<void> {
    setEscalationSaving(true);
    setEscalationMessage(null);
    try {
      const currentConfig = await fetchPluginConfig();
      const nextConfig = { ...currentConfig, ...escalationConfig };
      await savePluginConfig(nextConfig);
      setEscalationSnapshot(escalationConfig);
      setEscalationMessage({
        tone: "success",
        title: "Human escalation settings saved",
        text: "Escalations are sent to the configured Telegram chat when an agent invokes the human handoff tool.",
      });
    } catch (error) {
      setEscalationMessage({
        tone: "error",
        title: "Human escalation settings could not be saved",
        text: getErrorMessage(error),
      });
    } finally {
      setEscalationSaving(false);
    }
  }

  async function handleSaveProactiveConfig(): Promise<void> {
    setProactiveSaving(true);
    setProactiveMessage(null);
    try {
      const currentConfig = await fetchPluginConfig();
      const nextConfig = { ...currentConfig, ...proactiveConfig };
      await savePluginConfig(nextConfig);
      setProactiveSnapshot(proactiveConfig);
      setProactiveMessage({
        tone: "success",
        title: "Proactive suggestion settings saved",
        text: "These limits apply when the scheduled watch job evaluates registered watches and sends Telegram suggestions.",
      });
    } catch (error) {
      setProactiveMessage({
        tone: "error",
        title: "Proactive suggestion settings could not be saved",
        text: getErrorMessage(error),
      });
    } finally {
      setProactiveSaving(false);
    }
  }

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
          Configure Telegram connection, access control, notification routing, media intake, escalation, and proactive suggestion behavior.
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
        <div style={{ display: "grid", gap: 4 }}>
          <h2 style={{ fontSize: 18, fontWeight: 700, lineHeight: "28px", margin: 0 }}>Connection & URLs</h2>
          <p style={{ color: "#6b7280", margin: 0 }}>
            Core connection values used by the Telegram worker. Save the bot token as a Paperclip secret and paste its secret UUID here.
          </p>
        </div>

        <div style={{ display: "grid", gap: 12 }}>
          <TextField
            disabled={connectionLoading || connectionSaving}
            label="Telegram bot token secret ref"
            onChange={(value) => updateConnectionField("telegramBotTokenRef", value)}
            placeholder="Secret UUID from Paperclip settings"
            value={connectionConfig.telegramBotTokenRef}
          >
            Secret UUID for your Telegram bot token from @BotFather. The plugin resolves this secret before polling Telegram.
          </TextField>
          <TextField
            disabled={connectionLoading || connectionSaving}
            label="Paperclip API URL"
            onChange={(value) => updateConnectionField("paperclipBaseUrl", value)}
            placeholder="http://localhost:3100"
            value={connectionConfig.paperclipBaseUrl}
          >
            Internal Paperclip API URL used by the plugin for actions such as approvals and comments. Keep localhost for same-server deployments.
          </TextField>
          <TextField
            disabled={connectionLoading || connectionSaving}
            label="Paperclip public URL"
            onChange={(value) => updateConnectionField("paperclipPublicUrl", value)}
            placeholder="https://paperclip.example.com"
            value={connectionConfig.paperclipPublicUrl}
          >
            Public URL used in Telegram links. Leave empty to fall back to the API URL.
          </TextField>
        </div>

        {connectionMessage ? <NoticeBlock notice={connectionMessage} /> : null}

        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button
            disabled={connectionLoading || connectionSaving}
            onClick={() => {
              setConnectionConfig(connectionSnapshot);
              setConnectionMessage(null);
            }}
            style={{
              background: "white",
              border: "1px solid #d1d5db",
              borderRadius: 8,
              color: "#374151",
              cursor: connectionLoading || connectionSaving ? "not-allowed" : "pointer",
              fontWeight: 700,
              padding: "10px 14px",
            }}
            type="button"
          >
            Reset
          </button>
          <button
            disabled={connectionLoading || connectionSaving || !connectionDirty}
            onClick={() => {
              void handleSaveConnectionConfig();
            }}
            style={{
              background: connectionLoading || connectionSaving || !connectionDirty ? "#9ca3af" : "#111827",
              border: 0,
              borderRadius: 8,
              color: "white",
              cursor: connectionLoading || connectionSaving || !connectionDirty ? "not-allowed" : "pointer",
              fontWeight: 700,
              minWidth: 160,
              padding: "10px 14px",
            }}
            type="button"
          >
            {connectionSaving ? "Saving..." : "Save connection"}
          </button>
        </div>
      </section>

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
            <h2 style={{ fontSize: 18, fontWeight: 700, lineHeight: "28px", margin: 0 }}>Board Access Connection</h2>
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

        <div style={{ borderTop: "1px solid #e5e7eb", display: "grid", gap: 12, paddingTop: 14 }}>
          <TextField
            disabled={boardConfigLoading || boardConfigSaving}
            label="Board API token secret ref fallback"
            onChange={(value) => updateBoardField("paperclipBoardApiTokenRef", value)}
            placeholder="Optional Paperclip secret UUID"
            value={boardConfig.paperclipBoardApiTokenRef}
          >
            Optional manual fallback for approval buttons and /approve. The Board Access Connection above is preferred because it creates and tracks the company-scoped secret for you.
          </TextField>

          {boardConfigMessage ? <NoticeBlock notice={boardConfigMessage} /> : null}

          <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
            <button
              disabled={boardConfigLoading || boardConfigSaving}
              onClick={() => {
                setBoardConfig(boardSnapshot);
                setBoardConfigMessage(null);
              }}
              style={{
                background: "white",
                border: "1px solid #d1d5db",
                borderRadius: 8,
                color: "#374151",
                cursor: boardConfigLoading || boardConfigSaving ? "not-allowed" : "pointer",
                fontWeight: 700,
                padding: "10px 14px",
              }}
              type="button"
            >
              Reset
            </button>
            <button
              disabled={boardConfigLoading || boardConfigSaving || !boardConfigDirty}
              onClick={() => {
                void handleSaveBoardConfig();
              }}
              style={{
                background: boardConfigLoading || boardConfigSaving || !boardConfigDirty ? "#9ca3af" : "#111827",
                border: 0,
                borderRadius: 8,
                color: "white",
                cursor: boardConfigLoading || boardConfigSaving || !boardConfigDirty ? "not-allowed" : "pointer",
                fontWeight: 700,
                minWidth: 160,
                padding: "10px 14px",
              }}
              type="button"
            >
              {boardConfigSaving ? "Saving..." : "Save fallback"}
            </button>
          </div>
        </div>

        {boardAccess.error ? (
          <p style={{ color: "#991b1b", margin: 0 }}>
            Could not read board access state: {boardAccess.error.message}
          </p>
        ) : null}
      </section>

      <section
        style={{
          border: "1px solid #e5e7eb",
          borderRadius: 8,
          display: "grid",
          gap: 18,
          padding: 18,
        }}
      >
        <div style={{ display: "grid", gap: 4 }}>
          <h2 style={{ fontSize: 18, fontWeight: 700, lineHeight: "28px", margin: 0 }}>Bot Interaction & Access Control</h2>
          <p style={{ color: "#6b7280", margin: 0 }}>
            Controls who can use the bot interactively. Empty allowlists are permissive; set both user and chat IDs for strict private-group access.
          </p>
        </div>

        <div style={{ display: "grid", gap: 12 }}>
          <CheckboxField
            checked={accessConfig.enableCommands}
            disabled={accessLoading || accessSaving}
            label="Enable bot commands"
            onChange={(value) => updateAccessField("enableCommands", value)}
          >
            Allow Telegram users to run commands such as /status, /issues, and /agents. Use allowlists when commands are enabled.
          </CheckboxField>
          <CheckboxField
            checked={accessConfig.enableInbound}
            disabled={accessLoading || accessSaving}
            label="Enable inbound replies"
            onChange={(value) => updateAccessField("enableInbound", value)}
          >
            Route Telegram replies to Paperclip issue comments when a message replies to a bot notification. Use allowlists when inbound replies are enabled.
          </CheckboxField>
          <ArrayField
            disabled={accessLoading || accessSaving}
            emptyValueLabel="No user IDs configured"
            label="Allowed Telegram user IDs"
            newItemLabel="Add user ID"
            onChange={(value) => updateAccessField("allowedTelegramUserIds", value)}
            placeholder="6395513943"
            value={accessConfig.allowedTelegramUserIds}
          >
            Optional. One Telegram user ID per line. Leave empty to allow any user. Applies to commands, inbound replies, media intake, and button callbacks.
          </ArrayField>
          <ArrayField
            disabled={accessLoading || accessSaving}
            emptyValueLabel="No chat IDs configured"
            label="Allowed Telegram chat IDs"
            newItemLabel="Add chat ID"
            onChange={(value) => updateAccessField("allowedTelegramChatIds", value)}
            placeholder="-1003800613668"
            value={accessConfig.allowedTelegramChatIds}
          >
            Optional. One chat ID per line. Use private DM IDs and/or private group IDs. If both user and chat allowlists are set, both must match.
          </ArrayField>
        </div>

        {accessMessage ? <NoticeBlock notice={accessMessage} /> : null}

        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button
            disabled={accessLoading || accessSaving}
            onClick={() => {
              setAccessConfig(accessSnapshot);
              setAccessMessage(null);
            }}
            style={{
              background: "white",
              border: "1px solid #d1d5db",
              borderRadius: 8,
              color: "#374151",
              cursor: accessLoading || accessSaving ? "not-allowed" : "pointer",
              fontWeight: 700,
              padding: "10px 14px",
            }}
            type="button"
          >
            Reset
          </button>
          <button
            disabled={accessLoading || accessSaving || !accessDirty}
            onClick={() => {
              void handleSaveAccessConfig();
            }}
            style={{
              background: accessLoading || accessSaving || !accessDirty ? "#9ca3af" : "#111827",
              border: 0,
              borderRadius: 8,
              color: "white",
              cursor: accessLoading || accessSaving || !accessDirty ? "not-allowed" : "pointer",
              fontWeight: 700,
              minWidth: 160,
              padding: "10px 14px",
            }}
            type="button"
          >
            {accessSaving ? "Saving..." : "Save access"}
          </button>
        </div>
      </section>

      <section
        style={{
          border: "1px solid #e5e7eb",
          borderRadius: 8,
          display: "grid",
          gap: 18,
          padding: 18,
        }}
      >
        <div style={{ display: "grid", gap: 4 }}>
          <h2 style={{ fontSize: 18, fontWeight: 700, lineHeight: "28px", margin: 0 }}>Notification Routing & Forum Topics</h2>
          <p style={{ color: "#6b7280", margin: 0 }}>
            Grouped operational destinations. Empty Chat IDs fall back to the default route; Topic IDs are optional and only apply inside the matching Telegram forum group.
          </p>
        </div>

        <div style={{ display: "grid", gap: 12 }}>
          <section
            style={{
              border: "1px solid #e5e7eb",
              borderRadius: 8,
              display: "grid",
              gap: 10,
              padding: 12,
            }}
          >
            <strong>Default route</strong>
            <label style={{ display: "grid", gap: 5 }}>
              <span style={{ color: "#4b5563", fontSize: 12, fontWeight: 700 }}>Fallback Chat ID</span>
              <input
                disabled={routingLoading || routingSaving}
                onChange={(event) => updateRoutingField("defaultChatId", event.currentTarget.value)}
                placeholder="Default chat ID"
                style={{
                  border: "1px solid #d1d5db",
                  borderRadius: 8,
                  fontSize: 14,
                  minWidth: 0,
                  padding: "9px 10px",
                }}
                type="text"
                value={routingConfig.defaultChatId}
              />
              <span style={{ color: "#6b7280", fontSize: 12 }}>
                Used when a notification type leaves its Chat ID empty and no company-specific chat is connected.
              </span>
            </label>
            <label style={{ color: "#374151", display: "grid", gap: 3, fontSize: 13 }}>
              <span style={{ alignItems: "center", display: "flex", gap: 8 }}>
                <input
                  checked={routingConfig.topicRouting}
                  disabled={routingLoading || routingSaving}
                  onChange={(event) => updateRoutingField("topicRouting", event.currentTarget.checked)}
                  type="checkbox"
                />
                Forum topic routing
              </span>
              <span style={{ color: "#6b7280", fontSize: 12, marginLeft: 22 }}>
                Route project-linked notifications to Telegram forum topics mapped with /connect_topic.
              </span>
            </label>
            <label style={{ display: "grid", gap: 5 }}>
              <span style={{ color: "#4b5563", fontSize: 12, fontWeight: 700 }}>Max agents per forum topic</span>
              <input
                disabled={routingLoading || routingSaving}
                min={1}
                onChange={(event) => updateRoutingField("maxAgentsPerThread", Number(event.currentTarget.value))}
                placeholder="3"
                style={{
                  border: "1px solid #d1d5db",
                  borderRadius: 8,
                  fontSize: 14,
                  maxWidth: 180,
                  minWidth: 0,
                  padding: "9px 10px",
                }}
                type="number"
                value={routingConfig.maxAgentsPerThread}
              />
              <span style={{ color: "#6b7280", fontSize: 12 }}>
                Maximum concurrent agent sessions allowed inside one Telegram forum topic. This applies to /acp agent sessions, not notification delivery.
              </span>
            </label>
          </section>

          <section
            style={{
              border: "1px solid #e5e7eb",
              borderRadius: 8,
              display: "grid",
              gap: 10,
              padding: 12,
            }}
          >
            <strong>Issues</strong>
            <div style={{ display: "grid", gap: 10 }}>
              <label style={{ color: "#374151", display: "grid", gap: 3, fontSize: 13 }}>
                <span style={{ alignItems: "center", display: "flex", gap: 8 }}>
                  <input
                    checked={routingConfig.notifyOnIssueCreated}
                    disabled={routingLoading || routingSaving}
                    onChange={(event) => updateRoutingField("notifyOnIssueCreated", event.currentTarget.checked)}
                    type="checkbox"
                  />
                  Created
                </span>
                <span style={{ color: "#6b7280", fontSize: 12, marginLeft: 22 }}>
                  Send a Telegram notification when a new issue is created.
                </span>
              </label>
              <label style={{ color: "#374151", display: "grid", gap: 3, fontSize: 13 }}>
                <span style={{ alignItems: "center", display: "flex", gap: 8 }}>
                  <input
                    checked={routingConfig.notifyOnIssueDone}
                    disabled={routingLoading || routingSaving}
                    onChange={(event) => updateRoutingField("notifyOnIssueDone", event.currentTarget.checked)}
                    type="checkbox"
                  />
                  Completed
                </span>
                <span style={{ color: "#6b7280", fontSize: 12, marginLeft: 22 }}>
                  Send a Telegram notification when an issue is completed.
                </span>
              </label>
              <label style={{ color: "#374151", display: "grid", gap: 3, fontSize: 13 }}>
                <span style={{ alignItems: "center", display: "flex", gap: 8 }}>
                  <input
                    checked={routingConfig.notifyOnIssueAssigned}
                    disabled={routingLoading || routingSaving}
                    onChange={(event) => updateRoutingField("notifyOnIssueAssigned", event.currentTarget.checked)}
                    type="checkbox"
                  />
                  Assignment changes
                </span>
                <span style={{ color: "#6b7280", fontSize: 12, marginLeft: 22 }}>
                  Send a Telegram notification when an issue assignee changes.
                </span>
              </label>
            </div>
            <label style={{ display: "grid", gap: 5 }}>
              <span style={{ color: "#4b5563", fontSize: 12, fontWeight: 700 }}>Only when assigned to user ID</span>
              <input
                disabled={routingLoading || routingSaving}
                onChange={(event) => updateRoutingField("onlyNotifyIfAssignedTo", event.currentTarget.value)}
                placeholder="Paperclip user ID"
                style={{
                  border: "1px solid #d1d5db",
                  borderRadius: 8,
                  fontSize: 14,
                  minWidth: 0,
                  padding: "9px 10px",
                }}
                type="text"
                value={routingConfig.onlyNotifyIfAssignedTo}
              />
              <span style={{ color: "#6b7280", fontSize: 12 }}>
                Optional. Restricts assignment-change notifications to issues assigned to this Paperclip user.
              </span>
            </label>
          </section>

          <RoutingRow
            title="Approvals"
            chatId={routingConfig.approvalsChatId}
            topicId={routingConfig.approvalsTopicId}
            chatPlaceholder="Approvals chat ID"
            topicPlaceholder="Approvals topic ID"
            disabled={routingLoading || routingSaving}
            onChatIdChange={(value) => updateRoutingField("approvalsChatId", value)}
            onTopicIdChange={(value) => updateRoutingField("approvalsTopicId", value)}
            chatHelp="Leave empty to use the default route for approval notifications."
            footer={
              <>
                <label style={{ color: "#374151", display: "grid", gap: 3, fontSize: 13 }}>
                  <span style={{ alignItems: "center", display: "flex", gap: 8 }}>
                    <input
                      checked={routingConfig.notifyOnApprovalCreated}
                      disabled={routingLoading || routingSaving}
                      onChange={(event) => updateRoutingField("notifyOnApprovalCreated", event.currentTarget.checked)}
                      type="checkbox"
                    />
                    Enabled
                  </span>
                  <span style={{ color: "#6b7280", fontSize: 12, marginLeft: 22 }}>
                    Send Telegram notifications when approval requests are created.
                  </span>
                </label>
                <label style={{ color: "#374151", display: "grid", gap: 3, fontSize: 13 }}>
                  <span style={{ alignItems: "center", display: "flex", gap: 8 }}>
                    <input
                      checked={routingConfig.onlyNotifyBoardApprovals}
                      disabled={routingLoading || routingSaving}
                      onChange={(event) => updateRoutingField("onlyNotifyBoardApprovals", event.currentTarget.checked)}
                      type="checkbox"
                    />
                    Board requests only
                  </span>
                  <span style={{ color: "#6b7280", fontSize: 12, marginLeft: 22 }}>
                    Ignore internal approvals and notify only when an agent requests Board approval.
                  </span>
                </label>
              </>
            }
          />

          <RoutingRow
            title="Errors"
            chatId={routingConfig.errorsChatId}
            topicId={routingConfig.errorsTopicId}
            chatPlaceholder="Errors chat ID"
            topicPlaceholder="Errors topic ID"
            disabled={routingLoading || routingSaving}
            onChatIdChange={(value) => updateRoutingField("errorsChatId", value)}
            onTopicIdChange={(value) => updateRoutingField("errorsTopicId", value)}
            chatHelp="Leave empty to use the default route for agent error notifications."
            footer={
              <>
                <label style={{ color: "#374151", display: "grid", gap: 3, fontSize: 13 }}>
                  <span style={{ alignItems: "center", display: "flex", gap: 8 }}>
                    <input
                      checked={routingConfig.notifyOnAgentError}
                      disabled={routingLoading || routingSaving}
                      onChange={(event) => updateRoutingField("notifyOnAgentError", event.currentTarget.checked)}
                      type="checkbox"
                    />
                    Errors enabled
                  </span>
                  <span style={{ color: "#6b7280", fontSize: 12, marginLeft: 22 }}>
                    Send Telegram notifications when an agent run reports an error.
                  </span>
                </label>
                <label style={{ color: "#374151", display: "grid", gap: 3, fontSize: 13 }}>
                  <span style={{ alignItems: "center", display: "flex", gap: 8 }}>
                    <input
                      checked={routingConfig.notifyOnAgentRunStarted}
                      disabled={routingLoading || routingSaving}
                      onChange={(event) => updateRoutingField("notifyOnAgentRunStarted", event.currentTarget.checked)}
                      type="checkbox"
                    />
                    Run started
                  </span>
                  <span style={{ color: "#6b7280", fontSize: 12, marginLeft: 22 }}>
                    Notify on every agent run start. Off by default - high-frequency on busy instances. Routes through the default chat.
                  </span>
                </label>
                <label style={{ color: "#374151", display: "grid", gap: 3, fontSize: 13 }}>
                  <span style={{ alignItems: "center", display: "flex", gap: 8 }}>
                    <input
                      checked={routingConfig.notifyOnAgentRunFinished}
                      disabled={routingLoading || routingSaving}
                      onChange={(event) => updateRoutingField("notifyOnAgentRunFinished", event.currentTarget.checked)}
                      type="checkbox"
                    />
                    Run finished
                  </span>
                  <span style={{ color: "#6b7280", fontSize: 12, marginLeft: 22 }}>
                    Notify on every agent run completion. Off by default - high-frequency on busy instances. Routes through the default chat.
                  </span>
                </label>
              </>
            }
          />

          <RoutingRow
            title="Digests"
            chatId={routingConfig.digestChatId}
            topicId={routingConfig.digestTopicId}
            chatPlaceholder="Digest chat ID"
            topicPlaceholder="Digest topic ID"
            disabled={routingLoading || routingSaving}
            onChatIdChange={(value) => updateRoutingField("digestChatId", value)}
            onTopicIdChange={(value) => updateRoutingField("digestTopicId", value)}
            chatHelp="Leave empty to use the company/default route for digest notifications."
            footer={
              <div style={{ display: "grid", gap: 10 }}>
                <label style={{ display: "grid", gap: 6 }}>
                  <span style={{ color: "#4b5563", fontSize: 12, fontWeight: 700 }}>Mode</span>
                  <select
                    disabled={routingLoading || routingSaving}
                    onChange={(event) => updateRoutingField("digestMode", event.currentTarget.value as TelegramRoutingConfig["digestMode"])}
                    style={{
                      border: "1px solid #d1d5db",
                      borderRadius: 8,
                      fontSize: 14,
                      maxWidth: 280,
                      padding: "9px 10px",
                    }}
                    value={routingConfig.digestMode}
                  >
                    <option value="off">Off</option>
                    <option value="daily">Daily</option>
                    <option value="bidaily">Bidaily</option>
                    <option value="tridaily">Tridaily</option>
                  </select>
                  <span style={{ color: "#6b7280", fontSize: 12 }}>
                    Off disables digest notifications. Times are UTC.
                  </span>
                </label>
                <div style={{ alignItems: "stretch", display: "grid", gap: 10, gridTemplateColumns: "repeat(3, minmax(0, 1fr))" }}>
                  <label style={{ display: "grid", gap: 5, gridTemplateRows: "auto auto minmax(32px, auto)" }}>
                    <span style={{ color: "#4b5563", fontSize: 12, fontWeight: 700 }}>Daily time</span>
                    <input
                      disabled={routingLoading || routingSaving}
                      onChange={(event) => updateRoutingField("dailyDigestTime", event.currentTarget.value)}
                      placeholder="09:00"
                      style={{
                        border: "1px solid #d1d5db",
                        borderRadius: 8,
                        fontSize: 14,
                        minWidth: 0,
                        padding: "9px 10px",
                      }}
                      type="text"
                      value={routingConfig.dailyDigestTime}
                    />
                    <span style={{ color: "#6b7280", fontSize: 12, lineHeight: "16px" }}>
                      Used for daily mode and as the first bidaily slot.
                    </span>
                  </label>
                  <label style={{ display: "grid", gap: 5, gridTemplateRows: "auto auto minmax(32px, auto)" }}>
                    <span style={{ color: "#4b5563", fontSize: 12, fontWeight: 700 }}>Bidaily second time</span>
                    <input
                      disabled={routingLoading || routingSaving}
                      onChange={(event) => updateRoutingField("bidailySecondTime", event.currentTarget.value)}
                      placeholder="17:00"
                      style={{
                        border: "1px solid #d1d5db",
                        borderRadius: 8,
                        fontSize: 14,
                        minWidth: 0,
                        padding: "9px 10px",
                      }}
                      type="text"
                      value={routingConfig.bidailySecondTime}
                    />
                    <span style={{ color: "#6b7280", fontSize: 12, lineHeight: "16px" }}>
                      Second send time when bidaily mode is selected.
                    </span>
                  </label>
                  <label style={{ display: "grid", gap: 5, gridTemplateRows: "auto auto minmax(32px, auto)" }}>
                    <span style={{ color: "#4b5563", fontSize: 12, fontWeight: 700 }}>Tridaily times</span>
                    <input
                      disabled={routingLoading || routingSaving}
                      onChange={(event) => updateRoutingField("tridailyTimes", event.currentTarget.value)}
                      placeholder="07:00,13:00,19:00"
                      style={{
                        border: "1px solid #d1d5db",
                        borderRadius: 8,
                        fontSize: 14,
                        minWidth: 0,
                        padding: "9px 10px",
                      }}
                      type="text"
                      value={routingConfig.tridailyTimes}
                    />
                    <span style={{ color: "#6b7280", fontSize: 12, lineHeight: "16px" }}>
                      Three comma-separated UTC times for tridaily mode.
                    </span>
                  </label>
                </div>
              </div>
            }
          />
        </div>

        {routingMessage ? <NoticeBlock notice={routingMessage} /> : null}

        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button
            disabled={routingLoading || routingSaving}
            onClick={() => {
              setRoutingConfig(routingSnapshot);
              setRoutingMessage(null);
            }}
            style={{
              background: "white",
              border: "1px solid #d1d5db",
              borderRadius: 8,
              color: "#374151",
              cursor: routingLoading || routingSaving ? "not-allowed" : "pointer",
              fontWeight: 700,
              padding: "10px 14px",
            }}
            type="button"
          >
            Reset
          </button>
          <button
            disabled={routingLoading || routingSaving || !routingDirty}
            onClick={() => {
              void handleSaveRoutingConfig();
            }}
            style={{
              background: routingLoading || routingSaving || !routingDirty ? "#9ca3af" : "#111827",
              border: 0,
              borderRadius: 8,
              color: "white",
              cursor: routingLoading || routingSaving || !routingDirty ? "not-allowed" : "pointer",
              fontWeight: 700,
              minWidth: 160,
              padding: "10px 14px",
            }}
            type="button"
          >
            {routingSaving ? "Saving..." : "Save routing"}
          </button>
        </div>
      </section>

      <section
        style={{
          border: "1px solid #e5e7eb",
          borderRadius: 8,
          display: "grid",
          gap: 18,
          padding: 18,
        }}
      >
        <div style={{ display: "grid", gap: 4 }}>
          <h2 style={{ fontSize: 18, fontWeight: 700, lineHeight: "28px", margin: 0 }}>Media Intake / Brief Agent</h2>
          <p style={{ color: "#6b7280", margin: 0 }}>
            Routes Telegram voice, audio, documents, and photos either to a Brief Agent intake flow or to active agent sessions inside forum topics.
          </p>
        </div>

        <div style={{ display: "grid", gap: 12 }}>
          <TextField
            disabled={mediaLoading || mediaSaving}
            label="Transcription API key secret ref"
            onChange={(value) => updateMediaField("transcriptionApiKeyRef", value)}
            placeholder="OpenAI API key secret UUID"
            value={mediaConfig.transcriptionApiKeyRef}
          >
            Secret UUID for the OpenAI API key used to transcribe voice and audio before routing media to the Brief Agent or an active topic agent session.
          </TextField>
          <TextField
            disabled={mediaLoading || mediaSaving}
            label="Brief Agent ID"
            onChange={(value) => updateMediaField("briefAgentId", value)}
            placeholder="Paperclip agent ID"
            value={mediaConfig.briefAgentId}
          >
            Agent ID that processes media intake briefs. Leave empty to disable the dedicated Brief Agent intake flow.
          </TextField>
          <ArrayField
            disabled={mediaLoading || mediaSaving}
            emptyValueLabel="No intake chat IDs configured"
            label="Brief Agent intake chat IDs"
            newItemLabel="Add intake chat ID"
            onChange={(value) => updateMediaField("briefAgentChatIds", value)}
            placeholder="-1003800613668"
            value={mediaConfig.briefAgentChatIds}
          >
            Telegram chat IDs where media is routed to the Brief Agent. Media in other chats goes to active agent sessions when a matching forum topic session exists.
          </ArrayField>
        </div>

        {mediaMessage ? <NoticeBlock notice={mediaMessage} /> : null}

        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button
            disabled={mediaLoading || mediaSaving}
            onClick={() => {
              setMediaConfig(mediaSnapshot);
              setMediaMessage(null);
            }}
            style={{
              background: "white",
              border: "1px solid #d1d5db",
              borderRadius: 8,
              color: "#374151",
              cursor: mediaLoading || mediaSaving ? "not-allowed" : "pointer",
              fontWeight: 700,
              padding: "10px 14px",
            }}
            type="button"
          >
            Reset
          </button>
          <button
            disabled={mediaLoading || mediaSaving || !mediaDirty}
            onClick={() => {
              void handleSaveMediaConfig();
            }}
            style={{
              background: mediaLoading || mediaSaving || !mediaDirty ? "#9ca3af" : "#111827",
              border: 0,
              borderRadius: 8,
              color: "white",
              cursor: mediaLoading || mediaSaving || !mediaDirty ? "not-allowed" : "pointer",
              fontWeight: 700,
              minWidth: 160,
              padding: "10px 14px",
            }}
            type="button"
          >
            {mediaSaving ? "Saving..." : "Save media intake"}
          </button>
        </div>
      </section>

      <section
        style={{
          border: "1px solid #e5e7eb",
          borderRadius: 8,
          display: "grid",
          gap: 18,
          padding: 18,
        }}
      >
        <div style={{ display: "grid", gap: 4 }}>
          <h2 style={{ fontSize: 18, fontWeight: 700, lineHeight: "28px", margin: 0 }}>Human Escalation</h2>
          <p style={{ color: "#6b7280", margin: 0 }}>
            Controls where human handoff requests go and what the bot tells the original Telegram user while waiting.
          </p>
        </div>

        <div style={{ display: "grid", gap: 12 }}>
          <TextField
            disabled={escalationLoading || escalationSaving}
            label="Escalation Chat ID"
            onChange={(value) => updateEscalationField("escalationChatId", value)}
            placeholder="-1003800613668"
            value={escalationConfig.escalationChatId}
          >
            Telegram chat ID where escalations are sent for human review. Leave empty to log escalations without forwarding them to Telegram.
          </TextField>
          <div style={twoColumnGridStyle}>
            <label style={pairedFieldStyle}>
              <span style={{ color: "#4b5563", fontSize: 12, fontWeight: 700 }}>Escalation timeout (ms)</span>
              <input
                disabled={escalationLoading || escalationSaving}
                min={0}
                onChange={(event) => updateEscalationField("escalationTimeoutMs", Number(event.currentTarget.value))}
                placeholder="900000"
                style={standardInputStyle}
                type="number"
                value={escalationConfig.escalationTimeoutMs}
              />
              <span style={helperTextStyle}>
                How long to wait for a human response. Default is 900000 ms, or 15 minutes.
              </span>
            </label>
            <label style={pairedFieldStyle}>
              <span style={{ color: "#4b5563", fontSize: 12, fontWeight: 700 }}>Default action on timeout</span>
              <select
                disabled={escalationLoading || escalationSaving}
                onChange={(event) => updateEscalationField("escalationDefaultAction", event.currentTarget.value as TelegramEscalationConfig["escalationDefaultAction"])}
                style={standardInputStyle}
                value={escalationConfig.escalationDefaultAction}
              >
                <option value="defer">Defer</option>
                <option value="auto_reply">Auto reply</option>
                <option value="close">Close</option>
              </select>
              <span style={helperTextStyle}>
                Defer does nothing, auto reply sends the suggested reply, and close ends the escalation path.
              </span>
            </label>
          </div>
          <TextAreaField
            disabled={escalationLoading || escalationSaving}
            label="Hold message"
            onChange={(value) => updateEscalationField("escalationHoldMessage", value)}
            placeholder="Let me check on that - I'll get back to you shortly."
            rows={3}
            value={escalationConfig.escalationHoldMessage}
          >
            Message sent to the original Telegram user when their conversation is escalated to a human.
          </TextAreaField>
        </div>

        {escalationMessage ? <NoticeBlock notice={escalationMessage} /> : null}

        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button
            disabled={escalationLoading || escalationSaving}
            onClick={() => {
              setEscalationConfig(escalationSnapshot);
              setEscalationMessage(null);
            }}
            style={{
              background: "white",
              border: "1px solid #d1d5db",
              borderRadius: 8,
              color: "#374151",
              cursor: escalationLoading || escalationSaving ? "not-allowed" : "pointer",
              fontWeight: 700,
              padding: "10px 14px",
            }}
            type="button"
          >
            Reset
          </button>
          <button
            disabled={escalationLoading || escalationSaving || !escalationDirty}
            onClick={() => {
              void handleSaveEscalationConfig();
            }}
            style={{
              background: escalationLoading || escalationSaving || !escalationDirty ? "#9ca3af" : "#111827",
              border: 0,
              borderRadius: 8,
              color: "white",
              cursor: escalationLoading || escalationSaving || !escalationDirty ? "not-allowed" : "pointer",
              fontWeight: 700,
              minWidth: 160,
              padding: "10px 14px",
            }}
            type="button"
          >
            {escalationSaving ? "Saving..." : "Save escalation"}
          </button>
        </div>
      </section>

      <section
        style={{
          border: "1px solid #e5e7eb",
          borderRadius: 8,
          display: "grid",
          gap: 18,
          padding: 18,
        }}
      >
        <div style={{ display: "grid", gap: 4 }}>
          <h2 style={{ fontSize: 18, fontWeight: 700, lineHeight: "28px", margin: 0 }}>Proactive Suggestions</h2>
          <p style={{ color: "#6b7280", margin: 0 }}>
            Controls the scheduled watch system that sends Telegram suggestions when registered watches match Paperclip activity.
          </p>
        </div>

        <div style={twoColumnGridStyle}>
          <label style={pairedFieldStyle}>
            <span style={{ color: "#4b5563", fontSize: 12, fontWeight: 700 }}>Suggestion rate limit</span>
            <input
              disabled={proactiveLoading || proactiveSaving}
              min={0}
              onChange={(event) => updateProactiveField("maxSuggestionsPerHourPerCompany", Number(event.currentTarget.value))}
              placeholder="10"
              style={standardInputStyle}
              type="number"
              value={proactiveConfig.maxSuggestionsPerHourPerCompany}
            />
            <span style={helperTextStyle}>
              Maximum proactive suggestions sent per company per hour. Set to 0 to suppress watch suggestions without deleting watches.
            </span>
          </label>
          <label style={pairedFieldStyle}>
            <span style={{ color: "#4b5563", fontSize: 12, fontWeight: 700 }}>Watch deduplication window (ms)</span>
            <input
              disabled={proactiveLoading || proactiveSaving}
              min={0}
              onChange={(event) => updateProactiveField("watchDeduplicationWindowMs", Number(event.currentTarget.value))}
              placeholder="86400000"
              style={standardInputStyle}
              type="number"
              value={proactiveConfig.watchDeduplicationWindowMs}
            />
            <span style={helperTextStyle}>
              Suppresses repeat suggestions for the same watch/entity pair within this window. Default is 86400000 ms, or 24 hours.
            </span>
          </label>
        </div>

        <div
          style={{
            background: "#f9fafb",
            border: "1px solid #e5e7eb",
            borderRadius: 8,
            color: "#4b5563",
            display: "grid",
            fontSize: 13,
            gap: 4,
            padding: 12,
          }}
        >
          <strong style={{ color: "#374151" }}>Watch controls</strong>
          <span>
            Individual watches are created by agents through the `register_watch` tool and stored per company. This section controls global rate limiting and duplicate suppression; it does not create or delete watch definitions.
          </span>
        </div>

        {proactiveMessage ? <NoticeBlock notice={proactiveMessage} /> : null}

        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button
            disabled={proactiveLoading || proactiveSaving}
            onClick={() => {
              setProactiveConfig(proactiveSnapshot);
              setProactiveMessage(null);
            }}
            style={{
              background: "white",
              border: "1px solid #d1d5db",
              borderRadius: 8,
              color: "#374151",
              cursor: proactiveLoading || proactiveSaving ? "not-allowed" : "pointer",
              fontWeight: 700,
              padding: "10px 14px",
            }}
            type="button"
          >
            Reset
          </button>
          <button
            disabled={proactiveLoading || proactiveSaving || !proactiveDirty}
            onClick={() => {
              void handleSaveProactiveConfig();
            }}
            style={{
              background: proactiveLoading || proactiveSaving || !proactiveDirty ? "#9ca3af" : "#111827",
              border: 0,
              borderRadius: 8,
              color: "white",
              cursor: proactiveLoading || proactiveSaving || !proactiveDirty ? "not-allowed" : "pointer",
              fontWeight: 700,
              minWidth: 160,
              padding: "10px 14px",
            }}
            type="button"
          >
            {proactiveSaving ? "Saving..." : "Save suggestions"}
          </button>
        </div>
      </section>
    </main>
  );
}

function NoticeBlock({ notice }: { notice: Notice }): React.JSX.Element {
  return (
    <div
      style={{
        border: `1px solid ${notice.tone === "success" ? "#99f6e4" : "#fecaca"}`,
        borderRadius: 8,
        background: notice.tone === "success" ? "#f0fdfa" : "#fef2f2",
        color: notice.tone === "success" ? "#115e59" : "#991b1b",
        padding: 12,
      }}
    >
      <strong>{notice.title}</strong>
      {notice.text ? <p style={{ margin: "6px 0 0" }}>{notice.text}</p> : null}
    </div>
  );
}

function TextField({
  label,
  value,
  placeholder,
  disabled,
  children,
  onChange,
}: {
  label: string;
  value: string;
  placeholder: string;
  disabled: boolean;
  children: React.ReactNode;
  onChange(value: string): void;
}): React.JSX.Element {
  return (
    <label style={{ display: "grid", gap: 5 }}>
      <span style={{ color: "#4b5563", fontSize: 12, fontWeight: 700 }}>{label}</span>
      <input
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.value)}
        placeholder={placeholder}
        style={{
          border: "1px solid #d1d5db",
          borderRadius: 8,
          fontSize: 14,
          minWidth: 0,
          padding: "9px 10px",
        }}
        type="text"
        value={value}
      />
      <span style={{ color: "#6b7280", fontSize: 12 }}>{children}</span>
    </label>
  );
}

function TextAreaField({
  label,
  value,
  placeholder,
  rows = 3,
  disabled,
  children,
  onChange,
}: {
  label: string;
  value: string;
  placeholder: string;
  rows?: number;
  disabled: boolean;
  children: React.ReactNode;
  onChange(value: string): void;
}): React.JSX.Element {
  return (
    <label style={{ display: "grid", gap: 5 }}>
      <span style={{ color: "#4b5563", fontSize: 12, fontWeight: 700 }}>{label}</span>
      <textarea
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.value)}
        placeholder={placeholder}
        rows={rows}
        style={{
          border: "1px solid #d1d5db",
          borderRadius: 8,
          fontSize: 14,
          minWidth: 0,
          padding: "9px 10px",
          resize: "vertical",
        }}
        value={value}
      />
      <span style={{ color: "#6b7280", fontSize: 12 }}>{children}</span>
    </label>
  );
}

function ArrayField({
  label,
  value,
  placeholder,
  disabled,
  emptyValueLabel,
  newItemLabel,
  children,
  onChange,
}: {
  label: string;
  value: string[];
  placeholder: string;
  disabled: boolean;
  emptyValueLabel: string;
  newItemLabel: string;
  children: React.ReactNode;
  onChange(value: string[]): void;
}): React.JSX.Element {
  function updateItem(index: number, nextValue: string): void {
    const next = [...value];
    next[index] = nextValue;
    onChange(next);
  }

  function removeItem(index: number): void {
    onChange(value.filter((_, itemIndex) => itemIndex !== index));
  }

  function addItem(): void {
    onChange([...value, ""]);
  }

  return (
    <div style={{ display: "grid", gap: 7 }}>
      <div style={{ color: "#4b5563", fontSize: 12, fontWeight: 700 }}>{label}</div>
      <div style={{ display: "grid", gap: 8 }}>
        {value.length === 0 ? (
          <div
            style={{
              border: "1px dashed #d1d5db",
              borderRadius: 8,
              color: "#6b7280",
              fontSize: 13,
              padding: "9px 10px",
            }}
          >
            {emptyValueLabel}
          </div>
        ) : null}
        {value.map((item, index) => (
          <div key={index} style={{ alignItems: "center", display: "grid", gap: 8, gridTemplateColumns: "minmax(0, 1fr) auto" }}>
            <input
              disabled={disabled}
              onBlur={() => {
                const cleaned = value.map((entry) => entry.trim()).filter(Boolean);
                if (JSON.stringify(cleaned) !== JSON.stringify(value)) {
                  onChange(cleaned);
                }
              }}
              onChange={(event) => updateItem(index, event.currentTarget.value)}
              placeholder={placeholder}
              style={{
                border: "1px solid #d1d5db",
                borderRadius: 8,
                fontSize: 14,
                minWidth: 0,
                padding: "9px 10px",
              }}
              type="text"
              value={item}
            />
            <button
              disabled={disabled}
              onClick={() => removeItem(index)}
              style={{
                background: "white",
                border: "1px solid #d1d5db",
                borderRadius: 8,
                color: "#374151",
                cursor: disabled ? "not-allowed" : "pointer",
                fontWeight: 700,
                padding: "9px 12px",
              }}
              type="button"
            >
              Remove
            </button>
          </div>
        ))}
      </div>
      <button
        disabled={disabled}
        onClick={addItem}
        style={{
          background: "white",
          border: "1px solid #d1d5db",
          borderRadius: 8,
          color: "#374151",
          cursor: disabled ? "not-allowed" : "pointer",
          fontWeight: 700,
          justifySelf: "start",
          padding: "9px 12px",
        }}
        type="button"
      >
        {newItemLabel}
      </button>
      <span style={{ color: "#6b7280", fontSize: 12 }}>{children}</span>
    </div>
  );
}

function CheckboxField({
  label,
  checked,
  disabled,
  children,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled: boolean;
  children: React.ReactNode;
  onChange(value: boolean): void;
}): React.JSX.Element {
  return (
    <label style={{ color: "#374151", display: "grid", gap: 3, fontSize: 13 }}>
      <span style={{ alignItems: "center", display: "flex", gap: 8 }}>
        <input
          checked={checked}
          disabled={disabled}
          onChange={(event) => onChange(event.currentTarget.checked)}
          type="checkbox"
        />
        {label}
      </span>
      <span style={{ color: "#6b7280", fontSize: 12, marginLeft: 22 }}>{children}</span>
    </label>
  );
}

function RoutingRow({
  title,
  chatId,
  topicId,
  chatPlaceholder,
  topicPlaceholder,
  chatHelp,
  disabled,
  children,
  footer,
  onChatIdChange,
  onTopicIdChange,
}: {
  title: string;
  chatId: string;
  topicId: string;
  chatPlaceholder: string;
  topicPlaceholder: string;
  chatHelp: string;
  disabled: boolean;
  children?: React.ReactNode;
  footer?: React.ReactNode;
  onChatIdChange(value: string): void;
  onTopicIdChange(value: string): void;
}): React.JSX.Element {
  return (
    <div
      style={{
        border: "1px solid #e5e7eb",
        borderRadius: 8,
        display: "grid",
        gap: 10,
        padding: 12,
      }}
    >
      <div style={{ alignItems: "center", display: "flex", gap: 12, justifyContent: "space-between" }}>
        <strong>{title}</strong>
        {children ? <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>{children}</div> : null}
      </div>
      <div style={{ display: "grid", gap: 10 }}>
        <div style={twoColumnGridStyle}>
          <label style={pairedFieldStyle}>
            <span style={{ color: "#4b5563", fontSize: 12, fontWeight: 700 }}>Chat ID</span>
            <input
              disabled={disabled}
              onChange={(event) => onChatIdChange(event.currentTarget.value)}
              placeholder={chatPlaceholder}
              style={standardInputStyle}
              type="text"
              value={chatId}
            />
            <span style={helperTextStyle}>{chatHelp}</span>
          </label>
          <label style={pairedFieldStyle}>
            <span style={{ color: "#4b5563", fontSize: 12, fontWeight: 700 }}>Topic ID</span>
            <input
              disabled={disabled}
              onChange={(event) => onTopicIdChange(event.currentTarget.value)}
              placeholder={topicPlaceholder}
              style={standardInputStyle}
              type="text"
              value={topicId}
            />
            <span style={helperTextStyle}>
              Optional. Used only when the Chat ID points to a Telegram forum group.
            </span>
          </label>
        </div>
      </div>
      {footer ? <div style={{ display: "grid", gap: 10 }}>{footer}</div> : null}
    </div>
  );
}
