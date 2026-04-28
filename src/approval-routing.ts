import type { PluginEvent } from "@paperclipai/plugin-sdk";

export function shouldNotifyApproval(event: PluginEvent, onlyBoardApprovals: boolean): boolean {
  if (!onlyBoardApprovals) return true;
  const payload = event.payload as Record<string, unknown>;
  return payload.type === "request_board_approval";
}
