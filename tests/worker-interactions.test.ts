import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";

vi.mock("@paperclipai/plugin-sdk", async () => {
  const actual = (await vi.importActual("@paperclipai/plugin-sdk")) as Record<string, unknown>;
  return { ...actual, runWorker: vi.fn() };
});

const answered: string[] = [];
const edited: Array<{ chatId: string; messageId: number; text: string }> = [];
const sent: Array<{ chatId: string; text: string }> = [];

vi.mock("../src/telegram-api.js", async () => {
  const actual = (await vi.importActual("../src/telegram-api.js")) as Record<string, unknown>;
  return {
    ...actual,
    sendMessage: vi.fn(async (_c: unknown, _t: string, chatId: string, text: string) => {
      sent.push({ chatId, text });
      return 999;
    }),
    editMessage: vi.fn(async (_c: unknown, _t: string, chatId: string, messageId: number, text: string) => {
      edited.push({ chatId, messageId, text });
      return true;
    }),
    answerCallbackQuery: vi.fn(async (_c: unknown, _t: string, _id: string, text: string) => {
      answered.push(text ?? "");
      return true;
    }),
  };
});

import { handleUpdate } from "../src/worker.js";

const UUID = "6f8f1c7e-2b4a-4c1d-9e3a-1f2b3c4d5e6f";
const CHAT_ID = 123456;
const CARD_MSG_ID = 55;
const ISSUE_ID = "issue-abc";
const COMPANY_ID = "company-xyz";

function mockCtx(respondInteraction = vi.fn().mockResolvedValue({ applied: true })): PluginContext {
  return {
    http: { fetch: vi.fn().mockResolvedValue({ json: () => Promise.resolve({ ok: true }) }) },
    metrics: { write: vi.fn().mockResolvedValue(undefined) },
    activity: { log: vi.fn().mockResolvedValue(undefined) },
    secrets: { resolve: vi.fn().mockResolvedValue(undefined) },
    state: {
      get: vi.fn(async (scope: { stateKey?: string }) => {
        if (scope?.stateKey === `msg_${CHAT_ID}_${CARD_MSG_ID}`) {
          return {
            entityId: ISSUE_ID,
            entityType: "issue_interaction",
            companyId: COMPANY_ID,
            interactionId: UUID,
            rejectRequiresReason: false,
          };
        }
        return null;
      }),
      set: vi.fn().mockResolvedValue(undefined),
    },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    issues: { respondInteraction },
  } as unknown as PluginContext;
}

function baseConfig(overrides: Record<string, unknown> = {}) {
  return {
    enableCommands: true,
    enableInbound: true,
    allowedTelegramUserIds: [],
    allowedTelegramChatIds: [],
    issueInteractionActorUserId: "actor-user-1",
    ...overrides,
  } as Parameters<typeof handleUpdate>[2];
}

function acceptCallback() {
  return {
    update_id: 1,
    callback_query: {
      id: "cq-1",
      from: { id: 97397474, username: "owner" },
      message: { message_id: CARD_MSG_ID, chat: { id: CHAT_ID } },
      data: `int_accept_${UUID}`,
    },
  } as Parameters<typeof handleUpdate>[3];
}

beforeEach(() => {
  answered.length = 0;
  edited.length = 0;
  sent.length = 0;
});

describe("decision-card callback", () => {
  it("resolves an accept via respondInteraction on behalf of the configured actor", async () => {
    const respond = vi.fn().mockResolvedValue({ applied: true });
    const ctx = mockCtx(respond);

    await handleUpdate(ctx, "token", baseConfig(), acceptCallback(), "http://localhost:3100");

    expect(respond).toHaveBeenCalledWith(
      ISSUE_ID,
      UUID,
      { action: "accept", actorUserId: "actor-user-1", reason: null },
      COMPANY_ID,
    );
    expect(edited.some((e) => e.text.includes("Approved"))).toBe(true);
    expect(answered).toContain("Approved");
  });

  it("refuses to act when no decision actor is configured (never guesses identity)", async () => {
    const respond = vi.fn();
    const ctx = mockCtx(respond);

    await handleUpdate(
      ctx,
      "token",
      baseConfig({ issueInteractionActorUserId: "" }),
      acceptCallback(),
      "http://localhost:3100",
    );

    expect(respond).not.toHaveBeenCalled();
    expect(answered.some((a) => a.includes("No board user"))).toBe(true);
  });

  it("ignores a callback whose stored interaction id no longer matches", async () => {
    const respond = vi.fn();
    const ctx = mockCtx(respond);
    const stale = acceptCallback();
    stale.callback_query!.data = "int_accept_different-id";

    await handleUpdate(ctx, "token", baseConfig(), stale, "http://localhost:3100");

    expect(respond).not.toHaveBeenCalled();
    expect(answered.some((a) => a.includes("no longer available"))).toBe(true);
  });
});
