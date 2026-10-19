import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { IssueThreadInteraction } from "@paperclipai/shared";

// Coverage for the scheduler-poll fallback (manifest job
// `check-issue-interactions`) and the config hot-reload hardening in
// onConfigChanged. Both exist because a decision card can appear without a
// *following* issue.updated for the event-driven path to catch, and because a
// config SAVE can land without a readable company scope.

let sentMessages: Array<{ chatId: string; text: string }> = [];

vi.mock("@paperclipai/plugin-sdk", async () => {
  const actual = (await vi.importActual("@paperclipai/plugin-sdk")) as Record<string, unknown>;
  return { ...actual, runWorker: vi.fn() };
});

vi.mock("../src/telegram-api.js", async () => {
  const actual = (await vi.importActual("../src/telegram-api.js")) as Record<string, unknown>;
  return {
    ...actual,
    sendMessage: vi.fn(async (_ctx: unknown, _token: string, chatId: string, text: string) => {
      sentMessages.push({ chatId, text });
      return sentMessages.length;
    }),
    setMyCommands: vi.fn().mockResolvedValue(true),
  };
});

type Registered = {
  events: Record<string, Array<(event: unknown) => unknown>>;
  jobs: Record<string, () => unknown>;
};

function pendingCard(id: string): IssueThreadInteraction {
  return {
    id,
    kind: "request_confirmation",
    status: "pending",
    payload: { version: 1, prompt: "Ship it?" },
  } as IssueThreadInteraction;
}

function makeCtx(opts: {
  companies?: Array<{ id: string; issuePrefix?: string }>;
  configByCompany?: Record<string, Record<string, unknown>>;
  interactionsByIssue?: Record<string, IssueThreadInteraction[]>;
  inProgressIssueIds?: string[];
  issuesByStatus?: Record<string, string[]>;
}): { ctx: PluginContext; registered: Registered } {
  const registered: Registered = { events: {}, jobs: {} };
  const companies = opts.companies ?? [];
  const configByCompany = opts.configByCompany ?? {};
  const interactionsByIssue = opts.interactionsByIssue ?? {};
  const store = new Map<string, unknown>();
  const key = (scope: { scopeKind?: string; scopeId?: string; stateKey?: string }) =>
    `${scope.scopeKind ?? ""}:${scope.scopeId ?? ""}:${scope.stateKey ?? ""}`;

  const ctx = {
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    events: {
      on: vi.fn((name: string, fn: (event: unknown) => unknown) => {
        (registered.events[name] ??= []).push(fn);
      }),
    },
    jobs: {
      register: vi.fn((jobKey: string, fn: () => unknown) => {
        registered.jobs[jobKey] = fn;
      }),
    },
    tools: { register: vi.fn() },
    actions: { register: vi.fn() },
    data: { register: vi.fn() },
    state: {
      get: vi.fn(async (scope: Record<string, unknown>) => store.get(key(scope)) ?? null),
      set: vi.fn(async (scope: Record<string, unknown>, value: unknown) => {
        store.set(key(scope), value);
      }),
    },
    companies: {
      list: vi.fn().mockResolvedValue(companies),
      get: vi.fn(async (id: string) => companies.find((c) => c.id === id) ?? null),
    },
    config: {
      get: vi.fn(async (companyId?: string) => {
        const found = companyId ? configByCompany[companyId] : undefined;
        if (!found) throw new Error("company context is required");
        return found;
      }),
    },
    secrets: { resolve: vi.fn().mockResolvedValue("bot-token") },
    http: { fetch: vi.fn().mockRejectedValue(new Error("network unavailable in tests")) },
    metrics: { write: vi.fn().mockResolvedValue(undefined) },
    activity: { log: vi.fn().mockResolvedValue(undefined) },
    agents: { get: vi.fn().mockResolvedValue(null), list: vi.fn().mockResolvedValue([]) },
    issues: {
      get: vi.fn(async (issueId: string) => ({ id: issueId, identifier: "ART-1", title: "Test" })),
      list: vi.fn(async (input: { status?: string }) => {
        if (opts.issuesByStatus) {
          return (opts.issuesByStatus[input.status ?? ""] ?? []).map((id) => ({ id }));
        }
        // Default: the whole set appears only under in_progress.
        return input.status === "in_progress"
          ? (opts.inProgressIssueIds ?? []).map((id) => ({ id }))
          : [];
      }),
      listInteractions: vi.fn(async (issueId: string) => interactionsByIssue[issueId] ?? []),
      listComments: vi.fn().mockResolvedValue([]),
    },
  } as unknown as PluginContext;

  return { ctx, registered };
}

async function emit(registered: Registered, name: string, event: unknown): Promise<void> {
  for (const handler of registered.events[name] ?? []) await handler(event);
}

function issueEvent(type: string, companyId: string, entityId: string) {
  return { eventType: type, companyId, entityType: "issue", entityId, payload: {} };
}

beforeEach(() => {
  sentMessages = [];
  vi.useFakeTimers();
  vi.resetModules();
});

afterEach(() => {
  vi.useRealTimers();
});

const INTERACTION_CONFIG = {
  telegramBotTokenRef: "11111111-1111-4111-8111-111111111111",
  defaultChatId: "chat-1",
  // Isolate the decision-card path from the unrelated issue.created notifier.
  notifyOnIssueCreated: false,
  notifyOnIssueDone: false,
  notifyOnIssueInteraction: true,
};

describe("check-issue-interactions fallback job", () => {
  it("forwards a card that appeared after the event, with no further issue.updated", async () => {
    const { plugin } = await import("../src/worker.js");
    const interactionsByIssue: Record<string, IssueThreadInteraction[]> = { "issue-1": [] };
    const { ctx, registered } = makeCtx({
      companies: [{ id: "company-a" }],
      configByCompany: { "company-a": INTERACTION_CONFIG },
      interactionsByIssue,
    });
    await plugin.definition.setup(ctx);
    await plugin.definition.onConfigChanged!(INTERACTION_CONFIG);

    // The event fires before the card exists: nothing forwarded yet, but the
    // issue is now a poll candidate.
    await emit(registered, "issue.created", issueEvent("issue.created", "company-a", "issue-1"));
    expect(sentMessages).toEqual([]);

    // The card lands on the thread without any later issue.updated.
    interactionsByIssue["issue-1"] = [pendingCard("int-1")];

    await registered.jobs["check-issue-interactions"]!();

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]!.chatId).toBe("chat-1");
  });

  it("does not re-send a card the event path already forwarded (interaction-seen dedupe)", async () => {
    const { plugin } = await import("../src/worker.js");
    const { ctx, registered } = makeCtx({
      companies: [{ id: "company-a" }],
      configByCompany: { "company-a": INTERACTION_CONFIG },
      interactionsByIssue: { "issue-1": [pendingCard("int-1")] },
    });
    await plugin.definition.setup(ctx);
    await plugin.definition.onConfigChanged!(INTERACTION_CONFIG);

    // Event path forwards it once...
    await emit(registered, "issue.updated", issueEvent("issue.updated", "company-a", "issue-1"));
    expect(sentMessages).toHaveLength(1);

    // ...and the poll tick a minute later must not forward it again.
    await registered.jobs["check-issue-interactions"]!();
    expect(sentMessages).toHaveLength(1);
  });

  it("catches a card on an in-progress issue the plugin saw no event for", async () => {
    const { plugin } = await import("../src/worker.js");
    const { ctx, registered } = makeCtx({
      companies: [{ id: "company-a" }],
      configByCompany: { "company-a": INTERACTION_CONFIG },
      interactionsByIssue: { "issue-x": [pendingCard("int-x")] },
      inProgressIssueIds: ["issue-x"],
    });
    await plugin.definition.setup(ctx);
    await plugin.definition.onConfigChanged!(INTERACTION_CONFIG);

    // No issue event was ever emitted for issue-x; only the in-progress listing
    // surfaces it.
    await registered.jobs["check-issue-interactions"]!();

    expect(sentMessages).toHaveLength(1);
  });

  it("collapses duplicate concurrent issue.updated events into a single send", async () => {
    const { plugin } = await import("../src/worker.js");
    const { ctx, registered } = makeCtx({
      companies: [{ id: "company-a" }],
      configByCompany: { "company-a": INTERACTION_CONFIG },
      interactionsByIssue: { "issue-1": [pendingCard("int-1")] },
    });
    await plugin.definition.setup(ctx);
    await plugin.definition.onConfigChanged!(INTERACTION_CONFIG);

    // Paperclip core emits duplicate issue.updated events for one change; fire
    // the same event three times concurrently.
    const handlers = registered.events["issue.updated"] ?? [];
    const ev = issueEvent("issue.updated", "company-a", "issue-1");
    await Promise.all([
      ...handlers.map((h) => h(ev)),
      ...handlers.map((h) => h(ev)),
      ...handlers.map((h) => h(ev)),
    ]);

    expect(sentMessages).toHaveLength(1);
  });

  it("forwards a pending card on an in_review issue via the poll (status breadth)", async () => {
    const { plugin } = await import("../src/worker.js");
    const { ctx, registered } = makeCtx({
      companies: [{ id: "company-a" }],
      configByCompany: { "company-a": INTERACTION_CONFIG },
      interactionsByIssue: { "issue-ir": [pendingCard("int-ir")] },
      // The issue surfaces only under in_review — never in_progress, so the
      // old in-progress-only net would have missed it.
      issuesByStatus: { in_review: ["issue-ir"] },
    });
    await plugin.definition.setup(ctx);
    await plugin.definition.onConfigChanged!(INTERACTION_CONFIG);

    await registered.jobs["check-issue-interactions"]!();

    expect(sentMessages).toHaveLength(1);
  });

  it("forwards a notify-only kind (ask_user_questions) without a resolve mapping", async () => {
    const { plugin } = await import("../src/worker.js");
    const questions = {
      id: "q-1",
      kind: "ask_user_questions",
      status: "pending",
      title: "Pick a path",
      payload: {
        version: 1,
        questions: [
          { id: "q1", prompt: "npm or manual?", selectionMode: "single", options: [{ id: "o1", label: "npm" }] },
        ],
      },
    } as unknown as IssueThreadInteraction;
    const { ctx, registered } = makeCtx({
      companies: [{ id: "company-a" }],
      configByCompany: { "company-a": INTERACTION_CONFIG },
      interactionsByIssue: { "issue-q": [questions] },
      issuesByStatus: { in_progress: ["issue-q"] },
    });
    await plugin.definition.setup(ctx);
    await plugin.definition.onConfigChanged!(INTERACTION_CONFIG);

    await registered.jobs["check-issue-interactions"]!();

    expect(sentMessages).toHaveLength(1);
    // Notify-only cards carry no accept/reject buttons, so no `msg_` callback
    // mapping is ever stored (only the interaction-seen dedupe key).
    const setKeys = (ctx.state.set as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => (c[0] as { stateKey?: string }).stateKey ?? "",
    );
    expect(setKeys.some((k) => k.startsWith("msg_"))).toBe(false);
    expect(setKeys.some((k) => k.startsWith("interaction-seen:"))).toBe(true);
  });

  it("no-ops when the decision-card flag is off", async () => {
    const { plugin } = await import("../src/worker.js");
    const configOff = { ...INTERACTION_CONFIG, notifyOnIssueInteraction: false };
    const { ctx, registered } = makeCtx({
      companies: [{ id: "company-a" }],
      configByCompany: { "company-a": configOff },
      interactionsByIssue: { "issue-x": [pendingCard("int-x")] },
      inProgressIssueIds: ["issue-x"],
    });
    await plugin.definition.setup(ctx);
    await plugin.definition.onConfigChanged!(configOff);

    await registered.jobs["check-issue-interactions"]!();

    expect(sentMessages).toEqual([]);
    expect(ctx.issues.list).not.toHaveBeenCalled();
  });
});

describe("onConfigChanged hot-reload hardening", () => {
  it("applies a save with no readable scope to the owner when the bot token matches", async () => {
    const { plugin } = await import("../src/worker.js");
    const flagOff = { ...INTERACTION_CONFIG, notifyOnIssueInteraction: false };
    const { ctx, registered } = makeCtx({
      companies: [{ id: "company-a" }],
      configByCompany: { "company-a": flagOff },
      interactionsByIssue: { "issue-1": [pendingCard("int-1")] },
      inProgressIssueIds: ["issue-1"],
    });
    await plugin.definition.setup(ctx);

    // First delivery establishes company-a as owner (flag off).
    await plugin.definition.onConfigChanged!(flagOff);
    await registered.jobs["check-issue-interactions"]!();
    expect(sentMessages).toEqual([]);

    // The UI save arrives with the flag on, but no company answers a scoped
    // read (attribution returns null).
    (ctx.config.get as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("company context is required"));
    const flagOn = { ...INTERACTION_CONFIG, notifyOnIssueInteraction: true };
    await plugin.definition.onConfigChanged!(flagOn);

    // The owner-fallback applied it, so the flag is now live on the running
    // worker without a restart.
    await registered.jobs["check-issue-interactions"]!();
    expect(sentMessages).toHaveLength(1);
    expect(ctx.logger.info).toHaveBeenCalledWith(
      expect.stringContaining("applying a configuration delivery to the current owner"),
      expect.objectContaining({ ownerCompanyId: "company-a" }),
    );
  });

  it("does not apply a scope-less save whose bot token differs from the owner's", async () => {
    const { plugin } = await import("../src/worker.js");
    const { ctx } = makeCtx({
      companies: [{ id: "company-a" }],
      configByCompany: { "company-a": INTERACTION_CONFIG },
    });
    await plugin.definition.setup(ctx);
    await plugin.definition.onConfigChanged!(INTERACTION_CONFIG);

    (ctx.config.get as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("company context is required"));
    const foreign = {
      telegramBotTokenRef: "99999999-9999-4999-8999-999999999999",
      defaultChatId: "chat-foreign",
      notifyOnIssueInteraction: true,
    };
    await plugin.definition.onConfigChanged!(foreign);

    expect(ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("could not attribute"),
    );
    expect(ctx.logger.info).not.toHaveBeenCalledWith(
      expect.stringContaining("applying a configuration delivery to the current owner"),
      expect.anything(),
    );
  });
});
