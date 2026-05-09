import { describe, it, expect, vi } from "vitest";
import { resolveMappedProjectIdForTopic } from "../src/topic-projects.js";
import type { PluginContext } from "@paperclipai/plugin-sdk";

function mockCtx(overrides: {
  topicMap?: Record<string, unknown> | null;
  projects?: Array<{ id: string; name: string }>;
  projectsListThrows?: boolean;
} = {}): PluginContext {
  const projectsList = overrides.projectsListThrows
    ? vi.fn().mockRejectedValue(new Error("upstream unavailable"))
    : vi.fn().mockResolvedValue(overrides.projects ?? []);
  return {
    state: {
      get: vi.fn().mockResolvedValue(overrides.topicMap ?? null),
      set: vi.fn(),
    },
    projects: { list: projectsList },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as PluginContext;
}

describe("resolveMappedProjectIdForTopic", () => {
  it("returns undefined when no messageThreadId is provided", async () => {
    const ctx = mockCtx();
    expect(await resolveMappedProjectIdForTopic(ctx, "chat-1", "co-1")).toBeUndefined();
  });

  it("returns undefined when no topic-map exists for the chat", async () => {
    const ctx = mockCtx({ topicMap: null });
    expect(await resolveMappedProjectIdForTopic(ctx, "chat-1", "co-1", 42)).toBeUndefined();
  });

  it("returns the projectId directly when the new record-shape mapping has one", async () => {
    const ctx = mockCtx({
      topicMap: {
        "Setup and Tests": { projectId: "p-1", projectName: "Setup and Tests", topicId: "42" },
      },
    });
    expect(await resolveMappedProjectIdForTopic(ctx, "chat-1", "co-1", 42)).toBe("p-1");
  });

  it("falls back to name-based project lookup for the legacy string-shape mapping", async () => {
    const ctx = mockCtx({
      topicMap: {
        "Setup and Tests": "42",
      },
      projects: [
        { id: "p-other", name: "Other" },
        { id: "p-target", name: "Setup and Tests" },
      ],
    });
    expect(await resolveMappedProjectIdForTopic(ctx, "chat-1", "co-1", 42)).toBe("p-target");
  });

  it("falls back to case-insensitive name lookup when no exact match exists", async () => {
    const ctx = mockCtx({
      topicMap: {
        "Setup And Tests": "42",
      },
      projects: [{ id: "p-target", name: "setup and tests" }],
    });
    expect(await resolveMappedProjectIdForTopic(ctx, "chat-1", "co-1", 42)).toBe("p-target");
  });

  it("logs a warning and returns undefined when ctx.projects.list throws", async () => {
    const ctx = mockCtx({
      topicMap: { "Setup and Tests": "42" },
      projectsListThrows: true,
    });

    expect(await resolveMappedProjectIdForTopic(ctx, "chat-1", "co-1", 42)).toBeUndefined();
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      "Failed to look up project for legacy topic mapping",
      expect.objectContaining({
        chatId: "chat-1",
        companyId: "co-1",
        projectName: "Setup and Tests",
      }),
    );
  });
});
