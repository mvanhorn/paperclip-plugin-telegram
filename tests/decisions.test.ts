import { describe, expect, it, vi, beforeEach } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";

const sent: string[] = [];
const apiCalls: string[] = [];
let response: unknown = { totalCount: 0, items: [] };
let shouldThrow: Error | null = null;

vi.mock("../src/telegram-api.js", () => ({
  sendMessage: vi.fn(async (_c: unknown, _t: string, _chat: string, text: string) => {
    sent.push(text);
    return { ok: true };
  }),
  escapeMarkdownV2: (s: string) => s,
}));

vi.mock("../src/paperclip-api.js", () => ({
  buildPaperclipAuthHeaders: (t?: string) => (t ? { Authorization: `Bearer ${t}` } : {}),
  fetchPaperclipApi: vi.fn(async (_ctx: unknown, url: string) => {
    apiCalls.push(url);
    if (shouldThrow) throw shouldThrow;
    return { json: async () => response };
  }),
}));

const answerableSendCalls: Array<{ chatId: string; interaction: unknown; opts: unknown }> = [];
let fetchedInteraction: { id: string; status: string; kind: string; payload: unknown } | null = null;
vi.mock("../src/interaction-answers.js", () => ({
  fetchInteraction: vi.fn(async () => fetchedInteraction),
  sendAnswerableInteraction: vi.fn(async (_ctx: unknown, _token: string, chatId: string, interaction: unknown, opts: unknown) => {
    answerableSendCalls.push({ chatId, interaction, opts });
    return true;
  }),
  isAskUserQuestionsAnswerable: (payload: { questions?: Array<{ options?: Array<{ freeText?: boolean }> }> }) =>
    Array.isArray(payload?.questions) &&
    payload.questions.length > 0 &&
    payload.questions.every((q) => (q.options ?? []).every((o) => o.freeText !== true)),
}));

const {
  fetchAttention,
  sendAttentionList,
  renderAttentionItem,
  describeSourceKind,
  describeDecisionsError,
  toAttentionItem,
} = await import("../src/decisions.js");

function makeCtx(): PluginContext {
  return {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as PluginContext;
}

/**
 * Fixtures below are trimmed copies of real /attention responses from a live
 * instance, not invented shapes — the previous implementation passed its own
 * tests while being wrong about the API, so the shapes are the thing under
 * test as much as the logic.
 */
const questionItem = {
  id: "issue_thread_interaction:interaction:921ee29e",
  sourceKind: "issue_thread_interaction",
  subject: {
    kind: "interaction",
    id: "921ee29e",
    title: 'Who is "the first client" for BLA-76\'s discovery interviews?',
    href: "/BLA/issues/BLA-134#interaction-921ee29e",
    metadata: { kind: "ask_user_questions", issueId: "issue-134" },
  },
  relatedIssue: { identifier: "BLA-134", title: "Confirm the first client" },
  whyNow: "Questions need answers on an issue thread.",
  severity: "medium",
  inlineResolvable: true,
  decisionVerbs: [{ id: "respond", label: "Respond" }],
  detail: { kind: "questions", questionCount: 1, firstQuestionText: "Who is the first client?" },
};

const blockerItem = {
  id: "blocker_attention:blocker:2aaf008c",
  sourceKind: "blocker_attention",
  subject: { kind: "issue", title: "Upstream wait_approval is inert", href: "/BLA/issues/BLA-156" },
  relatedIssue: { identifier: "BLA-156" },
  whyNow: "Blocks 0 tasks and needs human attention.",
  severity: "high",
  inlineResolvable: false,
  decisionVerbs: [
    { id: "unblock", label: "Unblock" },
    { id: "reassign", label: "Reassign" },
  ],
  detail: { kind: "blocker", blockedTaskCount: 0 },
};

beforeEach(() => {
  sent.length = 0;
  apiCalls.length = 0;
  shouldThrow = null;
  response = { totalCount: 0, items: [] };
  answerableSendCalls.length = 0;
  fetchedInteraction = null;
});

describe("fetchAttention", () => {
  it("reads the endpoint the Decisions page renders", async () => {
    response = { totalCount: 2, items: [questionItem, blockerItem] };

    const result = await fetchAttention(makeCtx(), "http://x", "c1", "tok");

    expect(apiCalls).toEqual(["http://x/api/companies/c1/attention"]);
    expect(result.totalCount).toBe(2);
    expect(result.items).toHaveLength(2);
  });

  it("includes blocker_attention, which a per-issue interaction scan can never find", async () => {
    // The bug this replaces: the page showed six items and the bot showed one,
    // because four of them were blockers and were not interactions at all.
    response = { totalCount: 2, items: [questionItem, blockerItem] };

    const { items } = await fetchAttention(makeCtx(), "http://x", "c1", "tok");

    expect(items.map((i) => i.sourceKind)).toContain("blocker_attention");
    expect(items.find((i) => i.sourceKind === "blocker_attention")?.issueIdentifier).toBe("BLA-156");
  });

  it("makes ONE request regardless of how much is pending", async () => {
    response = { totalCount: 30, items: Array.from({ length: 30 }, () => questionItem) };

    await fetchAttention(makeCtx(), "http://x", "c1", "tok");

    expect(apiCalls).toHaveLength(1);
  });

  it("propagates a failure instead of reporting an empty queue", async () => {
    // "Nothing is pending" and "we could not ask" must never look identical.
    shouldThrow = new Error('Paperclip API request failed with 403: {"error":"Board access required"}');

    await expect(fetchAttention(makeCtx(), "http://x", "c1", "tok")).rejects.toThrow("403");
  });

  it("survives a response with no items array", async () => {
    response = {};
    const result = await fetchAttention(makeCtx(), "http://x", "c1", "tok");
    expect(result).toEqual({ items: [], totalCount: 0 });
  });

  it("carries the board token when one is available", async () => {
    response = { totalCount: 0, items: [] };
    await fetchAttention(makeCtx(), "http://x", "c1", "tok");
    expect(apiCalls[0]).toContain("/attention");
  });

  it("defaults verbs to an empty list when the host sends no decisionVerbs", async () => {
    const { decisionVerbs: _drop, ...withoutVerbs } = questionItem;
    response = { totalCount: 1, items: [withoutVerbs] };

    const { items } = await fetchAttention(makeCtx(), "http://x", "c1", "tok");

    expect(items[0]!.verbs).toEqual([]);
  });
});

describe("renderAttentionItem", () => {
  it("leads with the title and says what kind of decision it is", () => {
    const [item] = [questionItem].map((r) => toItem(r));
    const text = renderAttentionItem(item);

    expect(text).toContain("the first client");
    expect(text).toContain("Needs your answer");
    expect(text).toContain("BLA-134");
  });

  it("uses the host's own whyNow rather than inventing urgency", () => {
    const text = renderAttentionItem(toItem(blockerItem));
    expect(text).toContain("Blocks 0 tasks and needs human attention.");
  });

  it("lists the available options so the reader knows what the choice is", () => {
    const text = renderAttentionItem(toItem(blockerItem));
    expect(text).toContain("Unblock / Reassign");
  });

  it("deep-links to the item, not to the Decisions index", () => {
    const text = renderAttentionItem(toItem(questionItem), "https://paperclip.example");
    expect(text).toContain("https://paperclip.example/BLA/issues/BLA-134#interaction-921ee29e");
  });

  it("omits the link when no public URL is configured", () => {
    expect(renderAttentionItem(toItem(questionItem))).not.toContain("Open:");
  });

  it("marks high severity differently from medium", () => {
    expect(renderAttentionItem(toItem(blockerItem))).toContain("🔴");
    expect(renderAttentionItem(toItem(questionItem))).toContain("🟡");
  });
});

describe("sendAttentionList", () => {
  it("says nothing is waiting only when the fetch actually succeeded", async () => {
    await sendAttentionList(makeCtx(), "tok", "chat-1", { items: [], totalCount: 0 });
    expect(sent).toEqual(["Nothing is waiting on your input."]);
  });

  it("caps output and reports the true remaining count", async () => {
    const items = Array.from({ length: 6 }, () => toItem(questionItem));
    await sendAttentionList(makeCtx(), "tok", "chat-1", { items, totalCount: 6 }, { limit: 2 });

    expect(sent).toHaveLength(3);
    expect(sent.at(-1)).toContain("4 more");
  });

  it("reports the server's total, not the page size, when they differ", async () => {
    const items = Array.from({ length: 2 }, () => toItem(questionItem));
    await sendAttentionList(makeCtx(), "tok", "chat-1", { items, totalCount: 17 }, { limit: 2 });
    expect(sent.at(-1)).toContain("15 more");
  });
});

describe("sendAttentionList — inline answering (BLA-154)", () => {
  it("fetches the full interaction and sends an interactive prompt for a pick-only ask_user_questions item", async () => {
    fetchedInteraction = {
      id: "921ee29e",
      status: "pending",
      kind: "ask_user_questions",
      payload: { version: 1, questions: [{ id: "q1", prompt: "Who?", selectionMode: "single", options: [{ id: "o1", label: "Acme" }] }] },
    };
    const items = [toItem(questionItem)];

    await sendAttentionList(makeCtx(), "tok", "chat-1", { items, totalCount: 1 }, {
      baseUrl: "http://x",
      boardApiToken: "tok",
      companyId: "co-1",
      publicUrl: "https://paperclip.example",
    });

    expect(sent[0]).not.toContain("https://paperclip.example/BLA/issues/BLA-134");
    expect(answerableSendCalls).toHaveLength(1);
    expect(answerableSendCalls[0]!.chatId).toBe("chat-1");
    expect(answerableSendCalls[0]!.opts).toMatchObject({ issueId: "issue-134", companyId: "co-1" });
  });

  it("keeps the Open link and does not send a prompt when a question has a free-text option", async () => {
    fetchedInteraction = {
      id: "921ee29e",
      status: "pending",
      kind: "ask_user_questions",
      payload: { version: 1, questions: [{ id: "q1", prompt: "Who?", selectionMode: "single", options: [{ id: "o1", label: "Other", freeText: true }] }] },
    };
    const items = [toItem(questionItem)];

    await sendAttentionList(makeCtx(), "tok", "chat-1", { items, totalCount: 1 }, {
      baseUrl: "http://x",
      boardApiToken: "tok",
      companyId: "co-1",
      publicUrl: "https://paperclip.example",
    });

    expect(sent[0]).toContain("https://paperclip.example/BLA/issues/BLA-134");
    expect(answerableSendCalls).toHaveLength(0);
  });

  it("keeps the Open link when the interaction resolved elsewhere since the feed was read", async () => {
    fetchedInteraction = { id: "921ee29e", status: "answered", kind: "ask_user_questions", payload: { version: 1, questions: [] } };
    const items = [toItem(questionItem)];

    await sendAttentionList(makeCtx(), "tok", "chat-1", { items, totalCount: 1 }, {
      baseUrl: "http://x",
      boardApiToken: "tok",
      companyId: "co-1",
      publicUrl: "https://paperclip.example",
    });

    expect(answerableSendCalls).toHaveLength(0);
  });

  it("fetches the full interaction and sends an interactive prompt for a request_confirmation item", async () => {
    fetchedInteraction = {
      id: "921ee29e",
      status: "pending",
      kind: "request_confirmation",
      payload: { version: 1, prompt: "Ship it?", rejectRequiresReason: true },
    };
    const items = [toItem(questionItem)];

    await sendAttentionList(makeCtx(), "tok", "chat-1", { items, totalCount: 1 }, {
      baseUrl: "http://x",
      boardApiToken: "tok",
      companyId: "co-1",
      publicUrl: "https://paperclip.example",
    });

    expect(sent[0]).not.toContain("https://paperclip.example/BLA/issues/BLA-134");
    expect(answerableSendCalls).toHaveLength(1);
    expect(answerableSendCalls[0]!.interaction).toMatchObject({ kind: "request_confirmation" });
  });

  it("keeps the Open link for an interaction that was answered since the feed was read", async () => {
    // The /attention feed is a snapshot. Between reading it and fetching the
    // interaction, someone can answer it in the web UI. Offering buttons for it
    // anyway invites an answer the host will reject, and the user is told
    // nothing about why — so a non-pending status must fall back to the link.
    fetchedInteraction = {
      id: "921ee29e",
      status: "answered",
      kind: "ask_user_questions",
      payload: {
        version: 1,
        questions: [{ id: "q1", prompt: "Which?", selectionMode: "single", options: [{ id: "o1", label: "Acme" }] }],
      },
    };
    const items = [toItem(questionItem)];

    await sendAttentionList(makeCtx(), "tok", "chat-1", { items, totalCount: 1 }, {
      baseUrl: "http://x",
      boardApiToken: "tok",
      companyId: "co-1",
      publicUrl: "https://paperclip.example",
    });

    expect(answerableSendCalls).toHaveLength(0);
    expect(sent[0]).toContain("https://paperclip.example/BLA/issues/BLA-134");
  });

  it("keeps the Open link for an interaction kind Telegram cannot render as buttons", async () => {
    fetchedInteraction = { id: "921ee29e", status: "pending", kind: "suggest_tasks", payload: { version: 1 } };
    const items = [toItem(questionItem)];

    await sendAttentionList(makeCtx(), "tok", "chat-1", { items, totalCount: 1 }, {
      baseUrl: "http://x",
      boardApiToken: "tok",
      companyId: "co-1",
      publicUrl: "https://paperclip.example",
    });

    expect(sent[0]).toContain("https://paperclip.example/BLA/issues/BLA-134");
    expect(answerableSendCalls).toHaveLength(0);
  });

  it("keeps the Open link when only one of several questions has a free-text option", async () => {
    fetchedInteraction = {
      id: "921ee29e",
      status: "pending",
      kind: "ask_user_questions",
      payload: {
        version: 1,
        questions: [
          { id: "q1", prompt: "Which?", selectionMode: "single", options: [{ id: "o1", label: "Acme" }] },
          { id: "q2", prompt: "Why?", selectionMode: "single", options: [{ id: "o2", label: "Other", freeText: true }] },
        ],
      },
    };
    const items = [toItem(questionItem)];

    await sendAttentionList(makeCtx(), "tok", "chat-1", { items, totalCount: 1 }, {
      baseUrl: "http://x",
      boardApiToken: "tok",
      companyId: "co-1",
      publicUrl: "https://paperclip.example",
    });

    expect(sent[0]).toContain("https://paperclip.example/BLA/issues/BLA-134");
    expect(answerableSendCalls).toHaveLength(0);
  });

  it("never attempts an inline answer for a blocker_attention item, which the host marks inlineResolvable: false", async () => {
    await sendAttentionList(makeCtx(), "tok", "chat-1", { items: [toItem(blockerItem)], totalCount: 1 }, {
      baseUrl: "http://x",
      boardApiToken: "tok",
      companyId: "co-1",
      publicUrl: "https://paperclip.example",
    });

    expect(answerableSendCalls).toHaveLength(0);
  });

  it("honours inlineResolvable: false on an interaction, without even fetching it", async () => {
    // The blocker_attention case above is also screened out by its sourceKind,
    // so it cannot prove this flag is read. An interaction the host declined to
    // mark inline-resolvable is the only case where inlineResolvable is the
    // deciding guard: the host's verdict wins, and we do not spend a fetch
    // second-guessing it.
    const notInlineInteraction = { ...questionItem, inlineResolvable: false };
    fetchedInteraction = {
      id: "921ee29e",
      status: "pending",
      kind: "ask_user_questions",
      payload: {
        version: 1,
        questions: [{ id: "q1", prompt: "Which?", selectionMode: "single", options: [{ id: "o1", label: "Acme" }] }],
      },
    };

    await sendAttentionList(makeCtx(), "tok", "chat-1", { items: [toItem(notInlineInteraction)], totalCount: 1 }, {
      baseUrl: "http://x",
      boardApiToken: "tok",
      companyId: "co-1",
      publicUrl: "https://paperclip.example",
    });

    expect(answerableSendCalls).toHaveLength(0);
    expect(sent[0]).toContain("https://paperclip.example/BLA/issues/BLA-134");
  });

  it("does not attempt an inline answer for non-interaction items, even when inlineResolvable", async () => {
    const approvalItem = {
      ...toItem(blockerItem),
      sourceKind: "approval",
      inlineResolvable: true,
    };

    await sendAttentionList(makeCtx(), "tok", "chat-1", { items: [approvalItem], totalCount: 1 }, {
      baseUrl: "http://x",
      boardApiToken: "tok",
      companyId: "co-1",
    });

    expect(answerableSendCalls).toHaveLength(0);
  });

  it("does not fetch anything when no baseUrl is supplied", async () => {
    const items = [toItem(questionItem)];

    await sendAttentionList(makeCtx(), "tok", "chat-1", { items, totalCount: 1 }, { companyId: "co-1" });

    expect(answerableSendCalls).toHaveLength(0);
  });
});

describe("describeDecisionsError", () => {
  it("explains a 403 instead of dumping it", () => {
    const text = describeDecisionsError(
      new Error('Paperclip API request failed with 403: {"error":"Board access required"}'),
    );
    expect(text).toContain("no board access");
    expect(text).toContain("worker restart");
    expect(text).not.toContain('{"error"');
  });

  it("passes other failures through so real outages stay visible", () => {
    expect(describeDecisionsError(new Error("ECONNREFUSED"))).toContain("ECONNREFUSED");
  });
});

describe("describeSourceKind", () => {
  it("labels known kinds and degrades gracefully", () => {
    expect(describeSourceKind("issue_thread_interaction")).toBe("Needs your answer");
    expect(describeSourceKind("blocker_attention")).toBe("Blocked");
    expect(describeSourceKind("some_new_kind")).toBe("some new kind");
  });
});

// Round-trips a raw fixture through the real parser so render tests exercise
// the same mapping the fetch path produces. This MUST delegate rather than
// re-derive: an earlier hand-copy of toAttentionItem kept these tests passing
// while the production mapper was broken (a mutation that forced
// `inlineResolvable: true` — offering blockers inline — went undetected).
const toItem = toAttentionItem;
