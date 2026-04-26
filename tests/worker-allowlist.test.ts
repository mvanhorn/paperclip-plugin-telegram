import { describe, expect, it } from "vitest";
import { isTelegramUpdateAllowed, validateTelegramAllowlists } from "../src/allowlist.js";

const baseConfig = {
  allowedTelegramUserIds: [],
  allowedTelegramChatIds: [],
};

describe("isTelegramUpdateAllowed", () => {
  it("allows all updates when allowlists are empty", () => {
    expect(isTelegramUpdateAllowed(baseConfig, {
      update_id: 1,
      message: {
        message_id: 10,
        from: { id: 123 },
        chat: { id: 456, type: "private" },
        text: "/status",
      },
    })).toBe(true);
  });

  it("blocks messages from users outside the user allowlist", () => {
    expect(isTelegramUpdateAllowed({
      allowedTelegramUserIds: ["123"],
      allowedTelegramChatIds: [],
    }, {
      update_id: 1,
      message: {
        message_id: 10,
        from: { id: 999 },
        chat: { id: 456, type: "private" },
        text: "/status",
      },
    })).toBe(false);
  });

  it("allows messages from users inside the user allowlist", () => {
    expect(isTelegramUpdateAllowed({
      allowedTelegramUserIds: ["123"],
      allowedTelegramChatIds: [],
    }, {
      update_id: 1,
      message: {
        message_id: 10,
        from: { id: 123 },
        chat: { id: 456, type: "private" },
        text: "/status",
      },
    })).toBe(true);
  });

  it("blocks messages from chats outside the chat allowlist", () => {
    expect(isTelegramUpdateAllowed({
      allowedTelegramUserIds: [],
      allowedTelegramChatIds: ["-1001"],
    }, {
      update_id: 1,
      message: {
        message_id: 10,
        from: { id: 123 },
        chat: { id: -2002, type: "supergroup" },
        text: "/status",
      },
    })).toBe(false);
  });

  it("requires both user and chat to match when both allowlists are configured", () => {
    expect(isTelegramUpdateAllowed({
      allowedTelegramUserIds: ["123"],
      allowedTelegramChatIds: ["-1001"],
    }, {
      update_id: 1,
      message: {
        message_id: 10,
        from: { id: 123 },
        chat: { id: -2002, type: "supergroup" },
        text: "/status",
      },
    })).toBe(false);
  });

  it("applies the user allowlist to inline button callbacks", () => {
    expect(isTelegramUpdateAllowed({
      allowedTelegramUserIds: ["123"],
      allowedTelegramChatIds: [],
    }, {
      update_id: 1,
      callback_query: {
        id: "cb-1",
        from: { id: 999 },
        message: {
          message_id: 10,
          chat: { id: -1001 },
          text: "Approval",
        },
        data: "approve_apr-1",
      },
    })).toBe(false);
  });

  it("applies the chat allowlist to inline button callbacks", () => {
    expect(isTelegramUpdateAllowed({
      allowedTelegramUserIds: [],
      allowedTelegramChatIds: ["-1001"],
    }, {
      update_id: 1,
      callback_query: {
        id: "cb-1",
        from: { id: 123 },
        message: {
          message_id: 10,
          chat: { id: -1001 },
          text: "Approval",
        },
        data: "approve_apr-1",
      },
    })).toBe(true);
  });
});

describe("validateTelegramAllowlists", () => {
  it("accepts missing or array allowlists", () => {
    expect(validateTelegramAllowlists({})).toEqual([]);
    expect(validateTelegramAllowlists({
      allowedTelegramUserIds: ["123"],
      allowedTelegramChatIds: ["-1001"],
    })).toEqual([]);
  });

  it("rejects non-array allowlist values", () => {
    expect(validateTelegramAllowlists({
      allowedTelegramUserIds: "123",
      allowedTelegramChatIds: "-1001",
    })).toEqual([
      "allowedTelegramUserIds must be an array of Telegram ID strings. Leave it empty to allow any user.",
      "allowedTelegramChatIds must be an array of Telegram ID strings. Leave it empty to allow any chat.",
    ]);
  });
});
