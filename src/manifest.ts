import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { PLUGIN_ID, PLUGIN_VERSION } from "./constants.js";
import { telegramTools } from "./tool-declarations.js";

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
    "projects.read",
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
    "instance.settings.register",
    "ui.page.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  instanceConfigSchema: {
    type: "object",
    additionalProperties: true,
    properties: {
      // Secret refs accept BOTH shapes on purpose.
      //
      // Older hosts store a bare secret UUID string. Current hosts validate
      // config against this schema AND separately enforce their own secret-ref
      // rule requiring an object: { type: "secret_ref", secretId, version? }.
      // With `type: "string"` alone the two are mutually unsatisfiable — the
      // object fails this schema ("must be string") and the string fails the
      // host ('must use { type: "secret_ref", ... }') — so the plugin cannot be
      // configured at all on such a host.
      telegramBotTokenRef: {
        type: ["string", "object"],
        format: "secret-ref",
      },
      paperclipBoardApiTokenRef: {
        type: ["string", "object"],
        format: "secret-ref",
      },
      transcriptionApiKeyRef: {
        type: ["string", "object"],
        format: "secret-ref",
      },
    },
  },
  ui: {
    slots: [
      {
        type: "settingsPage",
        id: "telegram-settings",
        displayName: "Telegram Settings",
        exportName: "TelegramSettingsPage",
      },
    ],
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
  tools: Object.entries(telegramTools).map(([name, declaration]) => ({ name, ...declaration })),
};

export default manifest;
