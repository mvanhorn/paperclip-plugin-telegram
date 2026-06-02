import type { PluginContext } from "@paperclipai/plugin-sdk";
import { sendMessage, escapeMarkdownV2 } from "./telegram-api.js";
import { METRIC_NAMES } from "./constants.js";

// --- Types ---

type WatchCondition = {
  field: string;
  operator: "gt" | "lt" | "eq" | "ne" | "contains" | "exists";
  value: string | number | boolean;
};

type Watch = {
  watchId: string;
  name: string;
  description: string;
  entityType: "issue" | "agent" | "company" | "custom";
  conditions: WatchCondition[];
  template: string; // Suggestion message template
  chatId: string;
  threadId?: number;
  companyId: string;
  createdBy: string;
  createdAt: string;
  lastTriggeredAt?: string;
};

type SuggestionLog = {
  watchId: string;
  entityId: string;
  sentAt: string;
};

// Built-in watch templates
const BUILTIN_TEMPLATES: Record<string, Omit<Watch, "watchId" | "chatId" | "threadId" | "companyId" | "createdBy" | "createdAt">> = {
  "invoice-overdue": {
    name: "Invoice Overdue",
    description: "Alert when invoices are past due",
    entityType: "custom",
    conditions: [
      { field: "dueDate", operator: "lt", value: "{{now}}" },
      { field: "status", operator: "ne", value: "paid" },
    ],
    template: "Invoice {{entityId}} is overdue (due: {{dueDate}}). Consider sending a follow-up.",
  },
  "lead-stale": {
    name: "Stale Lead",
    description: "Alert when leads have no activity for 7+ days",
    entityType: "custom",
    conditions: [
      { field: "lastActivityAt", operator: "lt", value: "{{7daysAgo}}" },
      { field: "status", operator: "eq", value: "active" },
    ],
    template: "Lead {{entityId}} has been inactive for 7+ days. Consider re-engagement.",
  },
};

// --- Register watch tool handler ---

export async function handleRegisterWatch(
  ctx: PluginContext,
  params: Record<string, unknown>,
  companyId: string,
): Promise<{ content?: string; error?: string }> {
  const name = String(params.name ?? "");
  const description = String(params.description ?? "");
  const entityType = String(params.entityType ?? "custom") as Watch["entityType"];
  const conditions = (params.conditions as WatchCondition[] | undefined) ?? [];
  const template = String(params.template ?? "");
  const chatId = String(params.chatId ?? "");
  const threadId = params.threadId ? Number(params.threadId) : undefined;
  const useBuiltin = params.builtinTemplate ? String(params.builtinTemplate) : undefined;

  if (!name && !useBuiltin) {
    return { error: "Either 'name' or 'builtinTemplate' is required" };
  }

  if (!chatId) {
    return { error: "'chatId' is required" };
  }

  let watch: Watch;
  const watchId = `watch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  if (useBuiltin && BUILTIN_TEMPLATES[useBuiltin]) {
    const builtin = BUILTIN_TEMPLATES[useBuiltin]!;
    watch = {
      ...builtin,
      watchId,
      chatId,
      threadId,
      companyId,
      createdBy: "agent",
      createdAt: new Date().toISOString(),
    };
  } else {
    if (!template) {
      return { error: "'template' is required for custom watches" };
    }
    watch = {
      watchId,
      name,
      description,
      entityType,
      conditions,
      template,
      chatId,
      threadId,
      companyId,
      createdBy: "agent",
      createdAt: new Date().toISOString(),
    };
  }

  const watches = await getWatchRegistry(ctx, companyId);
  watches.push(watch);
  await saveWatchRegistry(ctx, companyId, watches);

  return { content: JSON.stringify({ status: "registered", watchId, name: watch.name }) };
}

// --- Check watches job ---

export async function checkWatches(
  ctx: PluginContext,
  token: string,
  config: { maxSuggestionsPerHourPerCompany: number; watchDeduplicationWindowMs: number },
  companyId?: string,
): Promise<void> {
  const companyIds = companyId
    ? [companyId]
    : (await ctx.companies.list()).map((company) => company.id);

  for (const currentCompanyId of companyIds) {
    try {
      await checkWatchesForCompany(ctx, token, currentCompanyId, config);
    } catch (err) {
      ctx.logger.error("Watch check failed for company", { companyId: currentCompanyId, error: String(err) });
    }
  }
}

async function checkWatchesForCompany(
  ctx: PluginContext,
  token: string,
  companyId: string,
  config: { maxSuggestionsPerHourPerCompany: number; watchDeduplicationWindowMs: number },
): Promise<void> {
  const watches = await getWatchRegistry(ctx, companyId);
  if (watches.length === 0) return;

  // Rate limiting: check how many suggestions we've sent this hour
  const hourlyCount = await getHourlySuggestionCount(ctx, companyId);
  if (hourlyCount >= config.maxSuggestionsPerHourPerCompany) {
    ctx.logger.info("Watch suggestions rate-limited for company", { companyId, hourlyCount });
    return;
  }

  let sentThisRun = 0;

  for (const watch of watches) {
    if (hourlyCount + sentThisRun >= config.maxSuggestionsPerHourPerCompany) break;

    try {
      const entities = await evaluateWatch(ctx, watch, companyId);

      for (const entity of entities) {
        if (hourlyCount + sentThisRun >= config.maxSuggestionsPerHourPerCompany) break;

        // Dedup check
        const isDuplicate = await checkDedup(ctx, watch.watchId, entity.id, config.watchDeduplicationWindowMs);
        if (isDuplicate) continue;

        // Send suggestion
        const message = interpolateTemplate(watch.template, entity);
        await sendMessage(
          ctx,
          token,
          watch.chatId,
          `${escapeMarkdownV2("\ud83d\udca1")} *Suggestion:* ${escapeMarkdownV2(watch.name)}\n\n${escapeMarkdownV2(message)}`,
          {
            parseMode: "MarkdownV2",
            messageThreadId: watch.threadId,
          },
        );

        // Record dedup
        await recordSuggestion(ctx, watch.watchId, entity.id);
        sentThisRun++;

        // Update watch last triggered
        watch.lastTriggeredAt = new Date().toISOString();
      }
    } catch (err) {
      ctx.logger.error("Watch evaluation failed", { watchId: watch.watchId, error: String(err) });
    }
  }

  // Persist updated watches
  if (sentThisRun > 0) {
    await saveWatchRegistry(ctx, companyId, watches);
    await ctx.metrics.write(METRIC_NAMES.suggestionsEmitted, sentThisRun);
    await incrementHourlySuggestionCount(ctx, companyId, sentThisRun);
  }
}

// --- Watch evaluation ---

async function evaluateWatch(
  ctx: PluginContext,
  watch: Watch,
  companyId: string,
): Promise<Array<{ id: string; [key: string]: unknown }>> {
  const matches: Array<{ id: string; [key: string]: unknown }> = [];

  switch (watch.entityType) {
    case "issue": {
      const issues = await ctx.issues.list({ companyId, limit: 100 });
      for (const issue of issues) {
        const record = issue as unknown as Record<string, unknown>;
        if (matchesConditions(record, watch.conditions)) {
          matches.push({ id: issue.id, ...record });
        }
      }
      break;
    }
    case "agent": {
      const agents = await ctx.agents.list({ companyId });
      for (const agent of agents) {
        const record = agent as unknown as Record<string, unknown>;
        if (matchesConditions(record, watch.conditions)) {
          matches.push({ id: agent.id, ...record });
        }
      }
      break;
    }
    case "custom": {
      // Custom watches check state-stored data
      const customData = await ctx.state.get({
        scopeKind: "company",
        scopeId: companyId,
        stateKey: `watch_data_${watch.watchId}`,
      }) as Array<Record<string, unknown>> | null;

      if (customData) {
        for (const item of customData) {
          if (matchesConditions(item, watch.conditions)) {
            matches.push({ id: String(item.id ?? "unknown"), ...item });
          }
        }
      }
      break;
    }
  }

  return matches;
}

function matchesConditions(record: Record<string, unknown>, conditions: WatchCondition[]): boolean {
  const now = Date.now();
  const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;

  for (const condition of conditions) {
    const fieldValue = record[condition.field];

    let compareValue = condition.value;
    if (compareValue === "{{now}}") compareValue = new Date().toISOString();
    if (compareValue === "{{7daysAgo}}") compareValue = new Date(sevenDaysAgo).toISOString();

    switch (condition.operator) {
      case "eq":
        if (fieldValue !== compareValue) return false;
        break;
      case "ne":
        if (fieldValue === compareValue) return false;
        break;
      case "gt":
        if (!(Number(fieldValue) > Number(compareValue))) return false;
        break;
      case "lt":
        if (!(String(fieldValue) < String(compareValue))) return false;
        break;
      case "contains":
        if (!String(fieldValue ?? "").includes(String(compareValue))) return false;
        break;
      case "exists":
        if ((fieldValue == null) !== !compareValue) return false;
        break;
    }
  }
  return true;
}

function interpolateTemplate(template: string, entity: Record<string, unknown>): string {
  let result = template;
  for (const [key, value] of Object.entries(entity)) {
    result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), String(value ?? ""));
  }
  return result;
}

// --- Dedup & rate limiting ---

async function checkDedup(
  ctx: PluginContext,
  watchId: string,
  entityId: string,
  windowMs: number,
): Promise<boolean> {
  const log = await ctx.state.get({
    scopeKind: "instance",
    stateKey: `suggestion_log_${watchId}_${entityId}`,
  }) as SuggestionLog | null;

  if (!log) return false;

  const sentAt = new Date(log.sentAt).getTime();
  return Date.now() - sentAt < windowMs;
}

async function recordSuggestion(
  ctx: PluginContext,
  watchId: string,
  entityId: string,
): Promise<void> {
  const log: SuggestionLog = {
    watchId,
    entityId,
    sentAt: new Date().toISOString(),
  };
  await ctx.state.set(
    { scopeKind: "instance", stateKey: `suggestion_log_${watchId}_${entityId}` },
    log,
  );
}

async function getHourlySuggestionCount(ctx: PluginContext, companyId: string): Promise<number> {
  const key = `suggestion_hourly_${companyId}_${new Date().toISOString().slice(0, 13)}`;
  const count = await ctx.state.get({
    scopeKind: "instance",
    stateKey: key,
  }) as number | null;
  return count ?? 0;
}

async function incrementHourlySuggestionCount(ctx: PluginContext, companyId: string, amount: number): Promise<void> {
  const key = `suggestion_hourly_${companyId}_${new Date().toISOString().slice(0, 13)}`;
  const current = await getHourlySuggestionCount(ctx, companyId);
  await ctx.state.set(
    { scopeKind: "instance", stateKey: key },
    current + amount,
  );
}

// --- State helpers ---

async function getWatchRegistry(ctx: PluginContext, companyId: string): Promise<Watch[]> {
  const watches = await ctx.state.get({
    scopeKind: "company",
    scopeId: companyId,
    stateKey: `watches_${companyId}`,
  }) as Watch[] | null;
  return watches ?? [];
}

async function saveWatchRegistry(ctx: PluginContext, companyId: string, watches: Watch[]): Promise<void> {
  await ctx.state.set(
    { scopeKind: "company", scopeId: companyId, stateKey: `watches_${companyId}` },
    watches,
  );
}
