export const PLUGIN_ID = "paperclip-plugin-telegram";
export const PLUGIN_VERSION = "0.3.0";

export const DEFAULT_CONFIG = {
  telegramBotTokenRef: "",
  defaultChatId: "",
  approvalsChatId: "",
  errorsChatId: "",
  paperclipBaseUrl: "http://localhost:3100",
  paperclipPublicUrl: "",
  notifyOnIssueCreated: true,
  notifyOnIssueDone: true,
  notifyOnIssueAssigned: false,
  onlyNotifyIfAssignedTo: "",
  notifyOnApprovalCreated: true,
  notifyOnAgentError: true,
  enableCommands: true,
  enableInbound: true,
  digestMode: "off" as "off" | "daily" | "bidaily" | "tridaily",
  dailyDigestTime: "09:00",
  bidailySecondTime: "17:00",
  tridailyTimes: "07:00,13:00,19:00",
  topicRouting: false,
  escalationChatId: "",
  escalationTimeoutMs: 900000,
  escalationDefaultAction: "defer",
  escalationHoldMessage: "Let me check on that - I'll get back to you shortly.",
  // Phase 3: Media Pipeline
  briefAgentId: "",
  briefAgentChatIds: [] as string[],
  transcriptionApiKeyRef: "",
  // Phase 5: Proactive Suggestions
  maxSuggestionsPerHourPerCompany: 10,
  watchDeduplicationWindowMs: 86400000, // 24h
} as const;

export const MAX_AGENTS_PER_THREAD = 5;
export const MAX_CONVERSATION_TURNS = 50;
export const DEFAULT_CONVERSATION_TURNS = 10;

export const METRIC_NAMES = {
  sent: "telegram_notifications_sent",
  failed: "telegram_notification_failures",
  commandsHandled: "telegram_commands_handled",
  inboundRouted: "telegram_inbound_routed",
  escalationsCreated: "telegram_escalations_created",
  escalationsResolved: "telegram_escalations_resolved",
  escalationsTimedOut: "telegram_escalations_timed_out",
  mediaProcessed: "telegram_media_processed",
  commandsExecuted: "telegram_custom_commands_executed",
  suggestionsEmitted: "telegram_suggestions_emitted",
} as const;

// Cross-plugin ACP event names
export const ACP_SPAWN_EVENT = "acp-spawn";
export const ACP_OUTPUT_EVENT = "plugin.paperclip-plugin-acp.output";
