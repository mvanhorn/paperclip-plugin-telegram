export const PLUGIN_ID = "paperclip-plugin-telegram";
export const PLUGIN_VERSION = "0.1.0";

export const DEFAULT_CONFIG = {
  telegramBotTokenRef: "",
  defaultChatId: "",
  approvalsChatId: "",
  errorsChatId: "",
  paperclipBaseUrl: "http://localhost:3100",
  notifyOnIssueCreated: true,
  notifyOnIssueDone: true,
  notifyOnApprovalCreated: true,
  notifyOnAgentError: true,
  enableCommands: true,
  enableInbound: true,
  dailyDigestEnabled: false,
  dailyDigestTime: "09:00",
  topicRouting: false,
  escalationChatId: "",
  escalationTimeoutMs: 900000,
  escalationDefaultAction: "defer",
  escalationHoldMessage: "Let me check on that - I'll get back to you shortly.",
} as const;

export const METRIC_NAMES = {
  sent: "telegram_notifications_sent",
  failed: "telegram_notification_failures",
  commandsHandled: "telegram_commands_handled",
  inboundRouted: "telegram_inbound_routed",
  escalationsCreated: "telegram_escalations_created",
  escalationsResolved: "telegram_escalations_resolved",
  escalationsTimedOut: "telegram_escalations_timed_out",
} as const;
