import type { PluginContext } from "@paperclipai/plugin-sdk";
import { sendMessage, escapeMarkdownV2, sendChatAction, answerCallbackQuery, editMessage } from "./telegram-api.js";
import { METRIC_NAMES } from "./constants.js";

// --- Types ---

type WorkflowStepBase = {
  id: string;
  name?: string;
};

type FetchIssueStep = WorkflowStepBase & {
  type: "fetch_issue";
  issueId: string; // supports {{arg1}} template
};

type InvokeAgentStep = WorkflowStepBase & {
  type: "invoke_agent";
  agentId: string;
  prompt: string; // supports {{prev.result}}, {{arg1}} etc.
};

type HttpRequestStep = WorkflowStepBase & {
  type: "http_request";
  url: string;
  method: "GET" | "POST" | "PUT" | "DELETE";
  headers?: Record<string, string>;
  body?: string;
};

type SendMessageStep = WorkflowStepBase & {
  type: "send_message";
  text: string;
};

type CreateIssueStep = WorkflowStepBase & {
  type: "create_issue";
  title: string;
  description?: string;
  projectId?: string;
  assigneeAgentId?: string;
};

type WaitApprovalStep = WorkflowStepBase & {
  type: "wait_approval";
  prompt: string;
  timeoutMs?: number;
};

type SetStateStep = WorkflowStepBase & {
  type: "set_state";
  key: string;
  value: string;
};

type WorkflowStep =
  | FetchIssueStep
  | InvokeAgentStep
  | HttpRequestStep
  | SendMessageStep
  | CreateIssueStep
  | WaitApprovalStep
  | SetStateStep;

type CustomCommand = {
  name: string;
  description: string;
  steps: WorkflowStep[];
  createdBy: string;
  createdAt: string;
};

type StepResult = {
  stepId: string;
  result: string;
  data?: unknown;
};

/**
 * Returned by a `wait_approval` step to tell executeWorkflow to stop and park.
 * Carries the approval id so the continuation is stored under the same key the
 * buttons will send back.
 */
const AWAITING_APPROVAL_PREFIX = "__awaiting_approval__:";

/** Callback data prefixes for the two buttons a wait_approval step sends. */
const APPROVE_PREFIX = "cmd_approve_";
const REJECT_PREFIX = "cmd_reject_";

/**
 * Everything needed to restart a workflow at the step after its approval gate.
 *
 * Telegram processes updates strictly sequentially, so a step cannot await a
 * button press — the press arrives as a later update that cannot be handled
 * while the loop is blocked. The workflow therefore stops here and the
 * continuation is resolved from the callback handler, the same stateless shape
 * /decisions uses. Nothing secret is stored: the bot token is re-resolved when
 * the callback arrives.
 */
type ParkedWorkflow = {
  commandName: string;
  args: string[];
  results: StepResult[];
  nextStepIndex: number;
  chatId: string;
  messageThreadId?: number;
  companyId: string;
  createdAt: number;
};

function approvalStateKey(approvalId: string): string {
  return `cmd_approval_${approvalId}`;
}

// --- Built-in commands ---

const BUILTIN_COMMANDS = new Set([
  "status", "issues", "agents", "approve", "help",
  "connect", "connect_topic", "topics", "acp", "commands",
]);

// --- Command registry ---

export async function handleCommandsCommand(
  ctx: PluginContext,
  token: string,
  chatId: string,
  args: string,
  messageThreadId?: number,
  companyId?: string,
): Promise<void> {
  const parts = args.trim().split(/\s+/);
  const subcommand = parts[0]?.toLowerCase() ?? "";

  if (!companyId && ["list", "import", "delete", "run"].includes(subcommand)) {
    await sendMessage(ctx, token, chatId, "This chat is not linked to a Paperclip company. Use /connect first.", { messageThreadId });
    return;
  }

  switch (subcommand) {
    case "list":
      await listCommands(ctx, token, chatId, messageThreadId, companyId);
      break;
    case "import":
      await importCommand(ctx, token, chatId, parts.slice(1).join(" "), messageThreadId, companyId);
      break;
    case "delete":
      await deleteCommand(ctx, token, chatId, parts[1] ?? "", messageThreadId, companyId);
      break;
    case "run":
      await runCommand(ctx, token, chatId, parts[1] ?? "", parts.slice(2), messageThreadId, companyId);
      break;
    default:
      await sendMessage(ctx, token, chatId, [
        escapeMarkdownV2("\ud83d\udee0\ufe0f") + " *Custom Commands*",
        "",
        `/commands list \\- ${escapeMarkdownV2("Show all custom commands")}`,
        `/commands import <json> \\- ${escapeMarkdownV2("Import a workflow command")}`,
        `/commands delete <name> \\- ${escapeMarkdownV2("Remove a custom command")}`,
        `/commands run <name> [args] \\- ${escapeMarkdownV2("Execute a custom command")}`,
      ].join("\n"), { parseMode: "MarkdownV2", messageThreadId });
  }
}

// Check if a command is custom and run it, returns true if handled
export async function tryCustomCommand(
  ctx: PluginContext,
  token: string,
  chatId: string,
  command: string,
  argsStr: string,
  messageThreadId?: number,
  companyId?: string,
): Promise<boolean> {
  if (BUILTIN_COMMANDS.has(command)) return false;

  // Unlinked chat: never fall back to chatId as a companyId. Returning false
  // lets the built-in command path answer with its "not linked" guidance.
  if (!companyId) return false;

  const commands = await getCommandRegistry(ctx, companyId);
  const cmd = commands.find((c) => c.name === command);

  if (!cmd) return false;

  const args = argsStr.trim().split(/\s+/).filter(Boolean);
  await executeWorkflow(ctx, token, chatId, cmd, args, messageThreadId, companyId);
  return true;
}

async function listCommands(
  ctx: PluginContext,
  token: string,
  chatId: string,
  messageThreadId?: number,
  companyId?: string,
): Promise<void> {
  const resolvedCompanyId = companyId ?? chatId;
  const commands = await getCommandRegistry(ctx, resolvedCompanyId);

  if (commands.length === 0) {
    await sendMessage(ctx, token, chatId, "No custom commands registered. Use /commands import to add one.", { messageThreadId });
    return;
  }

  const lines = [
    escapeMarkdownV2("\ud83d\udee0\ufe0f") + " *Custom Commands*",
    "",
  ];

  for (const cmd of commands) {
    lines.push(`/${escapeMarkdownV2(cmd.name)} \\- ${escapeMarkdownV2(cmd.description)}`);
    lines.push(`  Steps: ${escapeMarkdownV2(String(cmd.steps.length))} \\| Created: ${escapeMarkdownV2(cmd.createdAt.split("T")[0] ?? cmd.createdAt)}`);
  }

  await sendMessage(ctx, token, chatId, lines.join("\n"), {
    parseMode: "MarkdownV2",
    messageThreadId,
  });
}

async function importCommand(
  ctx: PluginContext,
  token: string,
  chatId: string,
  jsonStr: string,
  messageThreadId?: number,
  companyId?: string,
): Promise<void> {
  if (!jsonStr.trim()) {
    await sendMessage(ctx, token, chatId, "Usage: /commands import <json-definition>", { messageThreadId });
    return;
  }

  let definition: { name: string; description: string; steps: WorkflowStep[] };
  try {
    definition = JSON.parse(jsonStr);
  } catch {
    await sendMessage(ctx, token, chatId, "Invalid JSON. Please provide a valid command definition.", { messageThreadId });
    return;
  }

  if (!definition.name || !definition.steps || !Array.isArray(definition.steps)) {
    await sendMessage(ctx, token, chatId, "Command definition must have 'name' and 'steps' fields.", { messageThreadId });
    return;
  }

  if (BUILTIN_COMMANDS.has(definition.name)) {
    await sendMessage(ctx, token, chatId, `Cannot override built-in command: /${definition.name}`, { messageThreadId });
    return;
  }

  // Validate steps
  for (const step of definition.steps) {
    if (!step.type || !step.id) {
      await sendMessage(ctx, token, chatId, "Each step must have 'type' and 'id' fields.", { messageThreadId });
      return;
    }
    const validTypes = ["fetch_issue", "invoke_agent", "http_request", "send_message", "create_issue", "wait_approval", "set_state"];
    if (!validTypes.includes(step.type)) {
      await sendMessage(ctx, token, chatId, `Invalid step type: ${step.type}. Valid: ${validTypes.join(", ")}`, { messageThreadId });
      return;
    }
  }

  const resolvedCompanyId = companyId ?? chatId;
  const commands = await getCommandRegistry(ctx, resolvedCompanyId);

  // Replace existing or add new
  const existingIdx = commands.findIndex((c) => c.name === definition.name);
  const newCmd: CustomCommand = {
    name: definition.name,
    description: definition.description ?? "No description",
    steps: definition.steps,
    createdBy: `telegram:${chatId}`,
    createdAt: new Date().toISOString(),
  };

  if (existingIdx >= 0) {
    commands[existingIdx] = newCmd;
  } else {
    commands.push(newCmd);
  }

  await saveCommandRegistry(ctx, resolvedCompanyId, commands);

  await sendMessage(
    ctx,
    token,
    chatId,
    `${escapeMarkdownV2("\u2705")} Command /${escapeMarkdownV2(definition.name)} ${existingIdx >= 0 ? "updated" : "imported"} \\(${escapeMarkdownV2(String(definition.steps.length))} steps\\)`,
    { parseMode: "MarkdownV2", messageThreadId },
  );
}

async function deleteCommand(
  ctx: PluginContext,
  token: string,
  chatId: string,
  name: string,
  messageThreadId?: number,
  companyId?: string,
): Promise<void> {
  if (!name.trim()) {
    await sendMessage(ctx, token, chatId, "Usage: /commands delete <name>", { messageThreadId });
    return;
  }

  const resolvedCompanyId = companyId ?? chatId;
  const commands = await getCommandRegistry(ctx, resolvedCompanyId);
  const filtered = commands.filter((c) => c.name !== name);

  if (filtered.length === commands.length) {
    await sendMessage(ctx, token, chatId, `Command /${name} not found.`, { messageThreadId });
    return;
  }

  await saveCommandRegistry(ctx, resolvedCompanyId, filtered);

  await sendMessage(
    ctx,
    token,
    chatId,
    `${escapeMarkdownV2("\ud83d\uddd1\ufe0f")} Command /${escapeMarkdownV2(name)} deleted.`,
    { parseMode: "MarkdownV2", messageThreadId },
  );
}

async function runCommand(
  ctx: PluginContext,
  token: string,
  chatId: string,
  name: string,
  args: string[],
  messageThreadId?: number,
  companyId?: string,
): Promise<void> {
  const resolvedCompanyId = companyId ?? chatId;
  const commands = await getCommandRegistry(ctx, resolvedCompanyId);
  const cmd = commands.find((c) => c.name === name);

  if (!cmd) {
    await sendMessage(ctx, token, chatId, `Command /${name} not found.`, { messageThreadId });
    return;
  }

  await executeWorkflow(ctx, token, chatId, cmd, args, messageThreadId, resolvedCompanyId);
}

// --- Workflow executor ---

async function executeWorkflow(
  ctx: PluginContext,
  token: string,
  chatId: string,
  cmd: CustomCommand,
  args: string[],
  messageThreadId: number | undefined,
  companyId: string,
  startIndex = 0,
  priorResults: StepResult[] = [],
): Promise<void> {
  await sendChatAction(ctx, token, chatId);
  if (startIndex === 0) {
    await ctx.metrics.write(METRIC_NAMES.commandsExecuted, 1);
  }

  const results: StepResult[] = [...priorResults];

  for (let index = startIndex; index < cmd.steps.length; index++) {
    const step = cmd.steps[index]!;
    try {
      const result = await executeStep(ctx, token, chatId, step, args, results, messageThreadId, companyId);

      // An approval gate stops the run here. Continuing would execute the very
      // steps the gate exists to hold back — which is what this used to do,
      // making the Approve button decorative.
      if (typeof result === "string" && result.startsWith(AWAITING_APPROVAL_PREFIX)) {
        const approvalId = result.slice(AWAITING_APPROVAL_PREFIX.length);
        const parked: ParkedWorkflow = {
          commandName: cmd.name,
          args,
          results,
          nextStepIndex: index + 1,
          chatId,
          messageThreadId,
          companyId,
          createdAt: Date.now(),
        };
        await ctx.state.set(
          { scopeKind: "instance", stateKey: approvalStateKey(approvalId) },
          parked,
        );
        ctx.logger.info("Workflow parked awaiting approval", {
          command: cmd.name,
          stepId: step.id,
          approvalId,
        });
        return;
      }

      results.push({ stepId: step.id, result: result ?? "" });
    } catch (err) {
      ctx.logger.error("Workflow step failed", { command: cmd.name, stepId: step.id, error: String(err) });
      await sendMessage(
        ctx,
        token,
        chatId,
        `Step "${step.name ?? step.id}" failed: ${String(err)}`,
        { messageThreadId },
      );
      return; // Stop execution on failure
    }
  }

  ctx.logger.info("Workflow completed", { command: cmd.name, steps: results.length });
}

async function executeStep(
  ctx: PluginContext,
  token: string,
  chatId: string,
  step: WorkflowStep,
  args: string[],
  prevResults: StepResult[],
  messageThreadId: number | undefined,
  companyId: string,
): Promise<string | null> {
  const interpolate = (template: string): string => {
    let result = template;
    // Replace {{arg0}}, {{arg1}}, etc.
    for (let i = 0; i < args.length; i++) {
      result = result.replace(new RegExp(`\\{\\{arg${i}\\}\\}`, "g"), args[i]!);
    }
    result = result.replace(/\{\{args\}\}/g, args.join(" "));
    // Replace {{prev.result}}, {{step_id.result}}
    if (prevResults.length > 0) {
      const lastResult = prevResults[prevResults.length - 1]!;
      result = result.replace(/\{\{prev\.result\}\}/g, lastResult.result);
    }
    for (const prev of prevResults) {
      result = result.replace(new RegExp(`\\{\\{${prev.stepId}\\.result\\}\\}`, "g"), prev.result);
    }
    return result;
  };

  switch (step.type) {
    case "fetch_issue": {
      const issueId = interpolate(step.issueId);
      const issue = await ctx.issues.get(issueId, companyId);
      if (!issue) return JSON.stringify({ error: "Issue not found", issueId });
      return JSON.stringify({ id: issue.id, title: issue.title, status: issue.status });
    }

    case "invoke_agent": {
      const prompt = interpolate(step.prompt);
      const { runId } = await ctx.agents.invoke(step.agentId, companyId, {
        prompt,
        reason: `custom_command:${step.id}`,
      });
      return runId;
    }

    case "http_request": {
      const url = interpolate(step.url);
      const body = step.body ? interpolate(step.body) : undefined;
      const res = await ctx.http.fetch(url, {
        method: step.method,
        headers: step.headers ? Object.fromEntries(
          Object.entries(step.headers).map(([k, v]) => [k, interpolate(v)]),
        ) : undefined,
        body,
      });
      const data = await res.text();
      return data;
    }

    case "send_message": {
      const text = interpolate(step.text);
      await sendMessage(ctx, token, chatId, text, { messageThreadId });
      return "sent";
    }

    case "create_issue": {
      const title = interpolate(step.title);
      const description = step.description ? interpolate(step.description) : undefined;
      const issue = await ctx.issues.create({
        companyId,
        title,
        description,
        projectId: step.projectId,
        assigneeAgentId: step.assigneeAgentId,
      });
      if (step.assigneeAgentId) {
        await ctx.issues.update(issue.id, { status: "todo" }, companyId);
      }
      return issue.id;
    }

    case "wait_approval": {
      const prompt = interpolate(step.prompt);
      // Unique per step within a run: Date.now() alone collides when two steps
      // park in the same millisecond, and a collision would resume the wrong
      // continuation.
      const approvalId = `${Date.now()}_${step.id}`;
      await sendMessage(ctx, token, chatId, prompt, {
        messageThreadId,
        inlineKeyboard: [
          [
            { text: "Approve", callback_data: `${APPROVE_PREFIX}${approvalId}` },
            { text: "Reject", callback_data: `${REJECT_PREFIX}${approvalId}` },
          ],
        ],
      });
      // executeWorkflow stores the continuation under this id and stops. The
      // state is written there rather than here because only the loop knows
      // which step comes next.
      return `${AWAITING_APPROVAL_PREFIX}${approvalId}`;
    }

    // NOTE: there is deliberately no "choice" step that blocks inline.
    //
    // A step that asks the user to pick and *awaits* the answer cannot work
    // here: updates are processed strictly sequentially, so a workflow that
    // blocks on a button press blocks the loop that would deliver it. The
    // press can never arrive and the run stalls until it times out.
    //
    // `wait_approval` is how such a step has to be built instead: send the
    // buttons, persist the continuation, return, and let the callback handler
    // resume the run. A `choice` step can be added the same way — park the
    // context keyed by an id and resolve it in resolveWorkflowApprovalCallback.
    case "set_state": {
      const key = interpolate(step.key);
      const value = interpolate(step.value);
      await ctx.state.set(
        { scopeKind: "company", scopeId: companyId, stateKey: key },
        value,
      );
      return value;
    }

    default:
      return null;
  }
}

// --- Approval callbacks ---

/** True for the two callbacks a wait_approval step's buttons send back. */
export function isWorkflowApprovalCallback(data: string): boolean {
  return data.startsWith(APPROVE_PREFIX) || data.startsWith(REJECT_PREFIX);
}

/**
 * Resume or abandon a workflow parked at an approval gate.
 *
 * The parked state is deleted before the remaining steps run. That ordering is
 * the point: it makes a second press of the same button a no-op instead of
 * running the tail of the workflow twice. Telegram leaves the buttons on screen
 * and re-delivers callbacks it considers unacknowledged, so a double press is
 * the expected case, not the unlucky one.
 */
export async function resolveWorkflowApprovalCallback(
  ctx: PluginContext,
  token: string,
  data: string,
  callbackQueryId: string,
  actor: string,
  messageId?: number,
): Promise<void> {
  const approved = data.startsWith(APPROVE_PREFIX);
  const approvalId = data.slice((approved ? APPROVE_PREFIX : REJECT_PREFIX).length);
  const stateKey = approvalStateKey(approvalId);

  const parked = await ctx.state.get({
    scopeKind: "instance",
    stateKey,
  }) as ParkedWorkflow | null;

  if (!parked) {
    // Already decided, or from a build before the continuation was persisted.
    // Saying so beats silence, which would read as the button doing nothing.
    await answerCallbackQuery(ctx, token, callbackQueryId, "This approval is no longer pending.");
    return;
  }

  await ctx.state.set({ scopeKind: "instance", stateKey }, null);

  if (!approved) {
    await answerCallbackQuery(ctx, token, callbackQueryId, "Rejected");
    if (messageId) {
      await editMessage(ctx, token, parked.chatId, messageId, `Rejected by ${actor}. The workflow stopped here.`);
    }
    ctx.logger.info("Workflow rejected at approval gate", {
      command: parked.commandName,
      approvalId,
      actor,
    });
    return;
  }

  await answerCallbackQuery(ctx, token, callbackQueryId, "Approved");
  if (messageId) {
    await editMessage(ctx, token, parked.chatId, messageId, `Approved by ${actor}. Continuing.`);
  }

  const commands = await getCommandRegistry(ctx, parked.companyId);
  const cmd = commands.find((c) => c.name === parked.commandName);
  if (!cmd) {
    // The command was edited or deleted while the approval sat pending.
    await sendMessage(
      ctx,
      token,
      parked.chatId,
      `Approved, but /${parked.commandName} no longer exists — nothing to continue.`,
      { messageThreadId: parked.messageThreadId },
    );
    return;
  }

  await executeWorkflow(
    ctx,
    token,
    parked.chatId,
    cmd,
    parked.args,
    parked.messageThreadId,
    parked.companyId,
    parked.nextStepIndex,
    parked.results,
  );
}

// --- State helpers ---

async function getCommandRegistry(ctx: PluginContext, companyId: string): Promise<CustomCommand[]> {
  const commands = await ctx.state.get({
    scopeKind: "company",
    scopeId: companyId,
    stateKey: `commands_${companyId}`,
  }) as CustomCommand[] | null;
  return commands ?? [];
}

async function saveCommandRegistry(ctx: PluginContext, companyId: string, commands: CustomCommand[]): Promise<void> {
  await ctx.state.set(
    { scopeKind: "company", scopeId: companyId, stateKey: `commands_${companyId}` },
    commands,
  );
}
