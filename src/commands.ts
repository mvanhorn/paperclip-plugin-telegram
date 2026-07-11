import type { PluginContext, PluginEvent, Agent, Issue, Project } from "@paperclipai/plugin-sdk";
import { sendMessage, escapeMarkdownV2, sendChatAction } from "./telegram-api.js";
import { METRIC_NAMES } from "./constants.js";
import { handleAcpCommand } from "./acp-bridge.js";
import { buildPaperclipAuthHeaders, fetchPaperclipApi } from "./paperclip-api.js";

type BotCommand = {
  command: string;
  description: string;
};

type TopicMappingRecord = {
  projectId?: string;
  projectName: string;
  topicId: string;
};

type TopicMappingValue = string | TopicMappingRecord;
type TopicMap = Record<string, TopicMappingValue>;

export const BOT_COMMANDS: BotCommand[] = [
  { command: "create", description: "Create a new task (assigned to CEO agent)" },
  { command: "status", description: "Company health: active agents, open issues" },
  { command: "issues", description: "List open issues (optionally by project)" },
  { command: "agents", description: "List agents with current status" },
  { command: "approve", description: "Approve a pending request by ID" },
  { command: "help", description: "Show available commands" },
  { command: "connect", description: "Link this chat to a Paperclip company" },
  { command: "connect_topic", description: "Map a project to a forum topic" },
  { command: "topics", description: "List or remove forum topic mappings" },
  { command: "acp", description: "Manage agent sessions (spawn, status, cancel, close)" },
  { command: "commands", description: "Manage custom workflow commands (list, import, run, delete)" },
];

export async function handleCommand(
  ctx: PluginContext,
  token: string,
  chatId: string,
  command: string,
  args: string,
  messageThreadId?: number,
  baseUrl?: string,
  publicUrl?: string,
  companyId?: string,
  boardApiToken?: string,
  maxAgentsPerThread?: number,
): Promise<void> {
  await ctx.metrics.write(METRIC_NAMES.commandsHandled, 1);

  switch (command) {
    case "create":
      await handleCreate(ctx, token, chatId, args, messageThreadId, publicUrl || baseUrl, companyId);
      break;
    case "status":
      await handleStatus(ctx, token, chatId, messageThreadId, publicUrl, companyId);
      break;
    case "issues":
      await handleIssues(ctx, token, chatId, args, messageThreadId, publicUrl || baseUrl, companyId);
      break;
    case "agents":
      await handleAgents(ctx, token, chatId, messageThreadId, publicUrl, companyId);
      break;
    case "approve":
      await handleApprove(ctx, token, chatId, args, messageThreadId, baseUrl, boardApiToken);
      break;
    case "help":
      await handleHelp(ctx, token, chatId, messageThreadId);
      break;
    case "connect":
      await handleConnect(ctx, token, chatId, args, messageThreadId);
      break;
    case "connect_topic":
      await handleConnectTopic(ctx, token, chatId, args, messageThreadId);
      break;
    case "topics":
      await handleTopicsCommand(ctx, token, chatId, args, messageThreadId);
      break;
    case "acp":
      await handleAcpCommand(ctx, token, chatId, args, messageThreadId, companyId, maxAgentsPerThread);
      break;
    default:
      await sendMessage(ctx, token, chatId, `Unknown command: /${command}. Try /help`, {
        messageThreadId,
      });
  }
}

function isExternalUrl(url?: string): boolean {
  return !!url && url.startsWith("https://");
}

async function handleStatus(
  ctx: PluginContext,
  token: string,
  chatId: string,
  messageThreadId?: number,
  publicUrl?: string,
  resolvedCompanyId?: string,
): Promise<void> {
  await sendChatAction(ctx, token, chatId);

  try {
    const companyId = resolvedCompanyId ?? await resolveCompanyId(ctx, chatId);
    const agents = await ctx.agents.list({ companyId });
    const activeAgents = agents.filter((a: Agent) => a.status === "active");
    const issues = await ctx.issues.list({ companyId, limit: 10 });
    const doneIssues = issues.filter((i: Issue) => i.status === "done");

    const lines = [
      escapeMarkdownV2("📊") + " *Paperclip Status*",
      "",
      `${escapeMarkdownV2("🤖")} Active agents: *${activeAgents.length}*/${escapeMarkdownV2(String(agents.length))}`,
      `${escapeMarkdownV2("📋")} Recent issues: *${escapeMarkdownV2(String(issues.length))}* \\(${escapeMarkdownV2(String(doneIssues.length))} done\\)`,
    ];

    const inlineKeyboard = isExternalUrl(publicUrl)
      ? [[{ text: "Open Dashboard ↗", url: publicUrl! }]]
      : undefined;

    await sendMessage(ctx, token, chatId, lines.join("\n"), {
      parseMode: "MarkdownV2",
      messageThreadId,
      inlineKeyboard,
    });
  } catch {
    await sendMessage(ctx, token, chatId, escapeMarkdownV2("📊") + " *Paperclip Status*\n\n" + escapeMarkdownV2("Could not fetch status. Make sure this chat is linked to a company with /connect."), {
      parseMode: "MarkdownV2",
      messageThreadId,
    });
  }
}

async function handleIssues(
  ctx: PluginContext,
  token: string,
  chatId: string,
  projectFilter: string,
  messageThreadId?: number,
  baseUrl?: string,
  resolvedCompanyId?: string,
): Promise<void> {
  await sendChatAction(ctx, token, chatId);

  try {
    const companyId = resolvedCompanyId ?? await resolveCompanyId(ctx, chatId);
    const company = await ctx.companies.get(companyId);
    const issues = await ctx.issues.list({ companyId, limit: 10 });
    const filtered = projectFilter
      ? issues.filter((i: Issue) => {
          const projName = i.project?.name ?? "";
          return projName.toLowerCase().includes(projectFilter.toLowerCase());
        })
      : issues;

    if (filtered.length === 0) {
      const filter = projectFilter ? ` for project "${projectFilter}"` : "";
      await sendMessage(ctx, token, chatId, `No issues found${filter}.`, { messageThreadId });
      return;
    }

    const issuePrefix = company?.issuePrefix;
    const statusEmoji: Record<string, string> = { done: "✅", todo: "📋", in_progress: "🔄", backlog: "📥" };
    const lines = [escapeMarkdownV2("📋") + " *Open Issues*", ""];
    for (const issue of filtered) {
      const emoji = statusEmoji[issue.status] ?? "📋";
      const id = issue.identifier ?? issue.id;
      const idText = issuePrefix && baseUrl
        ? `[${escapeMarkdownV2(id)}](${baseUrl}/${issuePrefix}/issues/${id})`
        : escapeMarkdownV2(id);
      lines.push(`${escapeMarkdownV2(emoji)} ${idText} \\- ${escapeMarkdownV2(issue.title)}`);
    }

    await sendMessage(ctx, token, chatId, lines.join("\n"), {
      parseMode: "MarkdownV2",
      messageThreadId,
    });
  } catch {
    const filter = projectFilter ? ` for project "${projectFilter}"` : "";
    await sendMessage(
      ctx,
      token,
      chatId,
      `Could not fetch issues${filter}. Make sure this chat is linked with /connect.`,
      { messageThreadId },
    );
  }
}

async function handleAgents(
  ctx: PluginContext,
  token: string,
  chatId: string,
  messageThreadId?: number,
  publicUrl?: string,
  resolvedCompanyId?: string,
): Promise<void> {
  await sendChatAction(ctx, token, chatId);

  try {
    const companyId = resolvedCompanyId ?? await resolveCompanyId(ctx, chatId);
    const agents = await ctx.agents.list({ companyId });

    if (agents.length === 0) {
      await sendMessage(ctx, token, chatId, "No agents found.", { messageThreadId });
      return;
    }

    const hasLinks = isExternalUrl(publicUrl);
    const statusEmoji: Record<string, string> = { active: "🟢", error: "🔴", paused: "🟡", idle: "⚪", running: "🔵" };
    const lines = [escapeMarkdownV2("🤖") + " *Agents*", ""];
    for (const agent of agents) {
      const emoji = statusEmoji[agent.status] ?? "⚪";
      if (hasLinks) {
        const url = `${publicUrl}/agents/${agent.id}`;
        lines.push(`${escapeMarkdownV2(emoji)} [${escapeMarkdownV2(agent.name)}](${url}) \\- ${escapeMarkdownV2(agent.status)}`);
      } else {
        lines.push(`${escapeMarkdownV2(emoji)} *${escapeMarkdownV2(agent.name)}* \\- ${escapeMarkdownV2(agent.status)}`);
      }
    }

    await sendMessage(ctx, token, chatId, lines.join("\n"), {
      parseMode: "MarkdownV2",
      messageThreadId,
    });
  } catch {
    await sendMessage(
      ctx,
      token,
      chatId,
      "Could not fetch agents. Make sure this chat is linked with /connect.",
      { messageThreadId },
    );
  }
}

async function handleApprove(
  ctx: PluginContext,
  token: string,
  chatId: string,
  approvalId: string,
  messageThreadId?: number,
  baseUrl: string = "http://localhost:3100",
  boardApiToken?: string,
): Promise<void> {
  if (!approvalId.trim()) {
    await sendMessage(ctx, token, chatId, "Usage: /approve <approval-id>", {
      messageThreadId,
    });
    return;
  }

  try {
    await fetchPaperclipApi(
      ctx,
      `${baseUrl}/api/approvals/${approvalId.trim()}/approve`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...buildPaperclipAuthHeaders(boardApiToken),
        },
        body: JSON.stringify({ decidedByUserId: `telegram:${chatId}` }),
      },
    );

    await sendMessage(
      ctx,
      token,
      chatId,
      `${escapeMarkdownV2("✅")} *Approved*: \`${escapeMarkdownV2(approvalId.trim())}\``,
      { parseMode: "MarkdownV2", messageThreadId },
    );
  } catch (err) {
    await sendMessage(
      ctx,
      token,
      chatId,
      `Failed to approve ${approvalId}: ${err instanceof Error ? err.message : String(err)}`,
      { messageThreadId },
    );
  }
}

async function handleHelp(
  ctx: PluginContext,
  token: string,
  chatId: string,
  messageThreadId?: number,
): Promise<void> {
  const lines = [
    escapeMarkdownV2("📎") + " *Paperclip Bot Commands*",
    "",
    ...BOT_COMMANDS.map(
      (cmd) => `/${escapeMarkdownV2(cmd.command)} \\- ${escapeMarkdownV2(cmd.description)}`,
    ),
  ];

  await sendMessage(ctx, token, chatId, lines.join("\n"), {
    parseMode: "MarkdownV2",
    messageThreadId,
  });
}

async function handleConnect(
  ctx: PluginContext,
  token: string,
  chatId: string,
  companyArg: string,
  messageThreadId?: number,
): Promise<void> {
  if (!companyArg.trim()) {
    try {
      const companies = await ctx.companies.list();
      const names = companies.map((c) => c.name || c.id).join(", ");
      await sendMessage(ctx, token, chatId, `Usage: /connect <company-name>\nAvailable: ${names || "none"}`, { messageThreadId });
    } catch {
      await sendMessage(ctx, token, chatId, "Usage: /connect <company-name>", { messageThreadId });
    }
    return;
  }

  try {
    const input = companyArg.trim();
    const companies = await ctx.companies.list();
    const match = companies.find(
      (c) =>
        c.id === input ||
        c.name?.toLowerCase() === input.toLowerCase(),
    );

    if (!match) {
      const names = companies.map((c) => c.name || c.id).join(", ");
      await sendMessage(
        ctx,
        token,
        chatId,
        `Company "${input}" not found. Available: ${names || "none"}`,
        { messageThreadId },
      );
      return;
    }

    // Inbound: chat → company (for commands like /status)
    await ctx.state.set(
      { scopeKind: "instance", stateKey: `chat_${chatId}` },
      { companyId: match.id, companyName: match.name ?? input, linkedAt: new Date().toISOString() },
    );

    // Outbound: company → chat (for notifications)
    await ctx.state.set(
      { scopeKind: "company", scopeId: match.id, stateKey: "telegram-chat" },
      chatId,
    );

    await sendMessage(
      ctx,
      token,
      chatId,
      `${escapeMarkdownV2("🔗")} ${escapeMarkdownV2("Linked this chat to company:")} *${escapeMarkdownV2(match.name ?? input)}*`,
      { parseMode: "MarkdownV2", messageThreadId },
    );

    ctx.logger.info("Chat linked to company", { chatId, companyId: match.id, companyName: match.name });
  } catch (err) {
    await sendMessage(
      ctx,
      token,
      chatId,
      `Failed to connect: ${err instanceof Error ? err.message : String(err)}`,
      { messageThreadId },
    );
  }
}

async function handleCreate(
  ctx: PluginContext,
  token: string,
  chatId: string,
  titleArg: string,
  messageThreadId?: number,
  linkBaseUrl?: string,
  resolvedCompanyId?: string,
): Promise<void> {
  const title = titleArg.trim();
  if (!title) {
    await sendMessage(ctx, token, chatId, "Usage: /create <task title>", { messageThreadId });
    return;
  }

  await sendChatAction(ctx, token, chatId);

  try {
    const companyId = resolvedCompanyId ?? await resolveCompanyId(ctx, chatId);
    const company = await ctx.companies.get(companyId);
    const issuePrefix = company?.issuePrefix;
    const projectId = await resolveProjectIdForTopic(ctx, chatId, companyId, messageThreadId);

    // Find the CEO agent to assign to
    const agents = await ctx.agents.list({ companyId });
    const ceo = agents.find((a: Agent) => a.role === "ceo" && a.status !== "paused" && a.status !== "error");

    // Create the issue WITHOUT assignee first, then update with both status and assignee.
    // This ordering is load-bearing: the issue_assigned wake only fires when the assignee
    // *transitions* from null to an agent. If we set the assignee at creation time, there's
    // no transition and the agent never gets woken.
    let issue = await ctx.issues.create({ companyId, title, ...(projectId ? { projectId } : {}) });
    if (ceo) {
      issue = await ctx.issues.update(
        issue.id,
        { status: "todo", assigneeAgentId: ceo.id },
        companyId,
      );
    } else {
      // No CEO to assign to — still bump status to todo so it's visible in the backlog
      issue = await ctx.issues.update(issue.id, { status: "todo" }, companyId);
    }

    const id = issue.identifier ?? issue.id;
    const hasLink = linkBaseUrl && isExternalUrl(linkBaseUrl) && issuePrefix;
    const idText = hasLink
      ? `[${escapeMarkdownV2(id)}](${linkBaseUrl}/${issuePrefix}/issues/${id})`
      : `\`${escapeMarkdownV2(id)}\``;
    const assigneeText = ceo ? ` ${escapeMarkdownV2("→")} *${escapeMarkdownV2(ceo.name)}*` : "";

    await sendMessage(
      ctx,
      token,
      chatId,
      `${escapeMarkdownV2("✅")} *Task created*: ${idText}${assigneeText}\n${escapeMarkdownV2(title)}`,
      { parseMode: "MarkdownV2", messageThreadId },
    );
  } catch (err) {
    await sendMessage(
      ctx,
      token,
      chatId,
      `Failed to create task: ${err instanceof Error ? err.message : String(err)}`,
      { messageThreadId },
    );
  }
}

export async function handleConnectTopic(
  ctx: PluginContext,
  token: string,
  chatId: string,
  args: string,
  messageThreadId?: number,
): Promise<void> {
  const trimmedArgs = args.trim();
  if (!trimmedArgs) {
    await sendMessage(ctx, token, chatId, "Usage: /connect\\_topic <project\\-name> \\[topic\\-id\\]", {
      parseMode: "MarkdownV2",
      messageThreadId,
    });
    return;
  }

  const parts = trimmedArgs.split(/\s+/);
  if (parts.length < 2 && !messageThreadId) {
    await sendMessage(ctx, token, chatId, "Usage: /connect\\_topic <project\\-name> \\[topic\\-id\\]", {
      parseMode: "MarkdownV2",
      messageThreadId,
    });
    return;
  }

  let topicId: string;
  let projectNameInput: string;
  const explicitTopicId = parts.length >= 2 && /^\d+$/.test(parts[parts.length - 1]);
  if (explicitTopicId) {
    topicId = parts.pop()!;
    projectNameInput = parts.join(" ");
  } else {
    if (!messageThreadId) {
      await sendMessage(ctx, token, chatId, "Usage: /connect\\_topic <project\\-name> \\[topic\\-id\\]", {
        parseMode: "MarkdownV2",
        messageThreadId,
      });
      return;
    }
    topicId = String(messageThreadId);
    projectNameInput = parts.join(" ");
  }

  let companyId: string;
  try {
    companyId = await resolveCompanyId(ctx, chatId);
  } catch {
    await sendMessage(ctx, token, chatId, "This chat is not linked to a Paperclip company. Use /connect first.", { messageThreadId });
    return;
  }
  const project = await resolveProjectByName(ctx, companyId, projectNameInput);
  if (!project) {
    await sendProjectNotFoundMessage(ctx, token, chatId, companyId, projectNameInput, messageThreadId);
    return;
  }

  const topicMap = await getTopicMap(ctx, chatId);
  const existingKey = findTopicMapKey(topicMap, project.name) ?? findTopicMapKey(topicMap, projectNameInput);
  if (existingKey && existingKey !== project.name) {
    delete topicMap[existingKey];
  }
  topicMap[project.name] = { projectId: project.id, projectName: project.name, topicId };

  await setTopicMap(ctx, chatId, topicMap);

  await sendMessage(
    ctx,
    token,
    chatId,
    `${escapeMarkdownV2("🔗")} ${escapeMarkdownV2(`Mapped project "${project.name}" to topic ${topicId}`)}`,
    { parseMode: "MarkdownV2", messageThreadId },
  );

  ctx.logger.info("Topic mapped", { chatId, projectId: project.id, projectName: project.name, topicId });
}

async function handleTopicsCommand(
  ctx: PluginContext,
  token: string,
  chatId: string,
  args: string,
  messageThreadId?: number,
): Promise<void> {
  const [subcommand = "list", ...rest] = args.trim().split(/\s+/).filter(Boolean);

  switch (subcommand.toLowerCase()) {
    case "list":
      await handleTopicsList(ctx, token, chatId, messageThreadId);
      break;
    case "remove":
      await handleTopicsRemove(ctx, token, chatId, rest.join(" "), messageThreadId);
      break;
    case "clear":
      await handleTopicsClear(ctx, token, chatId, messageThreadId);
      break;
    default:
      await sendTopicsUsage(ctx, token, chatId, messageThreadId);
  }
}

async function handleTopicsList(
  ctx: PluginContext,
  token: string,
  chatId: string,
  messageThreadId?: number,
): Promise<void> {
  const topicMap = await getTopicMap(ctx, chatId);
  const entries = Object.entries(topicMap);

  if (entries.length === 0) {
    await sendMessage(ctx, token, chatId, "No topic mappings found for this chat.", { messageThreadId });
    return;
  }

  const lines = [
    escapeMarkdownV2("🧭") + " *Topic mappings*",
    "",
    ...entries.map(([key, value]) => {
      const mapping = normalizeTopicMapping(key, value);
      return `• ${escapeMarkdownV2(mapping.projectName)} ${escapeMarkdownV2("→")} ${escapeMarkdownV2(mapping.topicId)}`;
    }),
  ];

  await sendMessage(ctx, token, chatId, lines.join("\n"), {
    parseMode: "MarkdownV2",
    messageThreadId,
  });
}

async function handleTopicsRemove(
  ctx: PluginContext,
  token: string,
  chatId: string,
  projectName: string,
  messageThreadId?: number,
): Promise<void> {
  const input = projectName.trim();
  if (!input) {
    await sendMessage(ctx, token, chatId, "Usage: /topics remove <project\\-name>", {
      parseMode: "MarkdownV2",
      messageThreadId,
    });
    return;
  }

  const topicMap = await getTopicMap(ctx, chatId);
  const key = findTopicMapKey(topicMap, input);
  if (!key) {
    await sendMessage(ctx, token, chatId, `No topic mapping found for "${input}".`, { messageThreadId });
    return;
  }

  const mapping = normalizeTopicMapping(key, topicMap[key]);
  delete topicMap[key];
  await setTopicMap(ctx, chatId, topicMap);

  await sendMessage(
    ctx,
    token,
    chatId,
    `${escapeMarkdownV2("🗑️")} ${escapeMarkdownV2(`Removed topic mapping for "${mapping.projectName}".`)}`,
    { parseMode: "MarkdownV2", messageThreadId },
  );
}

async function handleTopicsClear(
  ctx: PluginContext,
  token: string,
  chatId: string,
  messageThreadId?: number,
): Promise<void> {
  await setTopicMap(ctx, chatId, {});
  await sendMessage(ctx, token, chatId, "Cleared all topic mappings for this chat.", { messageThreadId });
}

async function sendTopicsUsage(
  ctx: PluginContext,
  token: string,
  chatId: string,
  messageThreadId?: number,
): Promise<void> {
  await sendMessage(
    ctx,
    token,
    chatId,
    [
      escapeMarkdownV2("🧭") + " *Topic Commands*",
      "",
      `/topics list \\- ${escapeMarkdownV2("Show mappings for this chat")}`,
      `/topics remove <project\\-name> \\- ${escapeMarkdownV2("Remove one mapping")}`,
      `/topics clear \\- ${escapeMarkdownV2("Remove all mappings for this chat")}`,
    ].join("\n"),
    { parseMode: "MarkdownV2", messageThreadId },
  );
}

async function resolveProjectByName(
  ctx: PluginContext,
  companyId: string,
  projectName: string,
): Promise<Project | undefined> {
  const input = projectName.trim();
  if (!input) return undefined;

  const projects = await ctx.projects.list({ companyId, limit: 100 });
  return projects.find((project) => project.id === input)
    ?? projects.find((project) => project.name === input)
    ?? projects.find((project) => project.name?.toLowerCase() === input.toLowerCase());
}

async function sendProjectNotFoundMessage(
  ctx: PluginContext,
  token: string,
  chatId: string,
  companyId: string,
  projectName: string,
  messageThreadId?: number,
): Promise<void> {
  try {
    const projects = await ctx.projects.list({ companyId, limit: 100 });
    const names = projects.map((project) => project.name || project.id).filter(Boolean).join(", ");
    await sendMessage(
      ctx,
      token,
      chatId,
      `Project "${projectName.trim()}" not found. Available: ${names || "none"}`,
      { messageThreadId },
    );
  } catch {
    await sendMessage(ctx, token, chatId, `Project "${projectName.trim()}" not found.`, { messageThreadId });
  }
}

async function getTopicMap(ctx: PluginContext, chatId: string): Promise<TopicMap> {
  const existing = await ctx.state.get({
    scopeKind: "instance",
    stateKey: `topic-map-${chatId}`,
  });
  if (!existing || typeof existing !== "object" || Array.isArray(existing)) return {};
  return existing as TopicMap;
}

async function setTopicMap(ctx: PluginContext, chatId: string, topicMap: TopicMap): Promise<void> {
  await ctx.state.set(
    { scopeKind: "instance", stateKey: `topic-map-${chatId}` },
    topicMap,
  );
}

function findTopicMapKey(topicMap: TopicMap, projectName: string): string | undefined {
  const input = projectName.trim().toLowerCase();
  if (!input) return undefined;

  return Object.entries(topicMap).find(([key, value]) => {
    const mapping = normalizeTopicMapping(key, value);
    return key.toLowerCase() === input
      || mapping.projectName.toLowerCase() === input
      || mapping.projectId?.toLowerCase() === input;
  })?.[0];
}

function normalizeTopicMapping(projectName: string, value: TopicMappingValue): TopicMappingRecord {
  if (typeof value === "string") {
    return { projectName, topicId: value };
  }
  return {
    projectId: value.projectId,
    projectName: value.projectName || projectName,
    topicId: String(value.topicId),
  };
}

export async function getTopicForProject(
  ctx: PluginContext,
  chatId: string,
  projectName?: string,
): Promise<number | undefined> {
  if (!projectName) return undefined;
  const topicMap = await getTopicMap(ctx, chatId);
  const key = findTopicMapKey(topicMap, projectName);
  if (!key) return undefined;
  const mapping = normalizeTopicMapping(key, topicMap[key]);
  return Number(mapping.topicId);
}

async function getProjectNameForTopic(
  ctx: PluginContext,
  chatId: string,
  messageThreadId?: number,
): Promise<string | undefined> {
  if (!messageThreadId) return undefined;
  const topicMap = (await ctx.state.get({
    scopeKind: "instance",
    stateKey: `topic-map-${chatId}`,
  })) as Record<string, string> | null;
  if (!topicMap) return undefined;

  const topicId = String(messageThreadId);
  const match = Object.entries(topicMap).find(([, mappedTopicId]) => mappedTopicId === topicId);
  return match?.[0];
}

async function resolveProjectIdForTopic(
  ctx: PluginContext,
  chatId: string,
  companyId: string,
  messageThreadId?: number,
): Promise<string | undefined> {
  const projectName = await getProjectNameForTopic(ctx, chatId, messageThreadId);
  if (!projectName) return undefined;

  try {
    const projects = await ctx.projects.list({ companyId, limit: 100 });
    const exactMatch = projects.find((project) => project.name === projectName);
    if (exactMatch) return exactMatch.id;
    return projects.find((project) => project.name?.toLowerCase() === projectName.toLowerCase())?.id;
  } catch {
    return undefined;
  }
}

export async function resolveNotificationThreadId(
  ctx: PluginContext,
  chatId: string,
  event: PluginEvent,
  topicRouting: boolean,
): Promise<number | undefined> {
  if (!topicRouting) return undefined;
  const projectName = await resolveEventProjectName(ctx, event);
  return getTopicForProject(ctx, chatId, projectName);
}

async function resolveEventProjectName(
  ctx: PluginContext,
  event: PluginEvent,
): Promise<string | undefined> {
  const payload = event.payload as Record<string, unknown>;
  const payloadProjectName = payload.projectName ? String(payload.projectName) : undefined;
  if (payloadProjectName) return payloadProjectName;

  const payloadProjectId = payload.projectId ? String(payload.projectId) : undefined;
  if (payloadProjectId) {
    try {
      const project = await ctx.projects.get(payloadProjectId, event.companyId);
      if (project?.name) return project.name;
    } catch {
      return undefined;
    }
  }

  if (event.entityType !== "issue" || !event.entityId) return undefined;
  try {
    const issue = await ctx.issues.get(event.entityId, event.companyId);
    if (!issue?.projectId) return undefined;
    const project = await ctx.projects.get(issue.projectId, event.companyId);
    return project?.name;
  } catch {
    return undefined;
  }
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
