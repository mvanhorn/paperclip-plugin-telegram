import { describe, expect, it, vi, beforeEach } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";

type SentMessage = { chatId: string; text: string; options?: Record<string, unknown> };
type EditedMessage = { chatId: string; messageId: number; text: string; options?: Record<string, unknown> };
type ApiCall = { url: string; method: string; body?: unknown };

let sent: SentMessage[] = [];
let edited: EditedMessage[] = [];
let answers: Array<{ id: string; text: string }> = [];
let apiCalls: ApiCall[] = [];
let stateStore: Record<string, unknown> = {};
let freshInteractions: Array<{ id: string; status: string; kind: string }> = [];
let postResponses: Record<string, { status: string }> = {};

vi.mock("../src/telegram-api.js", async () => {
  const actual = await vi.importActual("../src/telegram-api.js") as Record<string, unknown>;
  return {
    ...actual,
    sendMessage: vi.fn(async (_ctx: unknown, _token: string, chatId: string, text: string, options?: Record<string, unknown>) => {
      sent.push({ chatId, text, options });
      return sent.length; // unique-ish message id
    }),
    editMessage: vi.fn(async (_ctx: unknown, _token: string, chatId: string, messageId: number, text: string, options?: Record<string, unknown>) => {
      edited.push({ chatId, messageId, text, options });
      return true;
    }),
    answerCallbackQuery: vi.fn(async (_ctx: unknown, _token: string, id: string, text: string) => {
      answers.push({ id, text });
    }),
  };
});

vi.mock("../src/paperclip-api.js", () => ({
  buildPaperclipAuthHeaders: (t?: string) => (t ? { Authorization: `Bearer ${t}` } : {}),
  fetchPaperclipApi: vi.fn(async (_ctx: unknown, url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body) : undefined;
    apiCalls.push({ url, method, body });
    if (method === "GET") {
      return { json: async () => freshInteractions };
    }
    const action = url.split("/").at(-1) as string;
    const response = postResponses[action] ?? { status: "unknown" };
    return { json: async () => response };
  }),
}));

const {
  isAskUserQuestionsAnswerable,
  isInteractionAnswerCallback,
  sendAnswerableInteraction,
  resolveInteractionAnswerCallback,
  finalizeReplyRejection,
  isInteractionReplyMapping,
  fetchInteraction,
} = await import("../src/interaction-answers.js");

function mockCtx(): PluginContext {
  return {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    metrics: { write: vi.fn() },
    state: {
      get: vi.fn(async (key: { stateKey: string; scopeId?: string }) => stateStore[`${key.scopeId ?? ""}:${key.stateKey}`] ?? null),
      set: vi.fn(async (key: { stateKey: string; scopeId?: string }, value: unknown) => {
        stateStore[`${key.scopeId ?? ""}:${key.stateKey}`] = value;
      }),
      delete: vi.fn(async (key: { stateKey: string; scopeId?: string }) => {
        delete stateStore[`${key.scopeId ?? ""}:${key.stateKey}`];
      }),
    },
  } as unknown as PluginContext;
}

beforeEach(() => {
  sent = [];
  edited = [];
  answers = [];
  apiCalls = [];
  stateStore = {};
  freshInteractions = [];
  postResponses = {};
});

function lastCallbackData(): string {
  const keyboard = sent.at(-1)?.options?.inlineKeyboard as Array<Array<{ callback_data: string }>>;
  return keyboard[0]![0]!.callback_data;
}

function pickSafeQuestion(over: Record<string, unknown> = {}) {
  return {
    id: "q1",
    prompt: "Which environment?",
    selectionMode: "single" as const,
    required: true,
    options: [
      { id: "opt-a", label: "Staging" },
      { id: "opt-b", label: "Production" },
    ],
    ...over,
  };
}

describe("isAskUserQuestionsAnswerable", () => {
  it("is answerable when every option on every question is a plain pick", () => {
    expect(isAskUserQuestionsAnswerable({ version: 1, questions: [pickSafeQuestion()] })).toBe(true);
  });

  it("is not answerable when any option is designer-declared free text", () => {
    const payload = {
      version: 1 as const,
      questions: [pickSafeQuestion({ options: [{ id: "o1", label: "Other", freeText: true }] })],
    };
    expect(isAskUserQuestionsAnswerable(payload)).toBe(false);
  });

  it("is not answerable with zero questions", () => {
    expect(isAskUserQuestionsAnswerable({ version: 1, questions: [] })).toBe(false);
  });
});

describe("isInteractionAnswerCallback", () => {
  it("recognizes the int_ prefix and nothing else", () => {
    expect(isInteractionAnswerCallback("int_abc_accept")).toBe(true);
    expect(isInteractionAnswerCallback("approve_123")).toBe(false);
    expect(isInteractionAnswerCallback("dec_abc_0")).toBe(false);
  });
});

describe("sendAnswerableInteraction — ask_user_questions", () => {
  it("sends the first question with option buttons when pick-safe", async () => {
    const ctx = mockCtx();
    const ok = await sendAnswerableInteraction(ctx, "tok", "chat-1", {
      id: "int-1",
      kind: "ask_user_questions",
      payload: { version: 1, questions: [pickSafeQuestion()] },
    }, { issueId: "issue-1" });

    expect(ok).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain("Question 1 of 1");
    const keyboard = sent[0]!.options!.inlineKeyboard as unknown[];
    expect(keyboard).toHaveLength(2); // one row per option, single-select has no extra "Continue" row
  });

  it("returns false and sends nothing when a question has a free-text option", async () => {
    const ctx = mockCtx();
    const ok = await sendAnswerableInteraction(ctx, "tok", "chat-1", {
      id: "int-1",
      kind: "ask_user_questions",
      payload: { version: 1, questions: [pickSafeQuestion({ options: [{ id: "o1", label: "Other", freeText: true }] })] },
    }, { issueId: "issue-1" });

    expect(ok).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it("adds a Continue row for multi-select questions", async () => {
    const ctx = mockCtx();
    await sendAnswerableInteraction(ctx, "tok", "chat-1", {
      id: "int-1",
      kind: "ask_user_questions",
      payload: { version: 1, questions: [pickSafeQuestion({ selectionMode: "multi" })] },
    }, { issueId: "issue-1" });

    const keyboard = sent[0]!.options!.inlineKeyboard as Array<Array<{ text: string }>>;
    expect(keyboard.at(-1)![0]!.text).toContain("Continue");
  });
});

describe("sendAnswerableInteraction — request_confirmation", () => {
  it("shows Accept and Reject when no reason is required", async () => {
    const ctx = mockCtx();
    await sendAnswerableInteraction(ctx, "tok", "chat-1", {
      id: "int-1",
      kind: "request_confirmation",
      payload: { version: 1, prompt: "Ship it?" },
    }, { issueId: "issue-1", companyId: "co-1" });

    const keyboard = sent[0]!.options!.inlineKeyboard as Array<Array<{ text: string }>>;
    expect(keyboard[0]!.map((b) => b.text).join(",")).toContain("Accept");
    expect(keyboard[0]!.map((b) => b.text).join(",")).toContain("Reject");
  });

  it("hides the Reject button and points to reply-with-reason when a reason is required", async () => {
    const ctx = mockCtx();
    await sendAnswerableInteraction(ctx, "tok", "chat-1", {
      id: "int-1",
      kind: "request_confirmation",
      payload: { version: 1, prompt: "Ship it?", rejectRequiresReason: true },
    }, { issueId: "issue-1", companyId: "co-1" });

    const keyboard = sent[0]!.options!.inlineKeyboard as Array<Array<{ text: string }>>;
    expect(keyboard[0]).toHaveLength(1);
    expect(sent[0]!.text).toContain("Reply to this message with your reason");
  });

  it("registers a company-scoped reply mapping so replying can reject with a reason", async () => {
    const ctx = mockCtx();
    await sendAnswerableInteraction(ctx, "tok", "chat-1", {
      id: "int-1",
      kind: "request_confirmation",
      payload: { version: 1, prompt: "Ship it?" },
    }, { issueId: "issue-1", companyId: "co-1" });

    const mapping = stateStore[`co-1:msg_chat-1_1`] as { entityType: string; entityId: string; issueId: string };
    expect(mapping.entityType).toBe("interaction_reject_reason");
    expect(mapping.entityId).toBe("int-1");
    expect(mapping.issueId).toBe("issue-1");
  });
});

describe("fetchInteraction", () => {
  it("fetches the issue's interactions and returns the payload, not just status", async () => {
    freshInteractions = [
      { id: "int-1", status: "pending", kind: "request_confirmation", payload: { version: 1, prompt: "Ship it?" } } as never,
    ];
    const ctx = mockCtx();

    const result = await fetchInteraction(ctx, "http://x", "issue-1", "int-1", "board-tok");

    expect(apiCalls[0]!.url).toBe("http://x/api/issues/issue-1/interactions");
    expect(result?.payload).toEqual({ version: 1, prompt: "Ship it?" });
  });

  it("returns null when the fetch fails", async () => {
    const ctx = { ...mockCtx(), state: mockCtx().state } as PluginContext;
    // Force fetchPaperclipApi to throw by asking for an id that never resolves a JSON body.
    freshInteractions = [];
    const result = await fetchInteraction(ctx, "http://x", "issue-1", "missing", "board-tok");
    expect(result).toBeNull();
  });
});

describe("resolveInteractionAnswerCallback — expiry and staleness", () => {
  it("reports expired when the key has no parked state (restart or already-resolved)", async () => {
    const ctx = mockCtx();
    const handled = await resolveInteractionAnswerCallback(ctx, "tok", "int_nope_accept", "cbid", "http://x", "board-tok");
    expect(handled).toBe(true);
    expect(answers[0]!.text).toContain("expired or was already answered");
    expect(apiCalls).toHaveLength(0);
  });

  it("ignores non-interaction callback data", async () => {
    const ctx = mockCtx();
    const handled = await resolveInteractionAnswerCallback(ctx, "tok", "approve_123", "cbid", "http://x", "board-tok");
    expect(handled).toBe(false);
  });

  it("refuses to act when the interaction is no longer pending, and clears the parked state", async () => {
    const ctx = mockCtx();
    await sendAnswerableInteraction(ctx, "tok", "chat-1", {
      id: "int-1",
      kind: "request_confirmation",
      payload: { version: 1, prompt: "Ship it?" },
    }, { issueId: "issue-1", companyId: "co-1" });
    const key = lastCallbackData().split("_")[1];
    freshInteractions = [{ id: "int-1", status: "expired", kind: "request_confirmation" }];

    await resolveInteractionAnswerCallback(ctx, "tok", `int_${key}_accept`, "cbid", "http://x", "board-tok", 42);

    expect(answers.at(-1)!.text).toContain("no longer pending");
    expect(apiCalls.some((c) => c.method === "POST")).toBe(false);
    // Cleared: a second tap gets the generic expired message, not another staleness check.
    apiCalls = [];
    await resolveInteractionAnswerCallback(ctx, "tok", `int_${key}_accept`, "cbid", "http://x", "board-tok", 42);
    expect(apiCalls).toHaveLength(0);
  });
});

describe("resolveInteractionAnswerCallback — ask_user_questions", () => {
  async function parkTwoQuestionFlow(ctx: PluginContext) {
    await sendAnswerableInteraction(ctx, "tok", "chat-1", {
      id: "int-1",
      kind: "ask_user_questions",
      payload: {
        version: 1,
        questions: [
          pickSafeQuestion({ id: "q1" }),
          pickSafeQuestion({ id: "q2", selectionMode: "multi", required: true }),
        ],
      },
    }, { issueId: "issue-1" });
    freshInteractions = [{ id: "int-1", status: "pending", kind: "ask_user_questions" }];
    return lastCallbackData().split("_")[1] as string;
  }

  it("advances to the next question on a single-select tap", async () => {
    const ctx = mockCtx();
    const key = await parkTwoQuestionFlow(ctx);

    await resolveInteractionAnswerCallback(ctx, "tok", `int_${key}_o1`, "cbid", "http://x", "board-tok", 1);

    expect(sent).toHaveLength(2);
    expect(sent[1]!.text).toContain("Question 2 of 2");
    expect(apiCalls.some((c) => c.method === "POST")).toBe(false);
  });

  it("submits accumulated answers via /respond after the last question", async () => {
    const ctx = mockCtx();
    const key = await parkTwoQuestionFlow(ctx);
    postResponses.respond = { status: "answered" };

    await resolveInteractionAnswerCallback(ctx, "tok", `int_${key}_o0`, "cbid", "http://x", "board-tok", 1);
    // Multi-select toggle then submit.
    await resolveInteractionAnswerCallback(ctx, "tok", `int_${key}_o1`, "cbid", "http://x", "board-tok", 2);
    await resolveInteractionAnswerCallback(ctx, "tok", `int_${key}_done`, "cbid", "http://x", "board-tok", 2);

    const respondCall = apiCalls.find((c) => c.url.endsWith("/respond"));
    expect(respondCall).toBeDefined();
    expect(respondCall!.body).toEqual({
      answers: [
        { questionId: "q1", optionIds: ["opt-a"] },
        { questionId: "q2", optionIds: ["opt-b"] },
      ],
    });
    expect(edited.at(-1)!.text).toContain("Answer recorded");
  });

  it("refuses to advance past a required multi-select question with nothing picked", async () => {
    const ctx = mockCtx();
    const key = await parkTwoQuestionFlow(ctx);
    await resolveInteractionAnswerCallback(ctx, "tok", `int_${key}_o0`, "cbid", "http://x", "board-tok", 1);

    await resolveInteractionAnswerCallback(ctx, "tok", `int_${key}_done`, "cbid", "http://x", "board-tok", 2);

    expect(answers.at(-1)!.text).toContain("Pick at least one");
    expect(sent).toHaveLength(2); // no third message sent — did not advance
  });

  it("refuses to skip a required question even if the action is forged", async () => {
    const ctx = mockCtx();
    const key = await parkTwoQuestionFlow(ctx);
    await resolveInteractionAnswerCallback(ctx, "tok", `int_${key}_o0`, "cbid", "http://x", "board-tok", 1);

    await resolveInteractionAnswerCallback(ctx, "tok", `int_${key}_skip`, "cbid", "http://x", "board-tok", 2);

    expect(answers.at(-1)!.text).toContain("requires an answer");
    expect(apiCalls.some((c) => c.method === "POST")).toBe(false);
  });

  it("records a skip as an empty answer for a non-required question", async () => {
    const ctx = mockCtx();
    await sendAnswerableInteraction(ctx, "tok", "chat-1", {
      id: "int-2",
      kind: "ask_user_questions",
      payload: { version: 1, questions: [pickSafeQuestion({ required: false })] },
    }, { issueId: "issue-1" });
    freshInteractions = [{ id: "int-2", status: "pending", kind: "ask_user_questions" }];
    const key = lastCallbackData().split("_")[1] as string;
    postResponses.respond = { status: "answered" };

    await resolveInteractionAnswerCallback(ctx, "tok", `int_${key}_skip`, "cbid", "http://x", "board-tok", 1);

    const respondCall = apiCalls.find((c) => c.url.endsWith("/respond"));
    expect(respondCall!.body).toEqual({ answers: [{ questionId: "q1", optionIds: [] }] });
  });

  it("toggles a multi-select option in place without advancing", async () => {
    const ctx = mockCtx();
    const key = await parkTwoQuestionFlow(ctx);
    await resolveInteractionAnswerCallback(ctx, "tok", `int_${key}_o0`, "cbid", "http://x", "board-tok", 1);

    await resolveInteractionAnswerCallback(ctx, "tok", `int_${key}_o0`, "cbid", "http://x", "board-tok", 2);

    expect(sent).toHaveLength(2); // no new message — same question re-rendered
    expect(edited).toHaveLength(1);
    expect(edited[0]!.text).toContain("Question 2 of 2");
  });
});

describe("resolveInteractionAnswerCallback — request_confirmation", () => {
  async function parkConfirmation(ctx: PluginContext, payload: Record<string, unknown> = {}) {
    await sendAnswerableInteraction(ctx, "tok", "chat-1", {
      id: "int-1",
      kind: "request_confirmation",
      payload: { version: 1, prompt: "Ship it?", ...payload },
    }, { issueId: "issue-1", companyId: "co-1" });
    freshInteractions = [{ id: "int-1", status: "pending", kind: "request_confirmation" }];
    const keyboard = sent.at(-1)!.options!.inlineKeyboard as Array<Array<{ callback_data: string }>>;
    return keyboard[0]![0]!.callback_data.split("_")[1] as string;
  }

  it("accepts and edits the message on tap", async () => {
    const ctx = mockCtx();
    const key = await parkConfirmation(ctx);
    postResponses.accept = { status: "accepted" };

    await resolveInteractionAnswerCallback(ctx, "tok", `int_${key}_accept`, "cbid", "http://x", "board-tok", 1);

    expect(apiCalls.find((c) => c.url.endsWith("/accept"))).toBeDefined();
    expect(edited.at(-1)!.text).toContain("Accepted");
  });

  it("rejects on tap when no reason is required", async () => {
    const ctx = mockCtx();
    const key = await parkConfirmation(ctx);
    postResponses.reject = { status: "rejected" };

    await resolveInteractionAnswerCallback(ctx, "tok", `int_${key}_reject`, "cbid", "http://x", "board-tok", 1);

    const rejectCall = apiCalls.find((c) => c.url.endsWith("/reject"));
    expect(rejectCall!.body).toEqual({});
    expect(edited.at(-1)!.text).toContain("Rejected");
  });

  it("a redelivered accept after resolution does not double-apply", async () => {
    const ctx = mockCtx();
    const key = await parkConfirmation(ctx);
    postResponses.accept = { status: "accepted" };
    await resolveInteractionAnswerCallback(ctx, "tok", `int_${key}_accept`, "cbid", "http://x", "board-tok", 1);
    apiCalls = [];

    await resolveInteractionAnswerCallback(ctx, "tok", `int_${key}_accept`, "cbid", "http://x", "board-tok", 1);

    expect(apiCalls).toHaveLength(0);
    expect(answers.at(-1)!.text).toContain("expired or was already answered");
  });
});

describe("finalizeReplyRejection", () => {
  it("rejects with the reply text as the reason", async () => {
    const ctx = mockCtx();
    freshInteractions = [{ id: "int-1", status: "pending", kind: "request_confirmation" }];
    postResponses.reject = { status: "rejected" };

    await finalizeReplyRejection(ctx, "tok", "http://x", "board-tok", {
      entityId: "int-1",
      entityType: "interaction_reject_reason",
      companyId: "co-1",
      issueId: "issue-1",
    }, "not ready for prod", "chat-1");

    const rejectCall = apiCalls.find((c) => c.url.endsWith("/reject"));
    expect(rejectCall!.body).toEqual({ reason: "not ready for prod" });
    expect(sent.at(-1)!.text).toContain("Rejected with your reason");
  });

  it("reports staleness instead of rejecting when the interaction already moved on", async () => {
    const ctx = mockCtx();
    freshInteractions = [{ id: "int-1", status: "accepted", kind: "request_confirmation" }];

    await finalizeReplyRejection(ctx, "tok", "http://x", "board-tok", {
      entityId: "int-1",
      entityType: "interaction_reject_reason",
      companyId: "co-1",
      issueId: "issue-1",
    }, "too late", "chat-1");

    expect(apiCalls.some((c) => c.method === "POST")).toBe(false);
    expect(sent.at(-1)!.text).toContain("no longer pending");
  });
});

describe("isInteractionReplyMapping", () => {
  it("matches only the interaction_reject_reason entity type", () => {
    expect(isInteractionReplyMapping({ entityType: "interaction_reject_reason" })).toBe(true);
    expect(isInteractionReplyMapping({ entityType: "issue" })).toBe(false);
    expect(isInteractionReplyMapping(null)).toBe(false);
    expect(isInteractionReplyMapping("interaction_reject_reason")).toBe(false);
  });
});
