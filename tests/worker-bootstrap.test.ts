import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";

// Regression coverage for the deliveries-only bootstrap rearchitecture
// (paperclip-plugin-telegram#77, #63, #61, #64): setup() must never read
// config or secrets — onConfigChanged is the sole source of the runtime, and
// every handler no-ops via ensureRuntime() until a delivery has landed.

let sentMessages: Array<{ chatId: string; text: string }> = [];

vi.mock("@paperclipai/plugin-sdk", async () => {
  const actual = await vi.importActual("@paperclipai/plugin-sdk") as Record<string, unknown>;
  return { ...actual, runWorker: vi.fn() };
});

vi.mock("../src/telegram-api.js", async () => {
  const actual = await vi.importActual("../src/telegram-api.js") as Record<string, unknown>;
  return {
    ...actual,
    sendMessage: vi.fn(async (_ctx: unknown, _token: string, chatId: string, text: string) => {
      sentMessages.push({ chatId, text });
      return 1;
    }),
    setMyCommands: vi.fn().mockResolvedValue(true),
  };
});

type Registered = {
  events: Record<string, Array<(event: unknown) => unknown>>;
};

function makeCtx(opts: {
  companies?: Array<{ id: string; name?: string; issuePrefix?: string }>;
  configByCompany?: Record<string, Record<string, unknown>>;
  resolveSecret?: (ref: string, options?: { companyId?: string }) => Promise<string>;
} = {}): { ctx: PluginContext; registered: Registered } {
  const registered: Registered = { events: {} };
  const companies = opts.companies ?? [];
  const configByCompany = opts.configByCompany ?? {};

  const ctx = {
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    events: {
      on: vi.fn((name: string, fn: (event: unknown) => unknown) => {
        (registered.events[name] ??= []).push(fn);
      }),
    },
    jobs: { register: vi.fn() },
    tools: { register: vi.fn() },
    actions: { register: vi.fn() },
    data: { register: vi.fn() },
    state: {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
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
    secrets: {
      resolve: vi.fn(
        opts.resolveSecret ?? (async () => {
          throw new Error("secret resolution not configured for this test");
        }),
      ),
    },
    // Reject fast: the polling loop's catch-block backoff parks on a fake
    // timer instead of spinning a hot loop against a resolved fetch.
    http: { fetch: vi.fn().mockRejectedValue(new Error("network unavailable in tests")) },
    metrics: { write: vi.fn().mockResolvedValue(undefined) },
    activity: { log: vi.fn().mockResolvedValue(undefined) },
    agents: { get: vi.fn().mockResolvedValue(null), list: vi.fn().mockResolvedValue([]) },
    issues: {
      get: vi.fn().mockResolvedValue(null),
      list: vi.fn().mockResolvedValue([]),
      listComments: vi.fn().mockResolvedValue([]),
    },
  } as unknown as PluginContext;

  return { ctx, registered };
}

async function emit(registered: Registered, name: string, event: unknown): Promise<void> {
  for (const handler of registered.events[name] ?? []) {
    await handler(event);
  }
}

function issueCreatedEvent(companyId: string) {
  return {
    eventType: "issue.created",
    companyId,
    entityType: "issue",
    entityId: "issue-1",
    payload: { title: "Test issue" },
  };
}

beforeEach(() => {
  sentMessages = [];
  vi.useFakeTimers();
  // worker.ts keeps its runtime/ownership state in module-level `let`s, so
  // each test needs its own fresh module instance — otherwise a delivery in
  // one test would leak into the next.
  vi.resetModules();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("worker deliveries-only bootstrap", () => {
  it("setup() registers handlers without reading config or secrets", async () => {
    const { plugin } = await import("../src/worker.js");
    const { ctx } = makeCtx();

    await expect(plugin.definition.setup(ctx)).resolves.toBeUndefined();

    expect(ctx.config.get).not.toHaveBeenCalled();
    expect(ctx.secrets.resolve).not.toHaveBeenCalled();
  });

  it("reports degraded health before any configuration has been delivered", async () => {
    const { plugin } = await import("../src/worker.js");
    const { ctx } = makeCtx();
    await plugin.definition.setup(ctx);

    const health = await plugin.definition.onHealth!();

    expect(health.status).toBe("degraded");
  });

  it("event handlers no-op via ensureRuntime() before a delivery lands", async () => {
    const { plugin } = await import("../src/worker.js");
    const { ctx, registered } = makeCtx();
    await plugin.definition.setup(ctx);

    await emit(registered, "issue.created", issueCreatedEvent("company-a"));

    expect(sentMessages).toEqual([]);
  });

  it("onConfigChanged attributes a single-company delivery and builds the runtime", async () => {
    const { plugin } = await import("../src/worker.js");
    const companyConfig = { telegramBotTokenRef: "ref-a", notifyOnIssueCreated: true, defaultChatId: "chat-a" };
    const { ctx, registered } = makeCtx({
      companies: [{ id: "company-a" }],
      configByCompany: { "company-a": companyConfig },
      resolveSecret: async () => "bot-token-a",
    });
    await plugin.definition.setup(ctx);

    await plugin.definition.onConfigChanged!(companyConfig);

    expect(ctx.secrets.resolve).toHaveBeenCalledWith("ref-a", { companyId: "company-a" });
    const health = await plugin.definition.onHealth!();
    expect(health.status).toBe("ok");

    await emit(registered, "issue.created", issueCreatedEvent("company-a"));
    expect(sentMessages).toHaveLength(1);
  });

  it("attributes a context-less delivery by probing scoped config across companies", async () => {
    const { plugin } = await import("../src/worker.js");
    const configA = { telegramBotTokenRef: "ref-a", defaultChatId: "chat-a" };
    const configB = { telegramBotTokenRef: "ref-b", defaultChatId: "chat-b" };
    const { ctx } = makeCtx({
      companies: [{ id: "company-a" }, { id: "company-b" }],
      configByCompany: { "company-a": configA, "company-b": configB },
      resolveSecret: async () => "bot-token-b",
    });
    await plugin.definition.setup(ctx);

    // Delivered payload matches company-b's stored config by secret ref, even
    // though both companies answer the scoped probe (the >= 2026.817.0 case).
    await plugin.definition.onConfigChanged!(configB);

    expect(ctx.secrets.resolve).toHaveBeenCalledWith("ref-b", { companyId: "company-b" });
  });

  it("cannot attribute a delivery when no company answers a scoped read", async () => {
    const { plugin } = await import("../src/worker.js");
    const { ctx } = makeCtx({ companies: [{ id: "company-a" }], configByCompany: {} });
    await plugin.definition.setup(ctx);

    await plugin.definition.onConfigChanged!({ telegramBotTokenRef: "ref-a" });

    expect(ctx.secrets.resolve).not.toHaveBeenCalled();
    const health = await plugin.definition.onHealth!();
    expect(health.status).toBe("degraded");
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("could not attribute"),
    );
  });

  it("refreshes the runtime in place on a redelivery from the owning company", async () => {
    const { plugin } = await import("../src/worker.js");
    const { ctx, registered } = makeCtx({
      companies: [{ id: "company-a" }],
      configByCompany: {
        "company-a": { telegramBotTokenRef: "ref-a", notifyOnIssueCreated: false, defaultChatId: "chat-a" },
      },
      resolveSecret: async () => "bot-token-a",
    });
    await plugin.definition.setup(ctx);

    await plugin.definition.onConfigChanged!({ telegramBotTokenRef: "ref-a", notifyOnIssueCreated: false, defaultChatId: "chat-a" });
    await emit(registered, "issue.created", issueCreatedEvent("company-a"));
    expect(sentMessages).toEqual([]);

    // Same company saves again with notifications turned on.
    (ctx.config.get as ReturnType<typeof vi.fn>).mockImplementation(async (id?: string) =>
      id === "company-a" ? { telegramBotTokenRef: "ref-a", notifyOnIssueCreated: true, defaultChatId: "chat-a" } : (() => { throw new Error("denied"); })(),
    );
    await plugin.definition.onConfigChanged!({ telegramBotTokenRef: "ref-a", notifyOnIssueCreated: true, defaultChatId: "chat-a" });
    await emit(registered, "issue.created", issueCreatedEvent("company-a"));

    expect(sentMessages).toHaveLength(1);
  });

  it("advances ownership when a second company delivers byte-identical config (duplicated-config migration)", async () => {
    const { plugin } = await import("../src/worker.js");
    const sharedConfig = { telegramBotTokenRef: "ref-shared", defaultChatId: "chat-shared" };
    const { ctx } = makeCtx({
      companies: [{ id: "company-a" }],
      configByCompany: { "company-a": sharedConfig },
      resolveSecret: async () => "bot-token-shared",
    });
    await plugin.definition.setup(ctx);
    await plugin.definition.onConfigChanged!(sharedConfig);
    expect(ctx.secrets.resolve).toHaveBeenLastCalledWith("ref-shared", { companyId: "company-a" });

    // A host migration duplicated the exact same config under company-b.
    (ctx.companies.list as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: "company-b" }]);
    (ctx.config.get as ReturnType<typeof vi.fn>).mockImplementation(async (id?: string) =>
      id === "company-b" ? sharedConfig : (() => { throw new Error("denied"); })(),
    );
    await plugin.definition.onConfigChanged!(sharedConfig);

    expect(ctx.secrets.resolve).toHaveBeenLastCalledWith("ref-shared", { companyId: "company-b" });
    expect(ctx.logger.warn).not.toHaveBeenCalledWith(expect.stringContaining("ignoring configuration"), expect.anything());
  });

  it("refuses a second company's differing configuration and keeps the current owner's runtime", async () => {
    const { plugin } = await import("../src/worker.js");
    const configA = { telegramBotTokenRef: "ref-a", defaultChatId: "chat-a" };
    const configB = { telegramBotTokenRef: "ref-b", defaultChatId: "chat-b" };
    const { ctx } = makeCtx({
      companies: [{ id: "company-a" }],
      configByCompany: { "company-a": configA },
      resolveSecret: async () => "bot-token-a",
    });
    await plugin.definition.setup(ctx);
    await plugin.definition.onConfigChanged!(configA);

    (ctx.companies.list as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: "company-b" }]);
    (ctx.config.get as ReturnType<typeof vi.fn>).mockImplementation(async (id?: string) =>
      id === "company-b" ? configB : (() => { throw new Error("denied"); })(),
    );
    await plugin.definition.onConfigChanged!(configB);

    expect(ctx.secrets.resolve).not.toHaveBeenCalledWith("ref-b", { companyId: "company-b" });
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("ignoring configuration for company company-b"),
      expect.objectContaining({ ownerCompanyId: "company-a", deliveredCompanyId: "company-b" }),
    );
  });

  it("degrades health without throwing when no bot token is configured", async () => {
    const { plugin } = await import("../src/worker.js");
    const { ctx } = makeCtx({
      companies: [{ id: "company-a" }],
      configByCompany: { "company-a": { telegramBotTokenRef: "" } },
    });
    await plugin.definition.setup(ctx);

    await expect(plugin.definition.onConfigChanged!({ telegramBotTokenRef: "" })).resolves.toBeUndefined();

    const health = await plugin.definition.onHealth!();
    expect(health.status).toBe("degraded");
    expect(health.message).toMatch(/telegramBotTokenRef/i);
  });

  it("degrades health without throwing when the bot token secret cannot be resolved", async () => {
    const { plugin } = await import("../src/worker.js");
    const companyConfig = { telegramBotTokenRef: "ref-a" };
    const { ctx } = makeCtx({
      companies: [{ id: "company-a" }],
      configByCompany: { "company-a": companyConfig },
      resolveSecret: async () => { throw new Error("secret store unavailable"); },
    });
    await plugin.definition.setup(ctx);

    await expect(plugin.definition.onConfigChanged!(companyConfig)).resolves.toBeUndefined();

    const health = await plugin.definition.onHealth!();
    expect(health.status).toBe("degraded");
  });

  it("ACP output listener resolves the token lazily and no-ops before a delivery lands", async () => {
    const { plugin } = await import("../src/worker.js");
    const { ctx, registered } = makeCtx();
    await plugin.definition.setup(ctx);

    await emit(registered, "plugin.paperclip-plugin-acp.output", {
      payload: { sessionId: "s1", chatId: "chat-a", threadId: 1, text: "hi" },
    });

    expect(ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("no active runtime"),
    );
  });

  it("stops polling on plugin.stopping without leaving the loop running", async () => {
    const { plugin } = await import("../src/worker.js");
    const companyConfig = { telegramBotTokenRef: "ref-a", enableInbound: true };
    const { ctx, registered } = makeCtx({
      companies: [{ id: "company-a" }],
      configByCompany: { "company-a": companyConfig },
      resolveSecret: async () => "bot-token-a",
    });
    await plugin.definition.setup(ctx);
    await plugin.definition.onConfigChanged!(companyConfig);

    // Let the poll loop take its first (rejecting) tick and park on backoff.
    await vi.advanceTimersByTimeAsync(0);

    await expect(emit(registered, "plugin.stopping", undefined)).resolves.toBeUndefined();
  });

  // Telegram allows only one live getUpdates consumer per bot token; a second
  // concurrent long-poll gets a 409. pollUpdates has no restart-on-config-change
  // logic to guard against that risk -- it starts exactly once (`pollingActive`
  // in bootstrapRuntime) and re-reads `runtime` fresh at the top of every tick
  // instead. That means a token rotation arriving while a getUpdates call is
  // still in flight can never spin up a second loop; it only changes what the
  // *next* tick sends. This test races exactly that: a rotation lands mid-flight
  // and asserts no second getUpdates call is ever made, the in-flight (stale)
  // response is handled exactly once, and the following tick is the first to
  // use the rotated token.
  it("never starts a second getUpdates call when a token rotates while one is in flight", async () => {
    const { plugin } = await import("../src/worker.js");
    const configA = { telegramBotTokenRef: "ref-a", enableInbound: true, enableCommands: true };
    const configB = { telegramBotTokenRef: "ref-b", enableInbound: true, enableCommands: true };
    const { ctx } = makeCtx({
      companies: [{ id: "company-a" }],
      configByCompany: { "company-a": configA },
      resolveSecret: async (ref: string) => (ref === "ref-a" ? "bot-token-a" : "bot-token-b"),
    });

    const fetchUrls: string[] = [];
    let resolveFirstFetch!: (value: { json: () => Promise<unknown> }) => void;
    const firstFetch = new Promise<{ json: () => Promise<unknown> }>((resolve) => {
      resolveFirstFetch = resolve;
    });
    (ctx.http.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => {
      fetchUrls.push(url);
      // First call: held open, simulating Telegram's in-flight long-poll.
      // Every later call: parked forever -- the test only needs to observe
      // that it happened, never that it resolves.
      return fetchUrls.length === 1 ? firstFetch : new Promise(() => {});
    });

    await plugin.definition.setup(ctx);
    await plugin.definition.onConfigChanged!(configA);

    // Let pollUpdates take its first tick: it reads runtime (token A) and is
    // now suspended awaiting the deferred getUpdates response.
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchUrls).toHaveLength(1);
    expect(fetchUrls[0]).toContain("bot-token-a");

    // Token rotation mid-flight. Same company, so this is an in-place
    // refresh -- allowed unconditionally -- and takes effect in `runtime`
    // immediately, while the token-A getUpdates call above is still pending.
    (ctx.config.get as ReturnType<typeof vi.fn>).mockImplementation(async (id?: string) =>
      id === "company-a" ? configB : (() => { throw new Error("denied"); })(),
    );
    await plugin.definition.onConfigChanged!(configB);

    // The 409-avoidance property: rotating the token never fires a second,
    // concurrent getUpdates call while the first is still outstanding.
    expect(fetchUrls).toHaveLength(1);

    // Resolve the stale (pre-rotation) call with an update.
    resolveFirstFetch({
      json: async () => ({
        ok: true,
        result: [
          {
            update_id: 5,
            message: {
              message_id: 1,
              chat: { id: 111, type: "private" },
              text: "/help",
              entities: [{ type: "bot_command", offset: 0, length: 5 }],
            },
          },
        ],
      }),
    });
    await vi.advanceTimersByTimeAsync(0);

    // Handled exactly once -- not dropped, not double-processed -- and the
    // offset it carries is persisted exactly once.
    expect(sentMessages).toHaveLength(1);
    expect(ctx.state.set).toHaveBeenCalledTimes(1);
    expect(ctx.state.set).toHaveBeenCalledWith(
      expect.objectContaining({ stateKey: "telegram-last-update-id" }),
      5,
    );

    // The next tick is the first to read the rotated token -- confirming the
    // rotation was deferred to the next iteration, not lost.
    expect(fetchUrls).toHaveLength(2);
    expect(fetchUrls[1]).toContain("bot-token-b");
  });
});
