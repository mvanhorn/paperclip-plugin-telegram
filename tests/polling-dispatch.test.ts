import { describe, expect, it } from "vitest";
import {
  getTelegramUpdateChatId,
  selectTelegramRuntimeForUpdate,
  telegramRuntimeChatIds,
} from "../src/polling-dispatch.js";

const pacoRuntime = {
  companyId: "paco",
  config: {
    defaultChatId: "-1003800613668",
    allowedTelegramChatIds: ["-1003800613668"],
    errorsChatId: "-1003800613668",
  },
};

const superpowersRuntime = {
  companyId: "superpowers",
  config: {
    defaultChatId: "-1004295856824",
    allowedTelegramChatIds: ["-1004295856824"],
    digestChatId: "-1004295856824",
  },
};

describe("Telegram polling dispatch", () => {
  it("extracts message and callback chat ids", () => {
    expect(getTelegramUpdateChatId({
      message: { chat: { id: -1004295856824 } },
    })).toBe("-1004295856824");

    expect(getTelegramUpdateChatId({
      callback_query: {
        message: { chat: { id: -1003800613668 } },
      },
    })).toBe("-1003800613668");
  });

  it("collects all configured chat ids for a runtime", () => {
    expect([...telegramRuntimeChatIds({
      defaultChatId: "-1001",
      approvalsChatId: "-1002",
      errorsChatId: "-1003",
      digestChatId: "-1004",
      escalationChatId: "-1005",
      allowedTelegramChatIds: ["-1006"],
      briefAgentChatIds: ["-1007"],
    })].sort()).toEqual([
      "-1001",
      "-1002",
      "-1003",
      "-1004",
      "-1005",
      "-1006",
      "-1007",
    ]);
  });

  it("selects the matching company runtime before allowlist handling", () => {
    const runtime = selectTelegramRuntimeForUpdate(
      [pacoRuntime, superpowersRuntime],
      {
        update_id: 77604974,
        message: { chat: { id: -1004295856824 } },
      },
    );

    expect(runtime?.companyId).toBe("superpowers");
  });

  it("does not route an unmatched chat when multiple companies share one bot token", () => {
    const runtime = selectTelegramRuntimeForUpdate(
      [pacoRuntime, superpowersRuntime],
      {
        update_id: 77604975,
        message: { chat: { id: -1009999999999 } },
      },
    );

    expect(runtime).toBeNull();
  });

  it("keeps single-company fallback behavior for legacy configs with sparse chat metadata", () => {
    const runtime = selectTelegramRuntimeForUpdate(
      [pacoRuntime],
      {
        update_id: 77604976,
        message: { chat: { id: -1009999999999 } },
      },
    );

    expect(runtime?.companyId).toBe("paco");
  });
});
