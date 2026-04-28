import { describe, expect, it, vi } from "vitest";
import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import { createIgorRecoveryIssueForRunFailure } from "../src/recovery.js";

function makeCtx(overrides: Partial<PluginContext> = {}) {
  const ctx = {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    http: { fetch: vi.fn() },
    agents: { list: vi.fn() },
    issues: { list: vi.fn(), get: vi.fn(), create: vi.fn(), update: vi.fn(), createComment: vi.fn() },
    ...overrides,
  } as unknown as PluginContext;
  return ctx;
}

const event = {
  companyId: "co-1",
  entityType: "heartbeat_run",
  entityId: "run-1",
  payload: {},
} as unknown as PluginEvent;

describe("createIgorRecoveryIssueForRunFailure", () => {
  it("creates and assigns an Igor recovery issue from a failed run snapshot", async () => {
    const ctx = makeCtx();
    vi.mocked(ctx.http.fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        agentId: "agent-cody",
        errorCode: "runtime_error",
        contextSnapshot: {
          paperclipWake: { issue: { id: "issue-1", identifier: "CHO-123", title: "Build thing" } },
        },
      }),
    } as Response);
    vi.mocked(ctx.agents.list).mockResolvedValue([
      { id: "igor-1", name: "Igor", role: "ceo" },
      { id: "agent-cody", name: "Cody", role: "general" },
    ] as never);
    vi.mocked(ctx.issues.get).mockResolvedValue({
      id: "issue-1",
      identifier: "CHO-123",
      title: "Build thing",
      projectId: "project-1",
      requestDepth: 2,
    } as never);
    vi.mocked(ctx.issues.list).mockResolvedValue([] as never);
    vi.mocked(ctx.issues.create).mockResolvedValue({ id: "recovery-1" } as never);
    vi.mocked(ctx.issues.update).mockResolvedValue({
      id: "recovery-1",
      title: "Recover failed run on CHO-123",
      assigneeAgentId: "igor-1",
      status: "todo",
    } as never);

    const result = await createIgorRecoveryIssueForRunFailure(ctx, event, "http://paperclip.local");

    expect(ctx.http.fetch).toHaveBeenCalledWith("http://paperclip.local/api/heartbeat-runs/run-1");
    expect(ctx.issues.create).toHaveBeenCalledWith(expect.objectContaining({
      companyId: "co-1",
      projectId: "project-1",
      title: "Recover failed run on CHO-123",
      priority: "high",
      originKind: "plugin",
      originId: "paperclip-plugin-telegram:agent-run-failed-recovery",
      originRunId: "run-1",
      requestDepth: 3,
    }));
    expect(ctx.issues.update).toHaveBeenCalledWith("recovery-1", { status: "todo", assigneeAgentId: "igor-1" }, "co-1");
    expect(result?.id).toBe("recovery-1");
  });

  it("does not create a recovery issue for transient scheduled retries", async () => {
    const ctx = makeCtx();
    vi.mocked(ctx.http.fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ scheduledRetryAt: "2026-04-28T10:00:00.000Z", agentId: "agent-cody" }),
    } as Response);

    const result = await createIgorRecoveryIssueForRunFailure(ctx, event, "http://paperclip.local");

    expect(result).toBeNull();
    expect(ctx.issues.create).not.toHaveBeenCalled();
  });

  it("updates an existing open recovery issue instead of duplicating it", async () => {
    const ctx = makeCtx();
    vi.mocked(ctx.http.fetch).mockResolvedValue({ ok: false } as Response);
    vi.mocked(ctx.agents.list).mockResolvedValue([
      { id: "igor-1", name: "Igor", role: "ceo" },
      { id: "agent-cody", name: "Cody", role: "general" },
    ] as never);
    vi.mocked(ctx.issues.get).mockResolvedValue({
      id: "issue-1",
      identifier: "CHO-123",
      title: "Build thing",
    } as never);
    vi.mocked(ctx.issues.list).mockResolvedValue([
      { id: "existing-1", title: "Recover failed run on CHO-123", description: "old" },
    ] as never);

    const result = await createIgorRecoveryIssueForRunFailure(
      ctx,
      { ...event, payload: { runId: "run-2", issueId: "issue-1", agentId: "agent-cody", errorCode: "boom" } } as unknown as PluginEvent,
      "http://paperclip.local",
    );

    expect(ctx.issues.createComment).toHaveBeenCalledWith(
      "existing-1",
      expect.stringContaining("Another failed run matched this recovery route."),
      "co-1",
    );
    expect(ctx.issues.create).not.toHaveBeenCalled();
    expect(result?.id).toBe("existing-1");
  });
});
