import type { PluginContext } from "@paperclipai/plugin-sdk";

// The one place this plugin emits a host event.
//
// `ctx.events.emit` is a host RPC, so it can fail for reasons that have
// nothing to do with the caller: the transport is down, the host rejects
// the call, the plugin lost its permission. None of the 13 call sites can
// do anything useful about that, and every one of them sits somewhere a
// throw would do real damage:
//
//   - Inside `handleUpdate`'s call graph. A throw escaping `handleUpdate`
//     is caught by the offset guard in polling-offset.ts, which then
//     declines to advance the offset — so Telegram redelivers the same
//     update forever and the poller wedges for every chat. The throw is
//     caught; the wedge is the offset never moving. (Same reasoning as
//     `resolveCompanyIdOrNull` in worker.ts.)
//   - Inside `EscalationManager.checkTimeouts`, which loops over pending
//     escalation ids. A throw aborts the remaining escalations in that
//     tick, not just the one that failed.
//   - Inside an `ctx.events.on(...)` subscriber, where a throw is the
//     host's problem to report and this plugin's to have avoided.
//
// So: emit, await it, and turn any failure into a log line. A caller that
// needs to know whether the event landed reads the boolean; the ones that
// cannot act on the answer ignore it.
//
// `try`/`catch` rather than `.catch(...)` deliberately. A `.catch()` is
// only attached to a promise that was actually returned — if the host's
// RPC proxy throws synchronously (permission denied, uninitialized
// transport) there is no promise to attach it to, and the throw escapes
// past exactly the guard that exists to stop it.

/**
 * Ids identifying what an emit was about, included in the failure log.
 * `sessionId`/`chatId`/`threadId` travel together at every ACP call site;
 * escalation sites add `escalationId`.
 */
export type EmitLogIds = {
  sessionId?: string;
  chatId?: string;
  threadId?: number;
  escalationId?: string;
};

/**
 * Emit a host event, logging and swallowing any failure.
 *
 * Never throws — that is the entire point of the module. Returns nothing:
 * no call site can act on whether the event landed, and inventing a
 * result nobody reads would just be a second thing to keep correct.
 *
 * @param site Short description of the call site ("escalation reply"),
 *   logged as a field so one log message serves all call sites.
 */
export async function emitOrLog(
  ctx: PluginContext,
  event: string,
  companyId: string,
  payload: Record<string, unknown>,
  site: string,
  ids: EmitLogIds = {},
): Promise<void> {
  try {
    await ctx.events.emit(event, companyId, payload);
  } catch (err) {
    ctx.logger.error("Failed to emit host event", {
      event,
      // The payload discriminator, as a field rather than baked into the
      // message — one event name with three `type`s is still one event.
      type: typeof payload.type === "string" ? payload.type : undefined,
      site,
      companyId,
      ...ids,
      error: String(err),
    });
  }
}
