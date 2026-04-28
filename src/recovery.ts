import type { PluginContext, PluginEvent, Issue, Agent } from "@paperclipai/plugin-sdk";

type HeartbeatRunSnapshot = {
  issueId?: string;
  taskId?: string;
  paperclipWake?: {
    issue?: {
      id?: string;
      identifier?: string;
      title?: string;
    };
  };
};

type HeartbeatRun = {
  agentId?: string;
  errorCode?: string;
  error?: string;
  scheduledRetryAt?: string | null;
  scheduledRetryReason?: string | null;
  contextSnapshot?: HeartbeatRunSnapshot;
};

function isRecoveryIssueTitle(title: string): boolean {
  return /^recover (failed|stalled)/i.test(title) || /recovery/i.test(title);
}

/**
 * Create or update an Igor-owned recovery issue for a non-transient failed agent run.
 *
 * The Telegram notification alone is ephemeral; this makes agent-error recovery durable
 * in Paperclip so Igor is woken through the normal assignment route.
 */
export async function createIgorRecoveryIssueForRunFailure(
  ctx: PluginContext,
  event: PluginEvent,
  baseUrl: string,
): Promise<Issue | null> {
  const p = (event.payload ?? {}) as Record<string, unknown>;
  const runId = p.runId
    ? String(p.runId)
    : event.entityType === "heartbeat_run" && event.entityId
      ? String(event.entityId)
      : null;

  let run: HeartbeatRun | null = null;
  if (runId) {
    try {
      const response = await ctx.http.fetch(`${baseUrl}/api/heartbeat-runs/${runId}`);
      if (response.ok) run = (await response.json()) as HeartbeatRun;
    } catch {
      // best effort: payload may already contain enough context
    }
  }

  const snapshot = run?.contextSnapshot ?? {};
  const issueId =
    p.issueId ??
    snapshot.issueId ??
    snapshot.taskId ??
    snapshot.paperclipWake?.issue?.id ??
    null;
  const issueIdentifier = p.issueIdentifier ?? snapshot.paperclipWake?.issue?.identifier ?? null;
  const issueTitle = p.issueTitle ?? snapshot.paperclipWake?.issue?.title ?? null;
  const agentId = p.agentId ?? run?.agentId ?? null;
  const errorCode = String(p.errorCode ?? run?.errorCode ?? "");
  const errorText = String(p.error ?? run?.error ?? p.message ?? "Agent run failed");

  // Let Paperclip's scheduled retry path own transient upstream failures.
  if (run?.scheduledRetryAt || run?.scheduledRetryReason || errorCode === "claude_transient_upstream") {
    ctx.logger.info("Skipping Igor recovery issue for transient/scheduled retry", { runId, errorCode });
    return null;
  }

  const agents = await ctx.agents.list({ companyId: event.companyId });
  const igor = agents.find((agent: Agent) => agent.name === "Igor" || agent.role === "ceo");
  if (!igor?.id) {
    ctx.logger.warn("Cannot create recovery issue: Igor/CEO agent not found", { companyId: event.companyId });
    return null;
  }
  if (agentId && String(agentId) === String(igor.id)) {
    ctx.logger.info("Skipping Igor recovery issue for Igor's own failed run", { runId });
    return null;
  }

  let linkedIssue: Issue | null = null;
  if (issueId) {
    try {
      linkedIssue = await ctx.issues.get(String(issueId), event.companyId);
    } catch {
      // best effort: payload/snapshot still gives enough to create a useful issue
    }
  }

  const linkedTitle = linkedIssue?.title ?? (issueTitle ? String(issueTitle) : "unknown issue");
  const linkedIdentifier = linkedIssue?.identifier ?? (issueIdentifier ? String(issueIdentifier) : issueId ? String(issueId).slice(0, 8) : "unknown");
  if (isRecoveryIssueTitle(linkedTitle)) {
    ctx.logger.info("Skipping recovery issue for recovery issue to avoid loops", { runId, issueId, linkedTitle });
    return null;
  }

  const openIgorIssues = await ctx.issues.list({
    companyId: event.companyId,
    assigneeAgentId: igor.id,
    status: "todo",
    limit: 50,
  });
  const existing = openIgorIssues.find(
    (issue) =>
      (issue.title ?? "").includes(`Recover failed run on ${linkedIdentifier}`) ||
      (runId ? (issue.description ?? "").includes(runId) : false),
  );
  if (existing) {
    await ctx.issues.createComment(
      existing.id,
      `Another failed run matched this recovery route.\n\n- Run: ${runId ?? "unknown"}\n- Error: ${errorCode || errorText}\n- Linked issue: ${linkedIdentifier}\n\nLeaving this recovery issue as the active one.`,
      event.companyId,
    );
    ctx.logger.info("Updated existing Igor recovery issue", { recoveryIssueId: existing.id, runId });
    return existing;
  }

  const failedAgent = agents.find((agent) => agentId && String(agent.id) === String(agentId));
  const failedAgentName = failedAgent?.name ?? (agentId ? String(agentId).slice(0, 8) : "agent");
  const title = `Recover failed run on ${linkedIdentifier}`;
  const description = [
    "Paperclip auto-created this recovery issue from an `agent.run.failed` event.",
    "",
    `Failed agent: ${failedAgentName}`,
    `Failed run: ${runId ?? "unknown"}`,
    `Linked issue: ${issueId ? `${linkedIdentifier} — ${linkedTitle}` : "none"}`,
    `Error: ${errorCode || errorText}`,
    "",
    "First actions:",
    "- Inspect the failed run log.",
    "- If an execution is stuck, cancel it cleanly.",
    "- Re-wake or reroute the linked issue with narrower instructions.",
    "- If this is transient and already retried successfully, close this recovery issue.",
    "",
    "Loop guard: do not create recovery issues for recovery issues.",
  ].join("\n");

  // Create unassigned first, then assign+todo so Paperclip emits the normal assignment wake.
  let recovery = await ctx.issues.create({
    companyId: event.companyId,
    projectId: linkedIssue?.projectId,
    title,
    description,
    priority: "high",
    // Newer Paperclip hosts accept these attribution fields even though older SDK
    // typings have not caught up yet.
    originKind: "plugin",
    originId: "paperclip-plugin-telegram:agent-run-failed-recovery",
    originRunId: runId ?? undefined,
    requestDepth: Math.min(Number(linkedIssue?.requestDepth ?? 0) + 1, 10),
  } as Parameters<PluginContext["issues"]["create"]>[0] & Record<string, unknown>);

  recovery = await ctx.issues.update(recovery.id, { status: "todo", assigneeAgentId: igor.id }, event.companyId);
  ctx.logger.info("Created Igor recovery issue for failed agent run", {
    recoveryIssueId: recovery.id,
    runId,
    linkedIssueId: issueId,
  });
  return recovery;
}
