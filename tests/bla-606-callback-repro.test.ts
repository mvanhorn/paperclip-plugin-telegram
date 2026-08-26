import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";

let sentMessages: Array<{ chatId: string; text: string; options?: Record<string, unknown> }> = [];
let editedMessages: Array<{ chatId: string; messageId: number; text: string }> = [];
let answeredCallbacks: Array<{ id: string; text?: string }> = [];
let stateStore: Record<string, unknown> = {};

vi.mock("../src/telegram-api.js", async () => {
  const actual = await vi.importActual("../src/telegram-api.js");
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
    answerCallbackQuery: vi.fn(async (_c: unknown, _t: string, id: string, text?: string) => {
      answeredCallbacks.push({ id, text });
    }),
  };
});

const { handleUpdate } = await import("../src/worker.js");

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
    secrets: { resolve: vi.fn().mockResolvedValue("fake-token") },
    issues: { get: vi.fn(), update: vi.fn() },
    agents: { invoke: vi.fn(), list: vi.fn().mockResolvedValue([]) },
    companies: { list: vi.fn().mockResolvedValue([]) },
  } as unknown as PluginContext;
}

const DEFAULT_CONFIG_FIELDS = {
  telegramBotTokenRef: "tok-ref",
  defaultChatId: "",
  approvalsChatId: "",
  approvalsTopicId: "",
  errorsChatId: "",
  errorsTopicId: "",
  digestChatId: "",
  digestTopicId: "",
  paperclipBaseUrl: "https://paperclip.example",
  paperclipBoardApiTokenRef: "",
  paperclipPublicUrl: "",
  notifyOnIssueCreated: false,
  notifyOnIssueDone: false,
  notifyOnIssueAssigned: false,
  onlyNotifyIfAssignedTo: "",
  notifyOnApprovalCreated: false,
  onlyNotifyBoardApprovals: false,
  notifyOnAgentError: false,
  notifyOnAgentRunStarted: false,
  notifyOnAgentRunFinished: false,
  enableCommands: true,
  enableInbound: true,
  allowedTelegramUserIds: [],
  allowedTelegramChatIds: [],
  digestMode: "off" as const,
  dailyDigestTime: "",
  bidailySecondTime: "",
  tridailyTimes: "",
  topicRouting: false,
  maxAgentsPerThread: 5,
  escalationChatId: "",
  escalationTimeoutMs: 0,
  escalationDefaultAction: "defer" as const,
  escalationHoldMessage: "",
  briefAgentId: "",
  briefAgentChatIds: [],
  transcriptionApiKeyRef: "",
  maxSuggestionsPerHourPerCompany: 10,
  watchDeduplicationWindowMs: 86400000,
};

beforeEach(() => {
  sentMessages = [];
  editedMessages = [];
  answeredCallbacks = [];
  stateStore = {};
});

/**
 * Reproduces BLA-606 against handleUpdate end-to-end (not calling
 * resolveWorkflowApprovalCallback directly, the way tests/workflow-approval.test.ts
 * does) -- this is the layer that was never exercised by that test, and is
 * exactly the layer that's broken in production.
 */
describe("BLA-606 repro: callback_query for a parked wait_approval, via handleUpdate", () => {
  it("reaches resolveWorkflowApprovalCallback and edits the message when the parked state exists", async () => {
    const ctx = mockCtx();
    const approvalId = "1700000000000_s1";

    // Seed exactly what executeWorkflow would have written when it parked.
    stateStore[`cmd_approval_${approvalId}`] = {
      commandName: "testapproval",
      args: [],
      results: [],
      nextStepIndex: 1,
      chatId: "999",
      companyId: "co-1",
      createdAt: Date.now(),
    };
    // Seed the command itself so resolveWorkflowApprovalCallback can find it and continue.
    stateStore["commands_co-1"] = [
      {
        name: "testapproval",
        description: "test",
        steps: [
          { id: "s1", type: "wait_approval", prompt: "Approve this test?" },
          { id: "s2", type: "send_message", text: "Gate passed - resumed after approval" },
        ],
        createdBy: "tester",
        createdAt: new Date().toISOString(),
      },
    ];

    const update = {
      update_id: 1,
      callback_query: {
        id: "cbq-1",
        from: { id: 555, username: "tester" },
        message: { message_id: 42, chat: { id: 999 }, text: "Approve this test?" },
        data: `cmd_approve_${approvalId}`,
      },
    };

    await handleUpdate(
      ctx,
      "fake-bot-token",
      DEFAULT_CONFIG_FIELDS,
      update,
      "https://paperclip.example",
      undefined,
      undefined,
      "co-1",
    );

    console.log("answeredCallbacks:", JSON.stringify(answeredCallbacks));
    console.log("editedMessages:", JSON.stringify(editedMessages));
    console.log("sentMessages:", JSON.stringify(sentMessages));
    console.log("logger.warn calls:", JSON.stringify((ctx.logger.warn as ReturnType<typeof vi.fn>).mock.calls));
    console.log("logger.error calls:", JSON.stringify((ctx.logger.error as ReturnType<typeof vi.fn>).mock.calls));

    // What we SHOULD see if this worked: an answered callback and an edited message.
    expect(answeredCallbacks.length).toBeGreaterThan(0);
    expect(editedMessages.length).toBeGreaterThan(0);
  });
});
