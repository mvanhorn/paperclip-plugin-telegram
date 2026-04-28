import { describe, expect, it } from "vitest";
import type { PluginEvent } from "@paperclipai/plugin-sdk";
import { shouldNotifyApproval } from "../src/approval-routing.js";

function approvalEvent(type: string): PluginEvent {
  return {
    companyId: "company-1",
    entityId: "approval-1",
    entityType: "approval",
    eventType: "approval.created",
    payload: { type },
  } as PluginEvent;
}

describe("shouldNotifyApproval", () => {
  it("notifies all approval types when board-only mode is disabled", () => {
    expect(shouldNotifyApproval(approvalEvent("approve_ceo_strategy"), false)).toBe(true);
    expect(shouldNotifyApproval(approvalEvent("request_board_approval"), false)).toBe(true);
  });

  it("notifies only request_board_approval approvals in board-only mode", () => {
    expect(shouldNotifyApproval(approvalEvent("approve_ceo_strategy"), true)).toBe(false);
    expect(shouldNotifyApproval(approvalEvent("budget_override_required"), true)).toBe(false);
    expect(shouldNotifyApproval(approvalEvent("request_board_approval"), true)).toBe(true);
  });
});
