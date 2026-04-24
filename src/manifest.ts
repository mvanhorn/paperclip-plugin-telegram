import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { DEFAULT_CONFIG, PLUGIN_ID, PLUGIN_VERSION, MAX_AGENTS_PER_THREAD } from "./constants.js";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Telegram Bot",
  description:
    "Bidirectional Telegram integration: push notifications, bot commands, escalation to humans, multi-agent sessions (native + ACP), media pipeline with transcription, custom workflow commands, and proactive suggestion watches.",
  author: "mvanhorn",
  categories: ["connector", "automation"],
  capabilities: [
    "companies.read",
    "issues.read",
    "issues.create",
    "issues.update",
    "issue.comments.read",
    "issue.comments.create",
    "agents.read",
    "agents.invoke",
    "agent.sessions.create",
    "agent.sessions.list",
    "agent.sessions.send",
    "agent.sessions.close",
    "agent.tools.register",
    "events.subscribe",
    "events.emit",
    "plugin.state.read",
    "plugin.state.write",
    "http.outbound",
    "secrets.read-ref",
    "activity.log.write",
    "metrics.write",
    "jobs.schedule",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      // --- Connection ---
      telegramBotTokenRef: {
        type: "string",
        format: "secret-ref",
        title: "Telegram Bot Token (secret reference)",
        description:
          "Secret UUID for your Telegram Bot token. Create the secret in Settings > Secrets, then paste its UUID here. Get a token from @BotFather.",
        default: DEFAULT_CONFIG.telegramBotTokenRef,
      },
      paperclipBaseUrl: {
        type: "string",
        title: "Paperclip API URL (internal)",
        description:
          "Internal URL of the Paperclip API server. Used for API calls (approvals, comments). Keep as localhost for same-server deployments.",
        default: DEFAULT_CONFIG.paperclipBaseUrl,
      },
      paperclipPublicUrl: {
        type: "string",
        title: "Paperclip Public URL",
        description:
          "Public URL for issue links in Telegram messages (e.g. https://pc.example.com). Falls back to API URL if empty.",
        default: DEFAULT_CONFIG.paperclipPublicUrl,
      },

      // --- Chat routing ---
      defaultChatId: {
        type: "string",
        title: "Default Chat ID (fallback)",
        description:
          "Fallback Telegram chat ID for notifications when no per-company chat is configured. Use /connect in a chat to set per-company routing.",
        default: DEFAULT_CONFIG.defaultChatId,
      },
      approvalsChatId: {
        type: "string",
        title: "Approvals Chat ID",
        description:
          "Chat ID for approval requests. Falls back to default chat.",
        default: DEFAULT_CONFIG.approvalsChatId,
      },
      errorsChatId: {
        type: "string",
        title: "Errors Chat ID",
        description:
          "Chat ID for agent error notifications. Falls back to default chat.",
        default: DEFAULT_CONFIG.errorsChatId,
      },
      escalationChatId: {
        type: "string",
        title: "Escalation Chat ID",
        description:
          "Telegram chat ID where escalations are sent for human review. If empty, escalations are logged but not forwarded.",
        default: DEFAULT_CONFIG.escalationChatId,
      },
      topicRouting: {
        type: "boolean",
        title: "Forum topic routing",
        description:
          "Map Telegram forum topics to Paperclip projects. Requires the bot to be in a group with forum topics enabled.",
        default: DEFAULT_CONFIG.topicRouting,
      },

      // --- Notifications ---
      notifyOnIssueCreated: {
        type: "boolean",
        title: "Notify on issue created",
        default: DEFAULT_CONFIG.notifyOnIssueCreated,
      },
      notifyOnIssueDone: {
        type: "boolean",
        title: "Notify on issue completed",
        default: DEFAULT_CONFIG.notifyOnIssueDone,
      },
      notifyOnIssueAssigned: {
        type: "boolean",
        title: "Notify on issue assignment changes",
        description:
          "Send a message when an existing issue's assigneeUserId or assigneeAgentId changes. Complements notifyOnIssueCreated (which covers initial assignment on creation).",
        default: DEFAULT_CONFIG.notifyOnIssueAssigned,
      },
      onlyNotifyIfAssignedTo: {
        type: "string",
        title: "Only notify when assigned to this user (user ID)",
        description:
          "Optional. Paste your Paperclip user ID here to restrict assignment notifications to items newly assigned to you. Leave empty to notify on every assignment change. To find your user ID: sign in to Paperclip in a browser and visit /api/cli-auth/me — copy the `userId` field (a string like `mrvhBEpPds85TGeEjlAHviP0VdOHgymm`).",
        default: DEFAULT_CONFIG.onlyNotifyIfAssignedTo,
      },
      notifyOnApprovalCreated: {
        type: "boolean",
        title: "Notify on approval requested",
        default: DEFAULT_CONFIG.notifyOnApprovalCreated,
      },
      notifyOnAgentError: {
        type: "boolean",
        title: "Notify on agent error",
        default: DEFAULT_CONFIG.notifyOnAgentError,
      },

      // --- Digest ---
      digestMode: {
        type: "string",
        title: "Digest mode",
        description: "off = disabled, daily = once per day, bidaily = twice per day, tridaily = three times per day.",
        enum: ["off", "daily", "bidaily", "tridaily"],
        default: DEFAULT_CONFIG.digestMode,
      },
      dailyDigestTime: {
        type: "string",
        title: "Digest time (HH:MM UTC)",
        description: "Time to send the digest. Used for daily mode and first slot of bidaily mode.",
        default: DEFAULT_CONFIG.dailyDigestTime,
      },
      bidailySecondTime: {
        type: "string",
        title: "Bidaily second time (HH:MM UTC)",
        description: "Second digest time for bidaily mode.",
        default: DEFAULT_CONFIG.bidailySecondTime,
      },
      tridailyTimes: {
        type: "string",
        title: "Tridaily times (HH:MM,HH:MM,HH:MM UTC)",
        description: "Three comma-separated times for tridaily mode.",
        default: DEFAULT_CONFIG.tridailyTimes,
      },

      // --- Bot interaction ---
      enableCommands: {
        type: "boolean",
        title: "Enable bot commands",
        description:
          "Allow users to interact with Paperclip via Telegram bot commands (/status, /issues, /agents).",
        default: DEFAULT_CONFIG.enableCommands,
      },
      enableInbound: {
        type: "boolean",
        title: "Enable inbound message routing",
        description:
          "Route Telegram messages to Paperclip issue comments. Messages sent in reply to a notification get attached to that issue.",
        default: DEFAULT_CONFIG.enableInbound,
      },

      // --- Escalation ---
      escalationTimeoutMs: {
        type: "number",
        title: "Escalation Timeout (ms)",
        description:
          "How long to wait for a human response before taking the default action. Default: 900000 (15 minutes).",
        default: DEFAULT_CONFIG.escalationTimeoutMs,
      },
      escalationDefaultAction: {
        type: "string",
        title: "Escalation Default Action",
        description:
          "What to do when an escalation times out: defer (do nothing), auto_reply (send suggested reply), or close.",
        enum: ["defer", "auto_reply", "close"],
        default: DEFAULT_CONFIG.escalationDefaultAction,
      },
      escalationHoldMessage: {
        type: "string",
        title: "Escalation Hold Message",
        description:
          "Message sent to the user when their conversation is escalated to a human.",
        default: DEFAULT_CONFIG.escalationHoldMessage,
      },

      // --- Agent sessions ---
      maxAgentsPerThread: {
        type: "number",
        title: "Max Agents Per Thread",
        description:
          "Maximum number of concurrent agent sessions allowed in a single thread.",
        default: MAX_AGENTS_PER_THREAD,
      },

      // --- Media pipeline ---
      briefAgentId: {
        type: "string",
        title: "Brief Agent ID",
        description: "Agent ID for processing media intake briefs. Leave empty to disable media pipeline.",
        default: DEFAULT_CONFIG.briefAgentId,
      },
      briefAgentChatIds: {
        type: "array",
        items: { type: "string" },
        title: "Brief Agent Intake Chat IDs",
        description: "Telegram chat IDs where media is routed to the Brief Agent. Media in other chats goes to active agent sessions.",
        default: DEFAULT_CONFIG.briefAgentChatIds,
      },
      transcriptionApiKeyRef: {
        type: "string",
        format: "secret-ref",
        title: "Transcription API Key (secret reference)",
        description: "Secret UUID for your OpenAI API key used for Whisper transcription. Create the secret in Settings > Secrets, then paste its UUID here.",
        default: DEFAULT_CONFIG.transcriptionApiKeyRef,
      },

      // --- Proactive watches ---
      maxSuggestionsPerHourPerCompany: {
        type: "number",
        title: "Max Suggestions per Hour per Company",
        description: "Rate limit for proactive watch suggestions.",
        default: DEFAULT_CONFIG.maxSuggestionsPerHourPerCompany,
      },
      watchDeduplicationWindowMs: {
        type: "number",
        title: "Watch Deduplication Window (ms)",
        description: "Suppress duplicate watch suggestions for the same entity within this window. Default: 86400000 (24 hours).",
        default: DEFAULT_CONFIG.watchDeduplicationWindowMs,
      },
    },
    required: ["telegramBotTokenRef"],
  },
  jobs: [
    {
      jobKey: "telegram-daily-digest",
      displayName: "Telegram Digest",
      description: "Send a summary of agent activity to Telegram (daily or bidaily).",
      schedule: "0 * * * *",
    },
    {
      jobKey: "check-escalation-timeouts",
      displayName: "Check Escalation Timeouts",
      description: "Check for timed-out escalations and apply default actions.",
      schedule: "* * * * *",
    },
    {
      jobKey: "check-watches",
      displayName: "Check Proactive Watches",
      description: "Evaluate registered watches and send suggestions when conditions are met.",
      schedule: "*/15 * * * *",
    },
  ],
  tools: [
    {
      name: "escalate_to_human",
      displayName: "Escalate to Human",
      description: "Escalate a conversation to a human when you cannot handle it confidently",
      parametersSchema: { type: "object" },
    },
    {
      name: "handoff_to_agent",
      displayName: "Handoff to Agent",
      description: "Hand off work to another agent in this thread",
      parametersSchema: { type: "object" },
    },
    {
      name: "discuss_with_agent",
      displayName: "Discuss with Agent",
      description: "Start a back-and-forth conversation with another agent",
      parametersSchema: { type: "object" },
    },
    {
      name: "register_watch",
      displayName: "Register Watch",
      description: "Register a proactive watch that monitors entities and sends suggestions",
      parametersSchema: { type: "object" },
    },
  ],
};

export default manifest;
