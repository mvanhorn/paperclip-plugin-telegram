import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";

let sentMessages: Array<{ chatId: string; text: string; options?: Record<string, unknown> }> = [];
let editedMessages: Array<{ chatId: string; messageId: number; text: string }> = [];
let answeredCallbacks: string[] = [];
let stateStore: Record<string, unknown> = {};

vi.mock("../src/telegram-api.js", async () => {
  const actual = await vi.importActual("../src/telegram-api.js") as Record<string, unknown>;
  return {
    ...actual,
    sendMessage: vi.fn(async (_c: unknown, _t: string, chatId: string, text: string, options?: Record<string, unknown>) => {
      sentMessages.push({ chatId, text, options });
      return 1;
    }),
    sendChatAction: vi.fn(),
    editMessage: vi.fn(async (_c: unknown, _t: string, chatId: string, messageId: number, text: string) => {
      editedMessages.push({ chatId, messageId, text });
    }),
    answerCallbackQuery: vi.fn(async (_c: unknown, _t: string, _id: string, text?: string) => {
      answeredCallbacks.push(text ?? "");
    }),
  };
});

const { tryCustomCommand, isWorkflowApprovalCallback, resolveWorkflowApprovalCallback } =
  await import("../src/command-registry.js");

/**
 * BLA-156. `wait_approval` sent Approve/Reject buttons whose callbacks were
 * handled nowhere — and, worse, the executor did not stop at the gate. It
 * pushed the step's result and carried straight on, so every step the approval
 * existed to hold back ran anyway. The button was decorative.
 *
 * It cannot be fixed by awaiting the press: Telegram delivers updates strictly
 * sequentially, so a workflow blocking on a button blocks the loop that would
 * deliver it. The run must park and be resumed from the callback handler.
 */

const COMMAND = {
  name: "deploy",
  description: "deploy something",
  steps: [
    { id: "s1", type: "send_message", text: "starting" },
    { id: "s2", type: "wait_approval", prompt: "Ship it?" },
    { id: "s3", type: "send_message", text: "SHIPPED" },
  ],
};

function mockCtx(): PluginContext {
  return {
    http: { fetch: vi.fn() },
    metrics: { write: vi.fn() },
    state: {
      get: vi.fn(async (key: { stateKey: string }) => stateStore[key.stateKey] ?? null),
      set: vi.fn(async (key: { stateKey: string }, value: unknown) => {
        stateStore[key.stateKey] = value;
      }),
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    config: { get: vi.fn().mockResolvedValue({}) },
    issues: { get: vi.fn(), update: vi.fn() },
    agents: { invoke: vi.fn() },
  } as unknown as PluginContext;
}

/** The registry key tryCustomCommand reads for a company. */
function seedCommand(companyId = "co-1") {
  stateStore[`commands_${companyId}`] = [COMMAND];
}

/** The approval id embedded in the Approve button we just sent. */
function approvalIdFromButtons(): string {
  const withButtons = sentMessages.find((m) => m.options?.inlineKeyboard);
  const kb = withButtons!.options!.inlineKeyboard as Array<Array<{ callback_data: string }>>;
  return kb[0]![0]!.callback_data.replace("cmd_approve_", "");
}

beforeEach(() => {
  sentMessages = [];
  editedMessages = [];
  answeredCallbacks = [];
  stateStore = {};
});

describe("wait_approval gate", () => {
  it("stops the workflow at the gate instead of running past it", async () => {
    // The original defect. "SHIPPED" must not appear before anyone approves.
    seedCommand();
    const ctx = mockCtx();

    await tryCustomCommand(ctx, "tok", "chat-1", "deploy", "", undefined, "co-1");

    expect(sentMessages.map((m) => m.text)).toContain("starting");
    expect(sentMessages.map((m) => m.text)).not.toContain("SHIPPED");
  });

  it("offers Approve and Reject buttons", async () => {
    seedCommand();
    const ctx = mockCtx();

    await tryCustomCommand(ctx, "tok", "chat-1", "deploy", "", undefined, "co-1");

    const gate = sentMessages.find((m) => m.text === "Ship it?");
    const kb = gate!.options!.inlineKeyboard as Array<Array<{ text: string; callback_data: string }>>;
    expect(kb[0]!.map((b) => b.text)).toEqual(["Approve", "Reject"]);
  });

  it("keeps callback_data within Telegram's 64-byte limit", async () => {
    // Over 64 bytes Telegram rejects the button outright and the gate becomes
    // unanswerable — the failure this project already shipped once.
    seedCommand();
    const ctx = mockCtx();

    await tryCustomCommand(ctx, "tok", "chat-1", "deploy", "", undefined, "co-1");

    const gate = sentMessages.find((m) => m.options?.inlineKeyboard);
    const kb = gate!.options!.inlineKeyboard as Array<Array<{ callback_data: string }>>;
    for (const button of kb[0]!) {
      expect(Buffer.byteLength(button.callback_data, "utf8")).toBeLessThanOrEqual(64);
    }
  });

  it("runs the steps after the gate once approved", async () => {
    seedCommand();
    const ctx = mockCtx();
    await tryCustomCommand(ctx, "tok", "chat-1", "deploy", "", undefined, "co-1");
    const id = approvalIdFromButtons();

    await resolveWorkflowApprovalCallback(ctx, "tok", `cmd_approve_${id}`, "cbq-1", "vagif", 55);

    expect(sentMessages.map((m) => m.text)).toContain("SHIPPED");
    expect(answeredCallbacks).toContain("Approved");
  });

  it("does not run them when rejected", async () => {
    seedCommand();
    const ctx = mockCtx();
    await tryCustomCommand(ctx, "tok", "chat-1", "deploy", "", undefined, "co-1");
    const id = approvalIdFromButtons();

    await resolveWorkflowApprovalCallback(ctx, "tok", `cmd_reject_${id}`, "cbq-1", "vagif", 55);

    expect(sentMessages.map((m) => m.text)).not.toContain("SHIPPED");
    expect(answeredCallbacks).toContain("Rejected");
  });

  it("runs the tail exactly once when Approve is pressed twice", async () => {
    // Telegram leaves the buttons on screen and redelivers callbacks it counts
    // as unacknowledged, so a second press is expected rather than unlucky.
    seedCommand();
    const ctx = mockCtx();
    await tryCustomCommand(ctx, "tok", "chat-1", "deploy", "", undefined, "co-1");
    const id = approvalIdFromButtons();

    await resolveWorkflowApprovalCallback(ctx, "tok", `cmd_approve_${id}`, "cbq-1", "vagif", 55);
    await resolveWorkflowApprovalCallback(ctx, "tok", `cmd_approve_${id}`, "cbq-2", "vagif", 55);

    expect(sentMessages.filter((m) => m.text === "SHIPPED")).toHaveLength(1);
    expect(answeredCallbacks).toContain("This approval is no longer pending.");
  });

  it("cannot be approved after it was rejected", async () => {
    seedCommand();
    const ctx = mockCtx();
    await tryCustomCommand(ctx, "tok", "chat-1", "deploy", "", undefined, "co-1");
    const id = approvalIdFromButtons();

    await resolveWorkflowApprovalCallback(ctx, "tok", `cmd_reject_${id}`, "cbq-1", "vagif", 55);
    await resolveWorkflowApprovalCallback(ctx, "tok", `cmd_approve_${id}`, "cbq-2", "vagif", 55);

    expect(sentMessages.map((m) => m.text)).not.toContain("SHIPPED");
  });

  it("says so rather than going quiet when the approval is unknown", async () => {
    const ctx = mockCtx();

    await resolveWorkflowApprovalCallback(ctx, "tok", "cmd_approve_never-existed", "cbq-1", "vagif", 55);

    expect(answeredCallbacks).toContain("This approval is no longer pending.");
  });

  it("explains itself when the command was deleted while the gate was pending", async () => {
    seedCommand();
    const ctx = mockCtx();
    await tryCustomCommand(ctx, "tok", "chat-1", "deploy", "", undefined, "co-1");
    const id = approvalIdFromButtons();
    stateStore["commands_co-1"] = [];

    await resolveWorkflowApprovalCallback(ctx, "tok", `cmd_approve_${id}`, "cbq-1", "vagif", 55);

    expect(sentMessages.some((m) => m.text.includes("no longer exists"))).toBe(true);
  });

  it("records who decided, on the message itself", async () => {
    seedCommand();
    const ctx = mockCtx();
    await tryCustomCommand(ctx, "tok", "chat-1", "deploy", "", undefined, "co-1");
    const id = approvalIdFromButtons();

    await resolveWorkflowApprovalCallback(ctx, "tok", `cmd_approve_${id}`, "cbq-1", "vagif", 55);

    expect(editedMessages[0]!.text).toContain("vagif");
  });

  it("gives each gate in a run a distinct id", async () => {
    // Two gates parking in the same millisecond must not share a key, or
    // approving one resumes the other's continuation.
    stateStore["commands_co-1"] = [{
      name: "twogates",
      steps: [
        { id: "a", type: "wait_approval", prompt: "First?" },
        { id: "b", type: "wait_approval", prompt: "Second?" },
      ],
    }];
    const ctx = mockCtx();

    await tryCustomCommand(ctx, "tok", "chat-1", "twogates", "", undefined, "co-1");
    const first = approvalIdFromButtons();
    await resolveWorkflowApprovalCallback(ctx, "tok", `cmd_approve_${first}`, "cbq-1", "vagif", 55);

    const ids = sentMessages
      .filter((m) => m.options?.inlineKeyboard)
      .map((m) => (m.options!.inlineKeyboard as Array<Array<{ callback_data: string }>>)[0]![0]!.callback_data);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("isWorkflowApprovalCallback", () => {
  it("claims its own callbacks", () => {
    expect(isWorkflowApprovalCallback("cmd_approve_123")).toBe(true);
    expect(isWorkflowApprovalCallback("cmd_reject_123")).toBe(true);
  });

  it("does not claim the host approval callbacks it sits next to", () => {
    // worker.ts routes on prefixes; claiming "approve_" here would swallow the
    // Paperclip approval flow entirely.
    expect(isWorkflowApprovalCallback("approve_abc")).toBe(false);
    expect(isWorkflowApprovalCallback("esc_1_2")).toBe(false);
    expect(isWorkflowApprovalCallback("ia:answer:x")).toBe(false);
  });
});
