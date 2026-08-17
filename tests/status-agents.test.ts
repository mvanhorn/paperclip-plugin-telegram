import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Agent, PluginContext } from "@paperclipai/plugin-sdk";

const sent: string[] = [];

vi.mock("../src/telegram-api.js", () => ({
  sendMessage: vi.fn(async (_c: unknown, _t: string, _chat: string, text: string) => {
    sent.push(text);
    return { ok: true };
  }),
  sendChatAction: vi.fn(async () => ({ ok: true })),
  escapeMarkdownV2: (s: string) => s,
}));

const { handleCommand } = await import("../src/commands.js");

function agent(status: string): Agent {
  return { id: `a-${status}-${Math.random()}`, name: `Agent ${status}`, status } as Agent;
}

function makeCtx(agents: Agent[]): PluginContext {
  return {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    metrics: { write: vi.fn(async () => undefined) },
    agents: { list: vi.fn(async () => agents) },
    issues: { list: vi.fn(async () => []) },
    state: { get: vi.fn(async () => null), set: vi.fn(async () => undefined) },
  } as unknown as PluginContext;
}

describe("/status agent counts", () => {
  beforeEach(() => {
    sent.length = 0;
  });

  it("counts running agents — the old filter looked for a status that never occurs", async () => {
    // Agents report "running"/"idle"; nothing is ever "active", so the previous
    // `status === "active"` filter reported 0 while agents were working.
    const ctx = makeCtx([agent("running"), agent("idle"), agent("idle")]);
    await handleCommand(ctx, "tok", "chat-1", "status", "", undefined, undefined, undefined, "company-1");
    expect(sent.at(-1)).toContain("1* running");
  });

  it("still counts a legacy 'active' status as running", async () => {
    const ctx = makeCtx([agent("active"), agent("idle")]);
    await handleCommand(ctx, "tok", "chat-1", "status", "", undefined, undefined, undefined, "company-1");
    expect(sent.at(-1)).toContain("1* running");
  });

  it("reports availability separately from running, and flags paused/error", async () => {
    const ctx = makeCtx([agent("running"), agent("idle"), agent("paused"), agent("error")]);
    await handleCommand(ctx, "tok", "chat-1", "status", "", undefined, undefined, undefined, "company-1");
    const text = sent.at(-1)!;
    expect(text).toContain("1* running");
    expect(text).toContain("2* available");
    expect(text).toContain("2 paused/error");
  });

  it("omits the paused/error note when everything is healthy", async () => {
    const ctx = makeCtx([agent("idle"), agent("idle")]);
    await handleCommand(ctx, "tok", "chat-1", "status", "", undefined, undefined, undefined, "company-1");
    expect(sent.at(-1)).not.toContain("paused/error");
  });
});
