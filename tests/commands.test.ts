import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleCommand, BOT_COMMANDS, handleConnectTopic, getTopicForProject } from "../src/commands.js";
import type { PluginContext } from "@paperclipai/plugin-sdk";

let sentMessages: Array<{ chatId: string; text: string; options?: Record<string, unknown> }> = [];
let metricsWritten: Array<{ name: string; value: number }> = [];
let stateStore: Record<string, unknown> = {};

function mockCtx(): PluginContext {
  return {
    http: {
      fetch: vi.fn().mockResolvedValue({
        json: () => Promise.resolve({ ok: true }),
      }),
    },
    metrics: {
      write: vi.fn(async (name: string, value: number) => {
        metricsWritten.push({ name, value });
      }),
    },
    state: {
      get: vi.fn(async (key: { stateKey: string }) => stateStore[key.stateKey] ?? null),
      set: vi.fn(async (key: { stateKey: string }, value: unknown) => {
        stateStore[key.stateKey] = value;
      }),
    },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    agents: {
      list: vi.fn().mockResolvedValue([
        { id: "a1", name: "Builder", status: "active" },
        { id: "a2", name: "Tester", status: "paused" },
      ]),
    },
    issues: {
      list: vi.fn().mockResolvedValue([
        { id: "i1", identifier: "PROJ-1", title: "Fix bug", status: "todo", project: null },
        { id: "i2", identifier: "PROJ-2", title: "Add feature", status: "done", project: { name: "Backend" } },
      ]),
    },
  } as unknown as PluginContext;
}

vi.mock("../src/telegram-api.js", async () => {
  const actual = await vi.importActual("../src/telegram-api.js") as Record<string, unknown>;
  return {
    ...actual,
    sendMessage: vi.fn(async (_ctx: unknown, _token: string, chatId: string, text: string, options?: Record<string, unknown>) => {
      sentMessages.push({ chatId, text, options });
      return 1;
    }),
    sendChatAction: vi.fn(),
  };
});

beforeEach(() => {
  sentMessages = [];
  metricsWritten = [];
  stateStore = {};
});

describe("handleCommand", () => {
  it("routes /help command", async () => {
    const ctx = mockCtx();
    await handleCommand(ctx, "token", "123", "help", "");
    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0].text).toContain("Paperclip Bot Commands");
  });

  it("routes /status command and shows agent/issue counts", async () => {
    const ctx = mockCtx();
    await handleCommand(ctx, "token", "123", "status", "");
    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0].text).toContain("Paperclip Status");
  });

  it("routes /issues command", async () => {
    const ctx = mockCtx();
    await handleCommand(ctx, "token", "123", "issues", "");
    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0].text).toContain("Issues");
  });

  it("routes /agents command", async () => {
    const ctx = mockCtx();
    await handleCommand(ctx, "token", "123", "agents", "");
    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0].text).toContain("Agents");
  });

  it("routes /approve without args shows usage", async () => {
    const ctx = mockCtx();
    await handleCommand(ctx, "token", "123", "approve", "");
    expect(sentMessages[0].text).toContain("Usage");
  });

  it("routes /approve with id calls API with configurable base URL", async () => {
    const ctx = mockCtx();
    await handleCommand(ctx, "token", "123", "approve", "apr-1", undefined, "http://example.com");
    expect(ctx.http.fetch).toHaveBeenCalledWith(
      "http://example.com/api/approvals/apr-1/approve",
      expect.any(Object),
    );
  });

  it("handles unknown command", async () => {
    const ctx = mockCtx();
    await handleCommand(ctx, "token", "123", "foobar", "");
    expect(sentMessages[0].text).toContain("Unknown command");
  });

  it("passes messageThreadId for forum topics", async () => {
    const ctx = mockCtx();
    await handleCommand(ctx, "token", "123", "help", "", 42);
    expect(sentMessages[0].options).toMatchObject({ messageThreadId: 42 });
  });

  it("increments commands metric", async () => {
    const ctx = mockCtx();
    await handleCommand(ctx, "token", "123", "help", "");
    expect(metricsWritten.some(m => m.name === "telegram_commands_handled")).toBe(true);
  });

  it("/connect stores company mapping", async () => {
    const ctx = mockCtx();
    (ctx.companies as unknown) = {
      list: vi.fn().mockResolvedValue([{ id: "co-1", name: "MyCompany" }]),
    };
    await handleCommand(ctx, "token", "123", "connect", "MyCompany");
    expect(stateStore["chat_123"]).toEqual(
      expect.objectContaining({ companyId: "co-1", companyName: "MyCompany" }),
    );
  });

  it("/connect without args shows usage", async () => {
    const ctx = mockCtx();
    await handleCommand(ctx, "token", "123", "connect", "");
    expect(sentMessages[0].text).toContain("Usage");
  });

  it("/issues filters by project name", async () => {
    const ctx = mockCtx();
    await handleCommand(ctx, "token", "123", "issues", "Backend");
    expect(sentMessages[0].text).toContain("PROJ\\-2");
  });

  it("/agents shows agent names and status", async () => {
    const ctx = mockCtx();
    await handleCommand(ctx, "token", "123", "agents", "");
    expect(sentMessages[0].text).toContain("Builder");
    expect(sentMessages[0].text).toContain("Tester");
  });

  it("/create without args shows usage", async () => {
    const ctx = mockCtx();
    await handleCommand(ctx, "token", "123", "create", "");
    expect(sentMessages[0].text).toContain("Usage");
  });

  it("/create creates issue then updates assignee and status to trigger wake", async () => {
    const ctx = mockCtx();
    (ctx.agents as unknown) = {
      list: vi.fn().mockResolvedValue([
        { id: "a1", name: "Builder", status: "active", role: "engineer" },
        { id: "ceo-1", name: "Zhu Li", status: "idle", role: "ceo" },
      ]),
    };
    (ctx.companies as unknown) = {
      get: vi.fn().mockResolvedValue({ id: "co-1", name: "MyCompany", issuePrefix: "MC" }),
    };
    const createdIssue = { id: "i-new", identifier: "MC-99", title: "Board prep for Q1", status: "backlog" };
    const updatedIssue = { ...createdIssue, status: "todo", assigneeAgentId: "ceo-1" };
    (ctx.issues as unknown) = {
      ...ctx.issues,
      create: vi.fn().mockResolvedValue(createdIssue),
      update: vi.fn().mockResolvedValue(updatedIssue),
    };
    await handleCommand(ctx, "token", "123", "create", "Board prep for Q1");
    // Create call: NO assignee (important for wake trigger)
    expect(ctx.issues.create).toHaveBeenCalledWith(
      expect.not.objectContaining({ assigneeAgentId: expect.any(String) }),
    );
    // Update call: sets BOTH status and assignee atomically, fires issue_assigned wake
    expect(ctx.issues.update).toHaveBeenCalledWith(
      "i-new",
      { status: "todo", assigneeAgentId: "ceo-1" },
      expect.any(String),
    );
    expect(sentMessages[0].text).toContain("Task created");
    expect(sentMessages[0].text).toContain("MC\\-99");
    expect(sentMessages[0].text).toContain("Zhu Li");
  });

  it("/create works without a CEO agent", async () => {
    const ctx = mockCtx();
    (ctx.agents as unknown) = {
      list: vi.fn().mockResolvedValue([
        { id: "a1", name: "Builder", status: "active", role: "engineer" },
      ]),
    };
    (ctx.companies as unknown) = {
      get: vi.fn().mockResolvedValue({ id: "co-1", name: "MyCompany", issuePrefix: null }),
    };
    const createdIssue = { id: "i-new", identifier: "MC-100", title: "Some task", status: "backlog" };
    (ctx.issues as unknown) = {
      ...ctx.issues,
      create: vi.fn().mockResolvedValue(createdIssue),
      update: vi.fn().mockResolvedValue({ ...createdIssue, status: "todo" }),
    };
    await handleCommand(ctx, "token", "123", "create", "Some task");
    expect(ctx.issues.create).toHaveBeenCalledWith(
      expect.not.objectContaining({ assigneeAgentId: expect.any(String) }),
    );
    expect(ctx.issues.update).toHaveBeenCalledWith(
      "i-new",
      { status: "todo" },
      expect.any(String),
    );
    expect(sentMessages[0].text).toContain("Task created");
  });
});

describe("handleConnectTopic", () => {
  it("stores topic mapping for a project", async () => {
    const ctx = mockCtx();
    await handleConnectTopic(ctx, "token", "123", "Backend 42");
    expect(stateStore["topic-map-123"]).toEqual({ Backend: "42" });
  });

  it("shows usage when args are insufficient", async () => {
    const ctx = mockCtx();
    await handleConnectTopic(ctx, "token", "123", "");
    expect(sentMessages[0].text).toContain("Usage");
  });

  it("appends to existing topic map", async () => {
    stateStore["topic-map-123"] = { Frontend: "10" };
    const ctx = mockCtx();
    await handleConnectTopic(ctx, "token", "123", "Backend 42");
    expect(stateStore["topic-map-123"]).toEqual({ Frontend: "10", Backend: "42" });
  });
});

describe("getTopicForProject", () => {
  it("returns topic id for mapped project", async () => {
    stateStore["topic-map-123"] = { Backend: "42" };
    const ctx = mockCtx();
    const result = await getTopicForProject(ctx, "123", "Backend");
    expect(result).toBe(42);
  });

  it("returns undefined for unmapped project", async () => {
    stateStore["topic-map-123"] = { Backend: "42" };
    const ctx = mockCtx();
    const result = await getTopicForProject(ctx, "123", "Frontend");
    expect(result).toBeUndefined();
  });

  it("returns undefined when no topic map exists", async () => {
    const ctx = mockCtx();
    const result = await getTopicForProject(ctx, "123", "Backend");
    expect(result).toBeUndefined();
  });

  it("returns undefined when no project name", async () => {
    const ctx = mockCtx();
    const result = await getTopicForProject(ctx, "123");
    expect(result).toBeUndefined();
  });
});

describe("BOT_COMMANDS", () => {
  it("has all expected commands", () => {
    const names = BOT_COMMANDS.map(c => c.command);
    expect(names).toContain("status");
    expect(names).toContain("issues");
    expect(names).toContain("agents");
    expect(names).toContain("approve");
    expect(names).toContain("help");
    expect(names).toContain("connect");
    expect(names).toContain("connect_topic");
  });
});
