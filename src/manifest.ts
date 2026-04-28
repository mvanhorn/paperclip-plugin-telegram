import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { PLUGIN_ID, PLUGIN_VERSION } from "./constants.js";

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
