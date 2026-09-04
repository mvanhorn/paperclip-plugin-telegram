import {
  definePlugin,
  runWorker,
  type PluginContext,
  type PluginEvent,
  type PluginHealthDiagnostics,
  type Agent,
  type Issue,
} from "@paperclipai/plugin-sdk";
import {
  sendMessage,
  editMessage,
  answerCallbackQuery,
  setMyCommands,
  escapeMarkdownV2,
  isForum,
  GENERAL_TOPIC_THREAD_ID,
} from "./telegram-api.js";
import {
  formatIssueCreated,
  formatIssueDone,
  formatIssueAssigned,
  formatApprovalCreated,
  formatAgentError,
  formatAgentRunStarted,
  formatAgentRunFinished,
  type IssueLinksOpts,
} from "./formatters.js";
import { handleCommand, resolveNotificationThreadId, BOT_COMMANDS } from "./commands.js";
import {
  routeMessageToAgent,
  handleHandoffToolCall,
  handleDiscussToolCall,
  handleHandoffApproval,
  handleHandoffRejection,
  setupAcpOutputListener,
} from "./acp-bridge.js";
import { handleMediaMessage } from "./media-pipeline.js";
import {
  getPersistedTelegramUpdateOffset,
  persistTelegramUpdateOffset,
  processTelegramUpdateBatch,
} from "./polling-offset.js";
import {
  handleCommandsCommand,
  tryCustomCommand,
  isWorkflowApprovalCallback,
  resolveWorkflowApprovalCallback,
} from "./command-registry.js";
import { handleRegisterWatch, checkWatches } from "./watch-registry.js";
import { AGENT_ERROR_DEDUPLICATION_WINDOW_MS, DEFAULT_CONFIG, METRIC_NAMES } from "./constants.js";
import { EscalationManager } from "./escalation.js";
import type { EscalationEvent } from "./escalation.js";
import { isTelegramUpdateAllowed, validateTelegramAllowlists } from "./allowlist.js";
import { normalizeSecretRef, validateSecretRefFields } from "./secret-ref-validation.js";
import { shouldNotifyApproval } from "./approval-routing.js";
import { isWorking } from "./agent-status.js";
import { buildPaperclipAuthHeaders, fetchPaperclipApi } from "./paperclip-api.js";
import { resolveTelegramBotToken, type TelegramRuntimeHealth } from "./runtime-token.js";

type TelegramConfig = {
  telegramBotTokenRef: string;
  defaultChatId: string;
  approvalsChatId: string;
  approvalsTopicId: string;
  errorsChatId: string;
  errorsTopicId: string;
  digestChatId: string;
  digestTopicId: string;
  paperclipBaseUrl: string;
  paperclipBoardApiTokenRef: string;
  paperclipPublicUrl: string;
  notifyOnIssueCreated: boolean;
  notifyOnIssueDone: boolean;
  notifyOnIssueAssigned: boolean;
  onlyNotifyIfAssignedTo: string;
  notifyOnApprovalCreated: boolean;
  onlyNotifyBoardApprovals: boolean;
  notifyOnAgentError: boolean;
  notifyOnAgentRunStarted: boolean;
  notifyOnAgentRunFinished: boolean;
  enableCommands: boolean;
  enableInbound: boolean;
  allowedTelegramUserIds: string[];
  allowedTelegramChatIds: string[];
  digestMode: "off" | "daily" | "bidaily" | "tridaily";
  dailyDigestTime: string;
  bidailySecondTime: string;
  tridailyTimes: string;
  topicRouting: boolean;
  maxAgentsPerThread: number;
  escalationChatId: string;
  escalationTimeoutMs: number;
  escalationDefaultAction: "defer" | "auto_reply" | "close";
  escalationHoldMessage: string;
  // Phase 3: Media Pipeline
  briefAgentId: string;
  briefAgentChatIds: string[];
  transcriptionApiKeyRef: string;
  // Phase 5: Proactive Suggestions
  maxSuggestionsPerHourPerCompany: number;
  watchDeduplicationWindowMs: number;
};

type TelegramUpdate = {
  update_id: number;
  message?: {
    message_id: number;
    from?: { id: number; username?: string; first_name?: string };
    chat: { id: number; type: string; title?: string };
    text?: string;
    message_thread_id?: number;
    reply_to_message?: {
      message_id: number;
      text?: string;
      from?: { is_bot?: boolean };
    };
    entities?: Array<{ type: string; offset: number; length: number }>;
    // Media fields (Phase 3)
    voice?: { file_id: string; duration: number; mime_type?: string };
    audio?: { file_id: string; duration: number; title?: string; mime_type?: string };
    video_note?: { file_id: string; duration: number };
    document?: { file_id: string; file_name?: string; mime_type?: string };
    photo?: Array<{ file_id: string; width: number; height: number }>;
    caption?: string;
  };
  callback_query?: {
    id: string;
    from: { id: number; username?: string; first_name?: string };
    message?: {
      message_id: number;
      chat: { id: number };
      text?: string;
    };
    data?: string;
  };
};

const TELEGRAM_API = "https://api.telegram.org";
const BOARD_ACCESS_SCOPE = {
  scopeKind: "instance",
  stateKey: "telegram.board-access.v1",
} as const;

type TelegramBoardAccessState = {
  paperclipBoardApiTokenRef: string | null;
  identity: string | null;
  companyId: string | null;
  updatedAt: string | null;
};

type TelegramBoardAccessRegistration = TelegramBoardAccessState & {
  configured: boolean;
};

// ---------------------------------------------------------------------------
// Runtime state
// ---------------------------------------------------------------------------
//
// setup() runs OUTSIDE any company scope. Since paperclipai/paperclip#9557 the
// SDK's governed-access gate requires a company scope for `config.get()` and
// `secrets.resolve()`, so a worker cannot read its own configuration while it
// starts: an unscoped call in setup() throws "company context is required"
// and kills activation (paperclip-plugin-telegram#77).
//
// setup() therefore only registers handlers, unconditionally. Everything that
// needs config or a secret lives in `runtime`, and `onConfigChanged` is the
// ONLY thing that builds or refreshes it — the host delivers stored
// configuration with a company scope at worker start and on every save. A
// handler that fires before any delivery has happened has nothing to serve
// and no-ops via `ensureRuntime()`.
//
// The installed SDK (2026.722.0) calls `onConfigChanged(newConfig)` with no
// company scope attached, even though the host binds the RPC invocation to
// the real company and denies a read for any other one. `identifyDeliveredCompany`
// probes for the scope from inside the invocation instead of guessing.
//
// This plugin's bot token and defaultChatId are a single shared instance
// config — exactly one company can own the *storage* that config lives in on
// a governed host, mirrored here as `ownerCompanyId`. That is unrelated to
// which companies the plugin *serves*: `/connect` already lets many companies
// route their own chat to their own company via per-company chat-mapping
// state, and `notify()` below dispatches events from any companyId. Ownership
// only decides whose configuration delivery built `runtime`; refusing a
// second company's *events* would break that existing multi-company routing.
let _pluginCtx: PluginContext | null = null;
let runtime: TelegramRuntime | null = null;
let runtimeHealth: TelegramRuntimeHealth = {
  status: "degraded",
  message: "Waiting for company-scoped configuration from the host",
};
let ownerCompanyId: string | null = null;
let ownerConfigJson: string | null = null;
const refusedCompanies = new Set<string>();
let bootstrapQueue: Promise<void> = Promise.resolve();
let pollingActive = false;

type TelegramRuntime = {
  companyId: string;
  config: TelegramConfig;
  token: string;
  baseUrl: string;
  publicUrl: string;
};

// Process-lifetime singletons. None of these depend on delivered config, so
// hoisting them out of setup() (where they used to be created once, the same
// way, since setup() only ever ran once) changes nothing about their
// behavior.
const escalationManager = new EscalationManager();
const issuePrefixCache = new Map<string, string>();
const doneDedupe = makeUpdateDedupe();
const assignmentDedupe = makeUpdateDedupe();
const agentErrorDedupe = makeUpdateDedupe(AGENT_ERROR_DEDUPLICATION_WINDOW_MS, 1000);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeBoardAccessState(value: unknown): TelegramBoardAccessState {
  const record = isRecord(value) ? value : {};
  return {
    paperclipBoardApiTokenRef: asNonEmptyString(record.paperclipBoardApiTokenRef),
    identity: asNonEmptyString(record.identity),
    companyId: asNonEmptyString(record.companyId),
    updatedAt: asNonEmptyString(record.updatedAt),
  };
}

async function loadBoardAccessState(ctx: PluginContext): Promise<TelegramBoardAccessState> {
  return normalizeBoardAccessState(await ctx.state.get(BOARD_ACCESS_SCOPE));
}

async function persistBoardAccessState(
  ctx: PluginContext,
  state: TelegramBoardAccessState,
): Promise<TelegramBoardAccessRegistration> {
  const nextState = normalizeBoardAccessState(state);
  await ctx.state.set(BOARD_ACCESS_SCOPE, nextState);
  return {
    ...nextState,
    configured: Boolean(nextState.paperclipBoardApiTokenRef),
  };
}

function getBoardAccessRegistration(
  state: TelegramBoardAccessState,
): TelegramBoardAccessRegistration {
  return {
    ...state,
    configured: Boolean(state.paperclipBoardApiTokenRef),
  };
}

async function resolveBoardApiToken(
  ctx: PluginContext,
  config: TelegramConfig,
  companyId?: string | null,
): Promise<string | undefined> {
  const boardAccessState = await loadBoardAccessState(ctx);
  const candidates: Array<{ source: string; ref: string }> = [];

  if (
    boardAccessState.paperclipBoardApiTokenRef &&
    (!companyId || !boardAccessState.companyId || boardAccessState.companyId === companyId)
  ) {
    candidates.push({
      source: "board-access",
      ref: boardAccessState.paperclipBoardApiTokenRef,
    });
  }

  if (config.paperclipBoardApiTokenRef) {
    candidates.push({
      source: "config",
      ref: config.paperclipBoardApiTokenRef,
    });
  }

  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate.ref)) continue;
    seen.add(candidate.ref);
    try {
      const normalizedRef = normalizeSecretRef(candidate.ref);
      if (!normalizedRef) continue;
      return await ctx.secrets.resolve(normalizedRef as string, {
        companyId: companyId ?? undefined,
        configPath: candidate.source === "config" ? "paperclipBoardApiTokenRef" : undefined,
      });
    } catch (err) {
      ctx.logger.warn("Failed to resolve board API token secret", {
        source: candidate.source,
        companyId,
        error: String(err),
      });
    }
  }

  return undefined;
}

async function resolveCallbackCompanyId(
  ctx: PluginContext,
  query: NonNullable<TelegramUpdate["callback_query"]>,
): Promise<string | null> {
  const chatId = query.message?.chat.id ? String(query.message.chat.id) : null;
  const messageId = query.message?.message_id;
  if (!chatId || !messageId) return null;

  const mapping = await ctx.state.get({
    scopeKind: "instance",
    stateKey: `msg_${chatId}_${messageId}`,
  }) as { companyId?: string } | null;

  return mapping?.companyId ?? null;
}

/**
 * Shared 5s sliding-window dedupe for issue.updated handlers.
 *
 * Paperclip's core can emit duplicate `issue.updated` plugin events for a
 * single PATCH (the route's logActivity plus side-effects from heartbeat
 * reconciliation), so handlers must dedupe to avoid sending the same
 * Telegram message twice.
 */
function makeUpdateDedupe(windowMs = 5_000, maxEntries = 500) {
  const seen = new Map<string, number>();
  return (key: string): boolean => {
    const now = Date.now();
    const last = seen.get(key);
    if (last !== undefined && now - last < windowMs) return false;
    seen.set(key, now);
    if (seen.size > maxEntries) {
      const cutoff = now - windowMs;
      for (const [k, ts] of seen) {
        if (ts < cutoff) seen.delete(k);
      }
    }
    return true;
  };
}

function normalizeAgentErrorMessage(input: unknown): string {
  return String(input ?? "Unknown error")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 500);
}

async function resolveChat(
  ctx: PluginContext,
  companyId: string,
  fallback: string,
): Promise<string | null> {
  const override = await ctx.state.get({
    scopeKind: "company",
    scopeId: companyId,
    stateKey: "telegram-chat",
  });
  return (override as string) ?? fallback ?? null;
}

function parseTopicId(value?: string): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (!/^\d+$/.test(trimmed)) return undefined;
  return Number(trimmed);
}

function validateConfiguredTopicIds(config: Record<string, unknown>): string[] {
  const errors: string[] = [];
  for (const key of ["approvalsTopicId", "errorsTopicId", "digestTopicId"]) {
    const value = config[key];
    if (value === undefined || value === null || value === "") continue;
    if (typeof value !== "string" || !parseTopicId(value)) {
      errors.push(`${key} must be a numeric Telegram forum topic ID string.`);
    }
  }
  return errors;
}

async function resolveDigestThreadId(
  ctx: PluginContext,
  token: string,
  chatId: string,
  configuredTopicId?: string,
): Promise<number | undefined> {
  const configured = parseTopicId(configuredTopicId);
  if (configured) return configured;
  return await isForum(ctx, token, chatId) ? GENERAL_TOPIC_THREAD_ID : undefined;
}

async function resolveCompanyId(ctx: PluginContext, chatId: string): Promise<string> {
  const mapping = await ctx.state.get({
    scopeKind: "instance",
    stateKey: `chat_${chatId}`,
  }) as { companyId?: string; companyName?: string } | null;
  const companyId = mapping?.companyId ?? mapping?.companyName;
  if (!companyId) {
    throw new Error("This chat is not linked to a Paperclip company. Use /connect first.");
  }
  return companyId;
}

// Non-throwing variant for handleUpdate call sites. A throw escaping
// handleUpdate prevents the polling offset from advancing, so the same
// update is re-fetched and re-thrown forever — the poller wedges for every
// chat. Unlinked chats must degrade per-path instead (friendly reply for
// commands, skip for media/thread routing).
async function resolveCompanyIdOrNull(ctx: PluginContext, chatId: string): Promise<string | null> {
  try {
    return await resolveCompanyId(ctx, chatId);
  } catch {
    return null;
  }
}

/** Deterministic enough to compare two deliveries for the equal-config rule below. */
function stableConfigJson(config: unknown): string {
  const normalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, entry]) => [key, normalize(entry)]),
      );
    }
    return value;
  };
  return JSON.stringify(normalize(config ?? null));
}

/**
 * Decide whether a configuration delivery for `companyId` may (re)build the
 * runtime.
 *
 * - No owner yet → this company becomes the owner.
 * - Same owner → always allowed (refresh in place).
 * - Different company, byte-identical config → ownership advances. This is
 *   what resolves duplicated-config deliveries from a host migration (the
 *   scenario upstream maintainer flagged for paperclip-plugin-telegram#61):
 *   instead of the two companies fighting over a shared runtime, the second
 *   identical delivery is treated as the same install moving, not a rival.
 * - Different company, different config → refused; the current owner's
 *   runtime is left untouched, logged once per refused company.
 */
function claimOwnership(ctx: PluginContext, companyId: string, config: unknown): boolean {
  const configJson = stableConfigJson(config);

  if (!ownerCompanyId) {
    ownerCompanyId = companyId;
    ownerConfigJson = configJson;
    return true;
  }

  if (ownerCompanyId === companyId) {
    ownerConfigJson = configJson;
    return true;
  }

  if (ownerConfigJson !== null && ownerConfigJson === configJson) {
    ctx.logger.info(
      `Telegram plugin owner advancing from company ${ownerCompanyId} to ${companyId}: identical configuration`,
      { previousCompanyId: ownerCompanyId, companyId },
    );
    ownerCompanyId = companyId;
    ownerConfigJson = configJson;
    refusedCompanies.delete(companyId);
    return true;
  }

  if (!refusedCompanies.has(companyId)) {
    refusedCompanies.add(companyId);
    ctx.logger.warn(
      `Telegram plugin ignoring configuration for company ${companyId}; this install's config is owned by ${ownerCompanyId}`,
      { ownerCompanyId, deliveredCompanyId: companyId },
    );
  }
  return false;
}

/** Run one bootstrap attempt inside the ordered critical section every delivery shares. */
function queueBootstrap<T>(work: () => Promise<T>): Promise<T> {
  const next = bootstrapQueue.then(work, work);
  bootstrapQueue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

/**
 * The current runtime, or null before any configuration has been delivered.
 *
 * Read-only: this never bootstraps and never reads config. Every handler
 * calls this first and no-ops on null instead of trying to build a runtime
 * itself — only `onConfigChanged` does that (see "Runtime state" above).
 */
function ensureRuntime(): TelegramRuntime | null {
  return runtime;
}

/**
 * On the installed SDK (2026.722.0), `onConfigChanged` is not told which
 * company's configuration was delivered — only the host's RPC binding knows,
 * and it denies a scoped read for any other company. Probing each company's
 * scoped config from inside this invocation identifies the delivery: only
 * the real one answers.
 */
async function identifyDeliveredCompany(
  ctx: PluginContext,
  deliveredConfig: unknown,
): Promise<string | null> {
  let companies: Array<{ id: string }>;
  try {
    companies = await ctx.companies.list();
  } catch (err) {
    ctx.logger.info("Could not list companies while attributing a configuration delivery", {
      error: String(err),
    });
    return null;
  }

  const readable: Array<{ id: string; config: Record<string, unknown> }> = [];
  for (const company of companies) {
    try {
      const config = await ctx.config.get(company.id);
      readable.push({ id: company.id, config });
    } catch {
      // Not this invocation's scope — expected for every company but one.
    }
  }

  if (readable.length === 0) return null;
  if (readable.length === 1) return readable[0]!.id;

  // A host that answers for several companies is not telling us which one was
  // saved; match the delivered bot-token reference against the readable rows.
  const deliveredRef = normalizeSecretRef(
    (deliveredConfig as Record<string, unknown> | null)?.telegramBotTokenRef,
  );
  const deliveredSecretId = deliveredRef && typeof deliveredRef === "object" ? deliveredRef.secretId : null;
  if (deliveredSecretId) {
    const matches = readable.filter((row) => {
      const rowRef = normalizeSecretRef(row.config.telegramBotTokenRef);
      return rowRef && typeof rowRef === "object" && rowRef.secretId === deliveredSecretId;
    });
    if (matches.length === 1) return matches[0]!.id;
    ctx.logger.warn("Telegram plugin refused ambiguous configuration delivery attribution", {
      deliveredSecretId,
      matchingCompanyIds: matches.map((row) => row.id),
    });
    return null;
  }
  ctx.logger.warn("Telegram plugin refused configuration delivery attribution without a usable bot token reference", {
    readableCompanyIds: readable.map((row) => row.id),
  });
  return null;
}

/**
 * Apply one company's stored configuration to the runtime.
 *
 * Callers MUST go through `queueBootstrap` — nothing serializes host→worker
 * RPC calls, so two config saves arriving close together could otherwise
 * both pass `claimOwnership` and race to build `runtime`.
 *
 * Never throws: every failure path degrades health and returns null so a
 * bad or not-yet-complete delivery cannot crash worker.
 */
async function bootstrapRuntime(
  ctx: PluginContext,
  companyId: string,
  rawConfig: unknown,
): Promise<TelegramRuntime | null> {
  if (!claimOwnership(ctx, companyId, rawConfig)) return runtime;

  const config = {
    ...DEFAULT_CONFIG,
    ...(isRecord(rawConfig) ? rawConfig : {}),
  } as TelegramConfig;
  const baseUrl = config.paperclipBaseUrl || "http://localhost:3100";
  const publicUrl = config.paperclipPublicUrl || baseUrl;

  if (!config.telegramBotTokenRef) {
    ctx.logger.warn("No telegramBotTokenRef configured, plugin disabled", { companyId });
    runtime = null;
    runtimeHealth = { status: "degraded", message: "No telegramBotTokenRef configured" };
    return null;
  }

  const token = await resolveTelegramBotToken(
    ctx,
    config.telegramBotTokenRef,
    (health) => { runtimeHealth = health; },
    companyId,
  );
  if (!token) {
    ctx.logger.warn("Telegram plugin runtime disabled because bot token could not be resolved", { companyId });
    return runtime;
  }

  runtime = { companyId, config, token, baseUrl, publicUrl };

  // --- Register bot commands with Telegram ---
  if (config.enableCommands) {
    const allCommands = [
      ...BOT_COMMANDS,
      { command: "commands", description: "Manage custom workflow commands" },
    ];
    // Non-blocking: this runs from onConfigChanged, which the host also
    // subjects to an RPC timeout, and api.telegram.org being slow must not
    // fail a config save. Idempotent on Telegram's side, so re-registering on
    // every delivery (including config-only refreshes) is harmless.
    setMyCommands(ctx, token, allCommands)
      .then((registered) => {
        if (registered) {
          ctx.logger.info("Bot commands registered with Telegram", { companyId });
        }
      })
      .catch((err) => {
        ctx.logger.error("Failed to register bot commands", { error: String(err) });
      });
  }

  if (!pollingActive) {
    pollingActive = true;
    pollUpdates(ctx).catch((err) =>
      ctx.logger.error("Polling loop crashed", { error: String(err) }),
    );
  }

  ctx.logger.info("Telegram plugin runtime ready", { companyId });
  return runtime;
}

/**
 * Long-polls Telegram for inbound updates. Started once, the first time a
 * configuration delivery resolves a usable bot token, and runs for the life
 * of the worker process (stopped only by `plugin.stopping`).
 *
 * Reads `runtime` fresh on every iteration instead of closing over a token or
 * config captured at start time: a bot-token rotation or a flag flip
 * (enableCommands/enableInbound) takes effect on the next tick without
 * needing to tear down and restart the loop, which long-polling has no
 * persistent connection to tear down anyway.
 */
async function pollUpdates(ctx: PluginContext): Promise<void> {
  ctx.logger.info("Telegram polling loop starting");
  let lastUpdateId = await getPersistedTelegramUpdateOffset(ctx);
  while (pollingActive) {
    const rt = runtime;
    if (!rt || !(rt.config.enableCommands || rt.config.enableInbound)) {
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }
    try {
      ctx.logger.debug("Telegram poll tick", { lastUpdateId });
      const res = await ctx.http.fetch(
        `${TELEGRAM_API}/bot${rt.token}/getUpdates?offset=${lastUpdateId + 1}&timeout=10&allowed_updates=["message","callback_query"]`,
        { method: "GET" },
      );
      const data = (await res.json()) as {
        ok: boolean;
        result?: TelegramUpdate[];
        description?: string;
        error_code?: number;
      };

      if (data.ok && data.result) {
        lastUpdateId = await processTelegramUpdateBatch({
          updates: data.result,
          lastUpdateId,
          handleUpdate: (update) => handleUpdate(ctx, rt.token, rt.config, update, rt.baseUrl, rt.publicUrl),
          persistOffset: (updateId) => persistTelegramUpdateOffset(ctx, updateId),
          logger: ctx.logger,
        });
      } else {
        ctx.logger.warn("Telegram getUpdates: unexpected response", {
          ok: data.ok,
          hasResult: !!data.result,
          description: data.description,
          error_code: data.error_code,
        });
        // ok:false (revoked token/401, 409 conflict, 429) returns immediately
        // rather than honoring timeout=10, and fetch does not throw on non-2xx,
        // so without this the loop spins hot — flooding logs and hammering
        // Telegram. Back off 5s, mirroring the catch block below.
        await new Promise((r) => setTimeout(r, 5000));
      }
    } catch (err) {
      ctx.logger.error("Telegram polling error", { error: String(err) });
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  ctx.logger.warn("Telegram polling loop exited", { pollingActive });
}

async function resolveIssueLinksOpts(ctx: PluginContext, publicUrl: string, companyId: string): Promise<IssueLinksOpts> {
  let prefix = issuePrefixCache.get(companyId);
  if (!prefix) {
    const company = await ctx.companies.get(companyId);
    prefix = company?.issuePrefix ?? "";
    if (prefix) issuePrefixCache.set(companyId, prefix);
  }
  return { baseUrl: publicUrl, issuePrefix: prefix || undefined };
}

async function notify(
  ctx: PluginContext,
  rt: TelegramRuntime,
  event: PluginEvent,
  formatter: (e: PluginEvent, opts?: IssueLinksOpts) => { text: string; options: import("./telegram-api.js").SendMessageOptions },
  overrideChatId?: string,
  overrideTopicId?: string,
): Promise<void> {
  const chatId = await resolveChat(
    ctx,
    event.companyId,
    overrideChatId || rt.config.defaultChatId,
  );
  if (!chatId) return;
  const linksOpts = await resolveIssueLinksOpts(ctx, rt.publicUrl, event.companyId);
  const msg = formatter(event, linksOpts);

  let messageThreadId = parseTopicId(overrideTopicId);
  if (!messageThreadId) {
    messageThreadId = await resolveNotificationThreadId(ctx, chatId, event, rt.config.topicRouting);
  }

  if (messageThreadId) {
    msg.options.messageThreadId = messageThreadId;
  }

  // Issue threading — if we've already sent a message for this entity in this
  // chat+topic, reply to that anchor so all updates about a single entity stack
  // as one Telegram thread on mobile (created → comments → done).
  const anchorKey = event.entityId
    ? `anchor_${chatId}_${event.entityType}_${event.entityId}`
    : null;
  if (anchorKey) {
    const anchor = (await ctx.state.get({
      scopeKind: "instance",
      stateKey: anchorKey,
    })) as { messageId: number; messageThreadId?: number } | null;
    // Only thread when targeting the same topic — Telegram rejects cross-topic replies.
    if (anchor?.messageId && anchor.messageThreadId === messageThreadId) {
      msg.options.replyToMessageId = anchor.messageId;
    }
  }

  const messageId = await sendMessage(ctx, rt.token, chatId, msg.text, msg.options);

  if (messageId) {
    await ctx.state.set(
      {
        scopeKind: "instance",
        stateKey: `msg_${chatId}_${messageId}`,
      },
      {
        entityId: event.entityId,
        entityType: event.entityType,
        companyId: event.companyId,
        eventType: event.eventType,
      },
    );

    await ctx.activity.log({
      companyId: event.companyId,
      message: `Forwarded ${event.eventType} to Telegram`,
      entityType: "plugin",
      entityId: event.entityId,
    });

    // First-message-per-entity: store the anchor so future notifications about the
    // same entity reply to this one. Never overwritten — the first message stays root.
    if (anchorKey) {
      const existing = (await ctx.state.get({
        scopeKind: "instance",
        stateKey: anchorKey,
      })) as { messageId: number; messageThreadId?: number } | null;
      if (!existing) {
        await ctx.state.set(
          { scopeKind: "instance", stateKey: anchorKey },
          { messageId, messageThreadId },
        );
      }
    }
  }
}

const enrichAgentName = async (ctx: PluginContext, event: PluginEvent) => {
  const payload = event.payload as Record<string, unknown>;
  if (payload.agentId && !payload.agentName) {
    try {
      const agent = await ctx.agents.get(String(payload.agentId), event.companyId);
      if (agent) payload.agentName = agent.name;
    } catch { /* best effort */ }
  }
};

export const plugin = definePlugin({
  async setup(ctx) {
    _pluginCtx = ctx;

    // Handlers are registered unconditionally. The feature flags that used to
    // gate these registrations live in company-scoped config, which is
    // unreadable here (see "Runtime state" above), and the SDK requires every
    // registration to complete synchronously within setup(). Each handler
    // therefore starts by resolving the runtime via `ensureRuntime()` and
    // checking its own flag against the live config, no-oping until both exist.

    ctx.data.register("board-access.read", async () => getBoardAccessRegistration(await loadBoardAccessState(ctx)));

    ctx.actions.register("board-access.update", async (params) => {
      const record = isRecord(params) ? params : {};
      const paperclipBoardApiTokenRef = asNonEmptyString(record.paperclipBoardApiTokenRef);
      const identity = asNonEmptyString(record.identity);
      const companyId = asNonEmptyString(record.companyId);
      const now = new Date().toISOString();

      return persistBoardAccessState(ctx, {
        paperclipBoardApiTokenRef,
        identity,
        companyId,
        updatedAt: now,
      });
    });

    ctx.events.on("plugin.stopping", async () => {
      pollingActive = false;
    });

    // --- Phase 2: ACP output listener (cross-plugin events) ---
    setupAcpOutputListener(ctx, () => runtime?.token ?? null);

    // --- Event subscriptions ---

    ctx.events.on("issue.created", async (event: PluginEvent) => {
      const rt = ensureRuntime();
      if (!rt || !rt.config.notifyOnIssueCreated) return;
      await notify(ctx, rt, event, formatIssueCreated);
    });

    ctx.events.on("issue.updated", async (event: PluginEvent) => {
      const rt = ensureRuntime();
      if (!rt || !rt.config.notifyOnIssueDone) return;
      const payload = event.payload as Record<string, unknown>;
      if (payload.status !== "done") return;
      if (!doneDedupe(`done|${event.entityId}`)) return;
      // Enrich with title/priority if missing (issue.updated events often omit them;
      // priority drives the disableNotification policy in formatIssueDone)
      if ((!payload.title || !payload.priority) && event.entityId) {
        try {
          const issue = await ctx.issues.get(event.entityId, event.companyId);
          if (issue) {
            payload.title ??= issue.title;
            payload.priority ??= issue.priority;
          }
        } catch { /* best effort */ }
      }
      // Enrich with latest comment (completion summary)
      if (!payload.comment && event.entityId) {
        try {
          const comments = await ctx.issues.listComments(event.entityId, event.companyId);
          if (comments.length > 0) {
            const latest = comments.reduce((a, b) =>
              new Date(a.createdAt) > new Date(b.createdAt) ? a : b,
            );
            payload.comment = latest.body;
          }
        } catch { /* best effort */ }
      }
      await notify(ctx, rt, event, formatIssueDone);
    });

    ctx.events.on("issue.updated", async (event: PluginEvent) => {
      const rt = ensureRuntime();
      if (!rt || !rt.config.notifyOnIssueAssigned) return;
      const payload = event.payload as Record<string, unknown>;
      const prev = (payload._previous as Record<string, unknown> | undefined) ?? {};

      const userChanged =
        "assigneeUserId" in payload && payload.assigneeUserId !== prev.assigneeUserId;
      const agentChanged =
        "assigneeAgentId" in payload && payload.assigneeAgentId !== prev.assigneeAgentId;
      if (!userChanged && !agentChanged) return;

      if (rt.config.onlyNotifyIfAssignedTo && payload.assigneeUserId !== rt.config.onlyNotifyIfAssignedTo) {
        return;
      }

      const dedupeKey = [
        "assigned",
        event.entityId,
        String(prev.assigneeUserId ?? ""),
        String(payload.assigneeUserId ?? ""),
        String(prev.assigneeAgentId ?? ""),
        String(payload.assigneeAgentId ?? ""),
      ].join("|");
      if (!assignmentDedupe(dedupeKey)) return;

      if ((!payload.title || !payload.assigneeName || !payload.priority) && event.entityId) {
        try {
          const issue = await ctx.issues.get(event.entityId, event.companyId);
          if (issue) {
            payload.title ??= issue.title;
            payload.priority ??= issue.priority;
            const name = (issue as unknown as Record<string, unknown>).assigneeName;
            if (name) payload.assigneeName ??= name;
          }
        } catch { /* best effort */ }
      }

      await notify(ctx, rt, event, formatIssueAssigned);
    });

    ctx.events.on("approval.created", async (event: PluginEvent) => {
      const rt = ensureRuntime();
      if (!rt || !rt.config.notifyOnApprovalCreated) return;
      if (!shouldNotifyApproval(event, rt.config.onlyNotifyBoardApprovals)) return;
      const payload = event.payload as Record<string, unknown>;
      // Enrich with linked issue details (event only has issueIds)
      const issueIds = Array.isArray(payload.issueIds) ? payload.issueIds as string[] : [];
      if (issueIds.length > 0 && !payload.linkedIssues) {
        try {
          const issues = await Promise.all(
            issueIds.slice(0, 5).map((id) => ctx.issues.get(id, event.companyId)),
          );
          payload.linkedIssues = issues
            .filter(Boolean)
            .map((i) => ({
              identifier: i!.identifier,
              title: i!.title,
              status: i!.status,
              priority: i!.priority,
            }));
          // Use first issue's title as the approval title if missing
          if (!payload.title && issues[0]) {
            payload.title = issues[0].identifier
              ? `${issues[0].identifier}: ${issues[0].title}`
              : issues[0].title;
          }
        } catch { /* best effort */ }
      }
      // Enrich agent name
      if (payload.agentId && !payload.agentName) {
        try {
          const agent = await ctx.agents.get(String(payload.agentId), event.companyId);
          if (agent) payload.agentName = agent.name;
        } catch { /* best effort */ }
      }
      // Build a meaningful title if still missing
      if (!payload.title || payload.title === "Approval Requested") {
        const approvalType = String(payload.type ?? "unknown").replace(/_/g, " ");
        const agentLabel = payload.agentName ? String(payload.agentName) : null;
        payload.title = agentLabel
          ? `${approvalType} — ${agentLabel}`
          : approvalType;
      }
      await notify(ctx, rt, event, formatApprovalCreated, rt.config.approvalsChatId, rt.config.approvalsTopicId);
    });

    ctx.events.on("agent.run.failed", async (event: PluginEvent) => {
      const rt = ensureRuntime();
      if (!rt || !rt.config.notifyOnAgentError) return;
      const payload = event.payload as Record<string, unknown>;
      const agentId = String(payload.agentId ?? event.entityId);
      if (payload.agentId && !payload.agentName) {
        try {
          const agent = await ctx.agents.get(String(payload.agentId), event.companyId);
          if (agent) payload.agentName = agent.name;
        } catch { /* best effort */ }
      }
      if (!payload.companyName) {
        try {
          const company = await ctx.companies.get(event.companyId);
          if (company?.name) payload.companyName = company.name;
        } catch { /* best effort */ }
      }
      if (payload.issueId && (!payload.issueIdentifier || !payload.issueTitle)) {
        try {
          const issue = await ctx.issues.get(String(payload.issueId), event.companyId);
          if (issue) {
            payload.issueIdentifier ??= issue.identifier;
            payload.issueTitle ??= issue.title;
          }
        } catch { /* best effort */ }
      }
      const errorMessage = normalizeAgentErrorMessage(payload.error ?? payload.message);
      const dedupeKey = ["agent.run.failed", event.companyId, agentId, errorMessage].join(":");
      if (!agentErrorDedupe(dedupeKey)) return;
      await notify(ctx, rt, event, formatAgentError, rt.config.errorsChatId, rt.config.errorsTopicId);
    });

    ctx.events.on("agent.run.started", async (event: PluginEvent) => {
      const rt = ensureRuntime();
      if (!rt || !rt.config.notifyOnAgentRunStarted) return;
      await enrichAgentName(ctx, event);
      await notify(ctx, rt, event, formatAgentRunStarted);
    });
    ctx.events.on("agent.run.finished", async (event: PluginEvent) => {
      const rt = ensureRuntime();
      if (!rt || !rt.config.notifyOnAgentRunFinished) return;
      await enrichAgentName(ctx, event);
      await notify(ctx, rt, event, formatAgentRunFinished);
    });

    // --- Per-company chat overrides ---

    ctx.data.register("chat-mapping", async (params) => {
      const companyId = String(params.companyId);
      const saved = await ctx.state.get({
        scopeKind: "company",
        scopeId: companyId,
        stateKey: "telegram-chat",
      });
      const rt = ensureRuntime();
      return { chatId: saved ?? rt?.config.defaultChatId ?? "" };
    });

    ctx.actions.register("set-chat", async (params) => {
      const companyId = String(params.companyId);
      const chatId = String(params.chatId);
      await ctx.state.set(
        { scopeKind: "company", scopeId: companyId, stateKey: "telegram-chat" },
        chatId,
      );
      ctx.logger.info("Updated Telegram chat mapping", { companyId, chatId });
      return { ok: true };
    });

    // --- Daily digest job ---

    ctx.jobs.register("telegram-daily-digest", async () => {
      const rt = ensureRuntime();
      if (!rt) return;

      // Support legacy dailyDigestEnabled boolean
      const effectiveDigestMode = (rt.config as Record<string, unknown>).dailyDigestEnabled === true && rt.config.digestMode === "off"
        ? "daily"
        : rt.config.digestMode ?? "off";
      if (effectiveDigestMode === "off") return;

      // Check if current UTC hour matches a configured digest time
      const nowHour = new Date().getUTCHours();
      const nowMin = new Date().getUTCMinutes();
      if (nowMin >= 5) return; // only fire within first 5 min of the hour

      const parseHour = (t: string) => {
        const [h] = (t || "").split(":");
        return parseInt(h ?? "", 10);
      };
      const firstHour = parseHour(rt.config.dailyDigestTime);
      const secondHour = parseHour(rt.config.bidailySecondTime);
      const tridailyHours = (rt.config.tridailyTimes || "07:00,13:00,19:00")
        .split(",")
        .map((t) => parseHour(t.trim()));

      let shouldSend = false;
      if (effectiveDigestMode === "daily") {
        shouldSend = nowHour === firstHour;
      } else if (effectiveDigestMode === "bidaily") {
        shouldSend = nowHour === firstHour || nowHour === secondHour;
      } else if (effectiveDigestMode === "tridaily") {
        shouldSend = tridailyHours.includes(nowHour);
      }
      if (!shouldSend) return;

      const companies = await ctx.companies.list();
      for (const company of companies) {
        const chatId = await resolveChat(ctx, company.id, rt.config.digestChatId || rt.config.defaultChatId);
        if (!chatId) continue;

        try {
          const agents = await ctx.agents.list({ companyId: company.id });
          // Same defect as /status had: `status === "active"` matched nothing on
          // current hosts, so the digest always reported "0/N" active agents.
          const workingAgents = agents.filter(isWorking);
          const issues = await ctx.issues.list({ companyId: company.id, limit: 50 });

          const now = Date.now();
          const oneDayMs = 24 * 60 * 60 * 1000;
          const completedToday = issues.filter((i: Issue) =>
            i.status === "done" && i.completedAt && (now - new Date(i.completedAt).getTime()) < oneDayMs
          );
          const createdToday = issues.filter((i: Issue) =>
            (now - new Date(i.createdAt).getTime()) < oneDayMs
          );

          const issuePrefix = company.issuePrefix;
          const inProgress = issues.filter((i: Issue) => i.status === "in_progress");
          const inReview = issues.filter((i: Issue) => i.status === "in_review");
          const blocked = issues.filter((i: Issue) => i.status === "blocked");

          const dateStr = new Date().toISOString().split("T")[0];
          const companyLabel = company.name ? ` \\- ${escapeMarkdownV2(company.name)}` : "";
          const digestLabel = effectiveDigestMode === "bidaily" ? "Digest" : "Daily Digest";
          const lines = [
            escapeMarkdownV2("📊") + ` *${escapeMarkdownV2(digestLabel)}${companyLabel} \\- ${escapeMarkdownV2(dateStr!)}*`,
            "",
            `${escapeMarkdownV2("✅")} Tasks completed: *${completedToday.length}*`,
            `${escapeMarkdownV2("📋")} Tasks created: *${createdToday.length}*`,
            `${escapeMarkdownV2("🤖")} Active agents: *${workingAgents.length}*/${escapeMarkdownV2(String(agents.length))}`,
          ];

          // The list is not ranked, so this names an agent that is working, not
          // the best one. The old "Top performer" label went unseen wherever the
          // filter above found nothing; do not resurrect it as a claim the data
          // cannot support.
          if (workingAgents.length > 0) {
            const workingAgent = workingAgents[0]!.name;
            lines.push(`${escapeMarkdownV2("⭐")} Working: *${escapeMarkdownV2(workingAgent)}*`);
          }

          const formatIssueItem = (i: Issue) => {
            const id = i.identifier ?? i.id;
            const idText = issuePrefix
              ? `[${escapeMarkdownV2(id)}](${rt.publicUrl}/${issuePrefix}/issues/${id})`
              : escapeMarkdownV2(id);
            return `  ${idText} \\- ${escapeMarkdownV2(i.title)}`;
          };

          if (inProgress.length > 0) {
            lines.push("", `${escapeMarkdownV2("🔄")} *In Progress \\(${inProgress.length}\\)*`);
            for (const i of inProgress.slice(0, 10)) lines.push(formatIssueItem(i));
          }
          if (inReview.length > 0) {
            lines.push("", `${escapeMarkdownV2("🔍")} *In Review \\(${inReview.length}\\)*`);
            for (const i of inReview.slice(0, 10)) lines.push(formatIssueItem(i));
          }
          if (blocked.length > 0) {
            lines.push("", `${escapeMarkdownV2("🚫")} *Blocked \\(${blocked.length}\\)*`);
            for (const i of blocked.slice(0, 10)) lines.push(formatIssueItem(i));
          }

          const digestThreadId = await resolveDigestThreadId(ctx, rt.token, chatId, rt.config.digestTopicId);

          await sendMessage(ctx, rt.token, chatId, lines.join("\n"), {
            parseMode: "MarkdownV2",
            messageThreadId: digestThreadId,
          });
        } catch (err) {
          ctx.logger.error("Daily digest failed for company", { companyId: company.id, error: String(err) });
          const text = [
            escapeMarkdownV2("📊") + " *Daily Digest*",
            "",
            escapeMarkdownV2("Could not generate digest. Check plugin logs for details."),
          ].join("\n");

          const errorThreadId = await resolveDigestThreadId(
            ctx,
            rt.token,
            chatId,
            rt.config.errorsTopicId || rt.config.digestTopicId,
          );

          await sendMessage(ctx, rt.token, chatId, text, {
            parseMode: "MarkdownV2",
            messageThreadId: errorThreadId,
          });
        }
      }
    });

    // --- Phase 1: Escalation support ---

    // Register escalate_to_human tool - 3-arg signature with ToolRunContext
    ctx.tools.register("escalate_to_human", {
      displayName: "Escalate to Human",
      description: "Escalate a conversation to a human when you cannot handle it confidently",
      parametersSchema: {
        type: "object",
        properties: {
          reason: {
            type: "string",
            enum: ["low_confidence", "explicit_request", "policy_violation", "unknown_intent"],
            description: "Why this conversation needs human attention",
          },
          conversationSummary: {
            type: "string",
            description: "Brief summary of the conversation context and what the user needs",
          },
          suggestedActions: {
            type: "array",
            items: { type: "string" },
            description: "Suggested actions the human responder could take",
          },
          suggestedReply: {
            type: "string",
            description: "A draft reply the human can send or modify",
          },
          confidenceScore: {
            type: "number",
            minimum: 0,
            maximum: 1,
            description: "How confident the agent is (0-1). Lower values indicate greater need for human help",
          },
          originChatId: { type: "string" },
          originThreadId: { type: "string" },
          originMessageId: { type: "string" },
          sessionId: { type: "string", description: "Session ID for routing reply back" },
          transport: { type: "string", enum: ["native", "acp"], description: "Transport type for reply routing" },
        },
        required: ["reason", "conversationSummary"],
      },
    }, async (params: unknown, runCtx) => {
      const rt = ensureRuntime();
      if (!rt) return { error: "Telegram plugin is not configured yet" };
      const p = params as Record<string, unknown>;
      const escalationId = crypto.randomUUID();
      const timeoutMs = rt.config.escalationTimeoutMs || 900000;
      const defaultAction = rt.config.escalationDefaultAction || "defer";

      const resolvedEscalationChatId = await resolveChat(
        ctx,
        runCtx.companyId,
        rt.config.escalationChatId,
      );
      if (!resolvedEscalationChatId) {
        ctx.logger.warn("Escalation received but no escalationChatId configured");
        return { error: "No escalation channel configured" };
      }

      const escalationEvent: EscalationEvent = {
        escalationId,
        agentId: runCtx.agentId,
        companyId: runCtx.companyId,
        reason: p.reason as EscalationEvent["reason"],
        context: {
          conversationHistory: [],
          agentReasoning: String(p.conversationSummary ?? ""),
          suggestedActions: (p.suggestedActions as string[]) ?? [],
          suggestedReply: p.suggestedReply ? String(p.suggestedReply) : undefined,
          confidenceScore: typeof p.confidenceScore === "number" ? p.confidenceScore : undefined,
        },
        timeout: {
          durationMs: timeoutMs,
          defaultAction,
        },
        originChatId: p.originChatId ? String(p.originChatId) : undefined,
        originThreadId: p.originThreadId ? String(p.originThreadId) : undefined,
        originMessageId: p.originMessageId ? String(p.originMessageId) : undefined,
        transport: p.transport as "native" | "acp" | undefined,
        sessionId: p.sessionId ? String(p.sessionId) : undefined,
      };

      await escalationManager.create(ctx, rt.token, escalationEvent, resolvedEscalationChatId);

      // Send hold message to the originating chat if configured
      if (rt.config.escalationHoldMessage && escalationEvent.originChatId) {
        const holdText = escapeMarkdownV2(rt.config.escalationHoldMessage);
        await sendMessage(ctx, rt.token, escalationEvent.originChatId, holdText, {
          parseMode: "MarkdownV2",
          messageThreadId: escalationEvent.originThreadId ? Number(escalationEvent.originThreadId) : undefined,
          replyToMessageId: escalationEvent.originMessageId ? Number(escalationEvent.originMessageId) : undefined,
        });
      }

      return { content: JSON.stringify({ status: "escalated", escalationId }) };
    });

    // --- Phase 2: Register handoff_to_agent tool ---
    ctx.tools.register("handoff_to_agent", {
      displayName: "Handoff to Agent",
      description: "Hand off work to another agent in this thread",
      parametersSchema: {
        type: "object",
        properties: {
          targetAgent: { type: "string", description: "Name of agent to hand off to" },
          reason: { type: "string", description: "Why you're handing off" },
          contextSummary: { type: "string", description: "Summary for the target agent" },
          requiresApproval: { type: "boolean", default: true, description: "Wait for human approval before target starts" },
          chatId: { type: "string", description: "Telegram chat ID" },
          threadId: { type: "number", description: "Telegram thread ID" },
        },
        required: ["targetAgent", "reason", "contextSummary"],
      },
    }, async (params: unknown, runCtx) => {
      const rt = ensureRuntime();
      if (!rt) return { error: "Telegram plugin is not configured yet" };
      return handleHandoffToolCall(ctx, rt.token, params as Record<string, unknown>, runCtx.companyId, runCtx.agentId);
    });

    // --- Phase 2: Register discuss_with_agent tool ---
    ctx.tools.register("discuss_with_agent", {
      displayName: "Discuss with Agent",
      description: "Start a back-and-forth conversation with another agent",
      parametersSchema: {
        type: "object",
        properties: {
          targetAgent: { type: "string", description: "Name of agent to discuss with" },
          topic: { type: "string", description: "Discussion topic" },
          initialMessage: { type: "string", description: "First message to send" },
          maxTurns: { type: "number", default: 10, description: "Maximum conversation turns" },
          humanCheckpointAt: { type: "number", description: "Pause for human approval at this turn" },
          chatId: { type: "string", description: "Telegram chat ID" },
          threadId: { type: "number", description: "Telegram thread ID" },
        },
        required: ["targetAgent", "topic", "initialMessage"],
      },
    }, async (params: unknown, runCtx) => {
      const rt = ensureRuntime();
      if (!rt) return { error: "Telegram plugin is not configured yet" };
      return handleDiscussToolCall(ctx, rt.token, params as Record<string, unknown>, runCtx.companyId, runCtx.agentId);
    });

    // --- Phase 5: Register register_watch tool ---
    ctx.tools.register("register_watch", {
      displayName: "Register Watch",
      description: "Register a proactive watch that monitors entities and sends suggestions",
      parametersSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Name of the watch" },
          description: { type: "string", description: "What this watch monitors" },
          entityType: { type: "string", enum: ["issue", "agent", "company", "custom"], description: "Type of entity to watch" },
          conditions: {
            type: "array",
            items: {
              type: "object",
              properties: {
                field: { type: "string" },
                operator: { type: "string", enum: ["gt", "lt", "eq", "ne", "contains", "exists"] },
                value: {},
              },
              required: ["field", "operator", "value"],
            },
            description: "Conditions that trigger the watch",
          },
          template: { type: "string", description: "Message template with {{field}} placeholders" },
          builtinTemplate: { type: "string", enum: ["invoice-overdue", "lead-stale"], description: "Use a built-in template instead" },
          chatId: { type: "string", description: "Telegram chat ID for suggestions" },
          threadId: { type: "number", description: "Telegram thread ID for suggestions" },
        },
        required: ["chatId"],
      },
    }, async (params: unknown, runCtx) => {
      return handleRegisterWatch(ctx, params as Record<string, unknown>, runCtx.companyId);
    });

    // --- Phase 1: Escalation timeout checker job ---
    ctx.jobs.register("check-escalation-timeouts", async () => {
      const rt = ensureRuntime();
      if (!rt) return;
      try {
        await escalationManager.checkTimeouts(ctx, rt.token);
      } catch (err) {
        ctx.logger.error("Escalation timeout check failed", { error: String(err) });
      }
    });

    // --- Phase 5: Watch checker job ---
    ctx.jobs.register("check-watches", async () => {
      const rt = ensureRuntime();
      if (!rt) return;
      try {
        await checkWatches(ctx, rt.token, {
          maxSuggestionsPerHourPerCompany: rt.config.maxSuggestionsPerHourPerCompany ?? 10,
          watchDeduplicationWindowMs: rt.config.watchDeduplicationWindowMs ?? 86400000,
        });
      } catch (err) {
        ctx.logger.error("Watch check failed", { error: String(err) });
      }
    });

    ctx.logger.info("Telegram bot plugin handlers registered; waiting for delivered configuration");
  },

  /**
   * The host delivers stored config here — at worker startup and on every
   * save. This is the ONLY place `runtime` is built or refreshed; see
   * "Runtime state" above.
   */
  async onConfigChanged(newConfig): Promise<void> {
    const ctx = _pluginCtx;
    if (!ctx) return;

    await queueBootstrap(async () => {
      const companyId = await identifyDeliveredCompany(ctx, newConfig);
      if (!companyId) {
        ctx.logger.warn(
          "Telegram plugin could not attribute a configuration delivery to a company; leaving current runtime unchanged",
        );
        if (!runtime) {
          runtimeHealth = {
            status: "degraded",
            message: "Configuration was delivered but no company answered a scoped configuration read.",
          };
        }
        return;
      }

      try {
        await bootstrapRuntime(ctx, companyId, newConfig);
      } catch (err) {
        const error = String(err);
        ctx.logger.error("Telegram plugin failed to apply a configuration change", { error, companyId });
        runtimeHealth = { status: "degraded", message: `Applying the delivered configuration failed: ${error}` };
      }
    });
  },

  async onValidateConfig(config) {
    const secretRefErrors = validateSecretRefFields(config);
    if (secretRefErrors.length > 0) {
      return { ok: false, errors: secretRefErrors };
    }
    const allowlistErrors = validateTelegramAllowlists(config);
    if (allowlistErrors.length > 0) {
      return { ok: false, errors: allowlistErrors };
    }
    const topicErrors = validateConfiguredTopicIds(config as Record<string, unknown>);
    if (topicErrors.length > 0) {
      return { ok: false, errors: topicErrors };
    }
    return { ok: true };
  },

  async onHealth(): Promise<PluginHealthDiagnostics> {
    return runtimeHealth;
  },
});

export async function handleUpdate(
  ctx: PluginContext,
  token: string,
  config: TelegramConfig,
  update: TelegramUpdate,
  baseUrl: string,
  publicUrl?: string,
  boardApiToken?: string,
): Promise<void> {
  if (!isTelegramUpdateAllowed(config, update)) {
    const fromId = update.message?.from?.id ?? update.callback_query?.from.id;
    const chatId = update.message?.chat.id ?? update.callback_query?.message?.chat.id;
    ctx.logger.warn("Blocked unauthorized Telegram update", {
      updateId: update.update_id,
      fromId,
      chatId,
    });
    return;
  }

  if (update.callback_query) {
    const companyId = await resolveCallbackCompanyId(ctx, update.callback_query);
    const boardApiToken = await resolveBoardApiToken(ctx, config, companyId);
    await handleCallbackQuery(ctx, token, update.callback_query, baseUrl, boardApiToken);
    return;
  }

  const msg = update.message;
  if (!msg) return;

  const chatId = String(msg.chat.id);
  const threadId = msg.message_thread_id;

  // Phase 3: Handle media messages
  const hasMedia = !!(msg.voice || msg.audio || msg.video_note || msg.document || msg.photo);
  if (hasMedia) {
    const companyId = await resolveCompanyIdOrNull(ctx, chatId);
    if (companyId) {
      const handled = await handleMediaMessage(ctx, token, msg as Parameters<typeof handleMediaMessage>[2], {
        briefAgentId: config.briefAgentId ?? "",
        briefAgentChatIds: config.briefAgentChatIds ?? [],
        transcriptionApiKeyRef: config.transcriptionApiKeyRef ?? "",
        publicUrl,
      }, companyId);
      if (handled) return;
    } else {
      ctx.logger.debug("Ignoring media message from unlinked chat", { chatId });
    }
  }

  if (!msg.text) return;

  const text = msg.text;

  // Route thread messages to agent sessions
  if (threadId) {
    const isCommand = text.startsWith("/");
    if (!isCommand) {
      const companyId = await resolveCompanyIdOrNull(ctx, chatId);
      if (companyId) {
        const replyToId = msg.reply_to_message?.message_id;
        const routed = await routeMessageToAgent(ctx, token, chatId, threadId, text, replyToId, companyId);
        if (routed) return;
      } else {
        ctx.logger.debug("Not routing thread message from unlinked chat", { chatId });
      }
    }
  }

  const botCommand = msg.entities?.find((e) => e.type === "bot_command" && e.offset === 0);
  if (botCommand && config.enableCommands) {
    const fullCommand = text.slice(botCommand.offset, botCommand.offset + botCommand.length);
    const command = fullCommand.replace(/^\//, "").replace(/@.*$/, "");
    const args = text.slice(botCommand.offset + botCommand.length).trim();
    // undefined on unlinked chats: /connect and /help still work, and the
    // company-scoped handlers answer with their "not linked" guidance.
    const companyId = (await resolveCompanyIdOrNull(ctx, chatId)) ?? undefined;

    // Phase 4: Check custom commands first
    if (command === "commands") {
      await handleCommandsCommand(ctx, token, chatId, args, threadId, companyId);
      return;
    }

    const handledCustom = await tryCustomCommand(ctx, token, chatId, command, args, threadId, companyId);
    if (handledCustom) return;

    // Built-in commands
    const boardApiToken = command === "approve" ? await resolveBoardApiToken(ctx, config, companyId) : undefined;
    await handleCommand(ctx, token, chatId, command, args, threadId, baseUrl, publicUrl, companyId, boardApiToken, config.maxAgentsPerThread);
    return;
  }

  if (config.enableInbound && msg.reply_to_message?.from?.is_bot) {
    const replyToId = msg.reply_to_message.message_id;
    const mapping = await ctx.state.get({
      scopeKind: "instance",
      stateKey: `msg_${chatId}_${replyToId}`,
    }) as { entityId: string; entityType: string; companyId: string } | null;

    if (mapping && mapping.entityType === "escalation") {
      const escalationManager = new EscalationManager();
      const responderId = `telegram:${msg.from?.username ?? msg.from?.id ?? chatId}`;
      await escalationManager.respond(ctx, token, mapping.entityId, {
        escalationId: mapping.entityId,
        responderId,
        responseText: text,
        action: "reply_to_customer",
      });
      await ctx.metrics.write(METRIC_NAMES.inboundRouted, 1);
      ctx.logger.info("Routed Telegram reply to escalation", {
        escalationId: mapping.entityId,
        from: msg.from?.username,
      });
    } else if (mapping && mapping.entityType === "issue") {
      try {
        // Use the SDK (not ctx.http.fetch) because the plugin sandbox blocks
        // outbound fetches to private IPs like 127.0.0.1 for SSRF protection.
        // The SDK's createComment goes through the plugin RPC bridge instead.
        await ctx.issues.createComment(mapping.entityId, text, mapping.companyId);
        await ctx.metrics.write(METRIC_NAMES.inboundRouted, 1);
        ctx.logger.info("Routed Telegram reply to issue comment", {
          issueId: mapping.entityId,
          from: msg.from?.username,
        });
      } catch (err) {
        ctx.logger.error("Failed to route inbound message", {
          issueId: mapping.entityId,
          error: String(err),
        });
      }
    }
  }
}

async function handleCallbackQuery(
  ctx: PluginContext,
  token: string,
  query: NonNullable<TelegramUpdate["callback_query"]>,
  baseUrl: string,
  boardApiToken?: string,
): Promise<void> {
  const data = query.data;
  if (!data) return;

  const actor = query.from.username ?? query.from.first_name ?? String(query.from.id);
  const chatId = query.message?.chat.id ? String(query.message.chat.id) : null;
  const messageId = query.message?.message_id;

  // Must precede the "approve_" branch below only by intent, not by necessity:
  // these are "cmd_approve_"/"cmd_reject_" and cannot collide with it. Kept
  // adjacent so the two approval flows are read together.
  if (isWorkflowApprovalCallback(data)) {
    await resolveWorkflowApprovalCallback(ctx, token, data, query.id, actor, messageId);
    return;
  }

  if (data.startsWith("approve_")) {
    const approvalId = data.replace("approve_", "");
    ctx.logger.info("Approval button clicked", { approvalId, actor });

    try {
      await fetchPaperclipApi(
        ctx,
        `${baseUrl}/api/approvals/${approvalId}/approve`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...buildPaperclipAuthHeaders(boardApiToken),
          },
          body: JSON.stringify({ decidedByUserId: `telegram:${actor}` }),
        },
      );

      await answerCallbackQuery(ctx, token, query.id, "Approved");

      if (chatId && messageId) {
        await editMessage(
          ctx,
          token,
          chatId,
          messageId,
          `${escapeMarkdownV2("✅")} *Approved* by ${escapeMarkdownV2(actor)}`,
          { parseMode: "MarkdownV2" },
        );
      }
    } catch (err) {
      await answerCallbackQuery(ctx, token, query.id, `Failed: ${String(err)}`);
    }
    return;
  }

  if (data.startsWith("esc_")) {
    const parts = data.split("_");
    const action = parts[1] ?? "";
    const escalationId = parts.slice(2).join("_");
    const escalationManager = new EscalationManager();
    await escalationManager.handleCallback(
      ctx,
      token,
      action,
      escalationId,
      actor,
      query.id,
      chatId,
      messageId,
    );
    await answerCallbackQuery(ctx, token, query.id, `Escalation: ${action}`);
    return;
  }

  if (data.startsWith("reject_")) {
    const approvalId = data.replace("reject_", "");
    ctx.logger.info("Rejection button clicked", { approvalId, actor });

    try {
      await fetchPaperclipApi(
        ctx,
        `${baseUrl}/api/approvals/${approvalId}/reject`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...buildPaperclipAuthHeaders(boardApiToken),
          },
          body: JSON.stringify({ decidedByUserId: `telegram:${actor}` }),
        },
      );

      await answerCallbackQuery(ctx, token, query.id, "Rejected");

      if (chatId && messageId) {
        await editMessage(
          ctx,
          token,
          chatId,
          messageId,
          `${escapeMarkdownV2("❌")} *Rejected* by ${escapeMarkdownV2(actor)}`,
          { parseMode: "MarkdownV2" },
        );
      }
    } catch (err) {
      await answerCallbackQuery(ctx, token, query.id, `Failed: ${String(err)}`);
    }
    return;
  }

  if (data.startsWith("handoff_approve_")) {
    const handoffId = data.replace("handoff_approve_", "");
    await handleHandoffApproval(ctx, token, handoffId, actor, query.id, chatId, messageId);
    await answerCallbackQuery(ctx, token, query.id, "Handoff approved");
    return;
  }

  if (data.startsWith("handoff_reject_")) {
    const handoffId = data.replace("handoff_reject_", "");
    await handleHandoffRejection(ctx, token, handoffId, actor, query.id, chatId, messageId);
    await answerCallbackQuery(ctx, token, query.id, "Handoff rejected");
    return;
  }

  await answerCallbackQuery(ctx, token, query.id, "Unknown action");
}

runWorker(plugin, import.meta.url);
