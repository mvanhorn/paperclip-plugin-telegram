import type { PluginContext, Agent, Issue } from "@paperclipai/plugin-sdk";
import { sendMessage, escapeMarkdownV2, sendChatAction } from "./telegram-api.js";
import { METRIC_NAMES } from "./constants.js";
import { handleAcpCommand } from "./acp-bridge.js";

type BotCommand = {
  command: string;
  description: string;
};

export const BOT_COMMANDS: BotCommand[] = [
  { command: "status", description: "Company health: active agents, open issues" },
  { command: "issues", description: "List open issues (optionally by project)" },
  { command: "agents", description: "List agents with current status" },
  { command: "approve", description: "Approve a pending request by ID" },
  { command: "help", description: "Show available commands" },
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
): Promise<void> {
  await ctx.metrics.write(METRIC_NAMES.commandsHandled, 1);

  switch (command) {
    case "status":
      await handleStatus(ctx, token, chatId, messageThreadId);
      break;
    case "issues":
      await handleIssues(ctx, token, chatId, args, messageThreadId, baseUrl);
      break;
    case "agents":
      await handleAgents(ctx, token, chatId, messageThreadId);
      break;
    case "approve":
      await handleApprove(ctx, token, chatId, args, messageThreadId, baseUrl);
      break;
    case "help":
      await handleHelp(ctx, token, chatId, messageThreadId);
      break;
    case "connect":
      await handleConnect(ctx, token, chatId, args, messageThreadId);
      break;
    case "connect-topic":
      await handleConnectTopic(ctx, token, chatId, args, messageThreadId);
      break;
    case "acp":
      await handleAcpCommand(ctx, token, chatId, args, messageThreadId);
      break;
    default:
      await sendMessage(ctx, token, chatId, `Unknown command: /${command}. Try /help`, {
        messageThreadId,
      });
  }
}

async function handleStatus(
  ctx: PluginContext,
  token: string,
  chatId: string,
  messageThreadId?: number,
): Promise<void> {
  await sendChatAction(ctx, token, chatId);

  try {
    const companyId = await resolveCompanyId(ctx, chatId);
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

    await sendMessage(ctx, token, chatId, lines.join("\n"), {
      parseMode: "MarkdownV2",
      messageThreadId,
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
): Promise<void> {
  await sendChatAction(ctx, token, chatId);

  try {
    const companyId = await resolveCompanyId(ctx, chatId);
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
): Promise<void> {
  await sendChatAction(ctx, token, chatId);

  try {
    const companyId = await resolveCompanyId(ctx, chatId);
    const agents = await ctx.agents.list({ companyId });

    if (agents.length === 0) {
      await sendMessage(ctx, token, chatId, "No agents found.", { messageThreadId });
      return;
    }

    const statusEmoji: Record<string, string> = { active: "🟢", error: "🔴", paused: "🟡", idle: "⚪", running: "🔵" };
    const lines = [escapeMarkdownV2("🤖") + " *Agents*", ""];
    for (const agent of agents) {
      const emoji = statusEmoji[agent.status] ?? "⚪";
      lines.push(`${escapeMarkdownV2(emoji)} *${escapeMarkdownV2(agent.name)}* \\- ${escapeMarkdownV2(agent.status)}`);
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
): Promise<void> {
  if (!approvalId.trim()) {
    await sendMessage(ctx, token, chatId, "Usage: /approve <approval-id>", {
      messageThreadId,
    });
    return;
  }

  try {
    await ctx.http.fetch(
      `${baseUrl}/api/approvals/${approvalId.trim()}/approve`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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
    "",
    `/${escapeMarkdownV2("connect")} \\- ${escapeMarkdownV2("Link this chat to a Paperclip company")}`,
    `/${escapeMarkdownV2("connect-topic")} \\- ${escapeMarkdownV2("Map a project to a forum topic")}`,
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
    await sendMessage(ctx, token, chatId, "Usage: /connect <company-name-or-id>", {
      messageThreadId,
    });
    return;
  }

  const input = companyArg.trim();
  const companies = await ctx.companies.list();
  // Match by ID, name (case-insensitive), or shortname prefix
  const match = companies.find(
    (c) =>
      c.id === input ||
      c.name?.toLowerCase() === input.toLowerCase(),
  );

  if (!match) {
    const available = companies.map((c) => c.name || c.id).join(", ");
    await sendMessage(
      ctx,
      token,
      chatId,
      `Company not found: "${input}". Available: ${available}`,
      { messageThreadId },
    );
    return;
  }

  await ctx.state.set(
    { scopeKind: "instance", stateKey: `chat_${chatId}` },
    { companyId: match.id, companyName: match.name ?? input, linkedAt: new Date().toISOString() },
  );

  await sendMessage(
    ctx,
    token,
    chatId,
    `${escapeMarkdownV2("🔗")} ${escapeMarkdownV2("Linked this chat to company:")} *${escapeMarkdownV2(match.name ?? input)}*`,
    { parseMode: "MarkdownV2", messageThreadId },
  );

  ctx.logger.info("Chat linked to company", { chatId, companyId: match.id, companyName: match.name });
}

export async function handleConnectTopic(
  ctx: PluginContext,
  token: string,
  chatId: string,
  args: string,
  messageThreadId?: number,
): Promise<void> {
  const parts = args.trim().split(/\s+/);
  if (parts.length < 2) {
    await sendMessage(ctx, token, chatId, "Usage: /connect\\-topic <project\\-name> <topic\\-id>", {
      parseMode: "MarkdownV2",
      messageThreadId,
    });
    return;
  }

  const topicId = parts.pop()!;
  const projectName = parts.join(" ");

  const existing = (await ctx.state.get({
    scopeKind: "instance",
    stateKey: `topic-map-${chatId}`,
  })) as Record<string, string> | null;

  const topicMap = existing ?? {};
  topicMap[projectName] = topicId;

  await ctx.state.set(
    { scopeKind: "instance", stateKey: `topic-map-${chatId}` },
    topicMap,
  );

  await sendMessage(
    ctx,
    token,
    chatId,
    `${escapeMarkdownV2("🔗")} ${escapeMarkdownV2(`Mapped project "${projectName}" to topic ${topicId}`)}`,
    { parseMode: "MarkdownV2", messageThreadId },
  );

  ctx.logger.info("Topic mapped", { chatId, projectName, topicId });
}

export async function getTopicForProject(
  ctx: PluginContext,
  chatId: string,
  projectName?: string,
): Promise<number | undefined> {
  if (!projectName) return undefined;
  const topicMap = (await ctx.state.get({
    scopeKind: "instance",
    stateKey: `topic-map-${chatId}`,
  })) as Record<string, string> | null;
  if (!topicMap) return undefined;
  const topicId = topicMap[projectName];
  return topicId ? Number(topicId) : undefined;
}

async function resolveCompanyId(ctx: PluginContext, chatId: string): Promise<string> {
  const mapping = await ctx.state.get({
    scopeKind: "instance",
    stateKey: `chat_${chatId}`,
  }) as { companyId?: string; companyName?: string } | null;
  return mapping?.companyId ?? mapping?.companyName ?? chatId;
}
