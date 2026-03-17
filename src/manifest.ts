import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { DEFAULT_CONFIG, PLUGIN_ID, PLUGIN_VERSION } from "./constants.js";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Telegram Bot",
  description:
    "Bidirectional Telegram integration: push notifications on agent events, receive bot commands, approve requests with inline buttons, and route forum topics to projects.",
  author: "mvanhorn",
  categories: ["connector", "automation"],
  capabilities: [
    "companies.read",
    "issues.read",
    "issues.create",
    "agents.read",
    "events.subscribe",
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
      telegramBotTokenRef: {
        type: "string",
        title: "Telegram Bot Token (secret reference)",
        description:
          "Reference to the Telegram Bot token stored in your secret provider. Get one from @BotFather.",
        default: DEFAULT_CONFIG.telegramBotTokenRef,
      },
      defaultChatId: {
        type: "string",
        title: "Default Chat ID",
        description:
          "Telegram chat ID to send notifications to. Use a group chat ID (negative number) or a user chat ID.",
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
      dailyDigestEnabled: {
        type: "boolean",
        title: "Daily digest",
        description: "Send a daily summary of agent activity.",
        default: DEFAULT_CONFIG.dailyDigestEnabled,
      },
      dailyDigestTime: {
        type: "string",
        title: "Digest time (HH:MM UTC)",
        description: "Time to send the daily digest in UTC.",
        default: DEFAULT_CONFIG.dailyDigestTime,
      },
      topicRouting: {
        type: "boolean",
        title: "Forum topic routing",
        description:
          "Map Telegram forum topics to Paperclip projects. Requires the bot to be in a group with forum topics enabled.",
        default: DEFAULT_CONFIG.topicRouting,
      },
      paperclipBaseUrl: {
        type: "string",
        title: "Paperclip Base URL",
        description:
          "Base URL of the Paperclip API server.",
        default: DEFAULT_CONFIG.paperclipBaseUrl,
      },
    },
    required: ["telegramBotTokenRef", "defaultChatId"],
  },
  jobs: [
    {
      jobKey: "telegram-daily-digest",
      displayName: "Telegram Daily Digest",
      description: "Send a daily summary of agent activity to Telegram.",
      schedule: "0 9 * * *",
    },
  ],
};

export default manifest;
