import { describe, it, expect, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { emitOrLog } from "../src/events.js";

function mockCtx(emit: ReturnType<typeof vi.fn>) {
  return {
    events: { emit },
    logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  } as unknown as PluginContext;
}

describe("emitOrLog", () => {
  it("emits with companyId as the second argument and reports success", async () => {
    const emit = vi.fn().mockResolvedValue(undefined);
    const ctx = mockCtx(emit);

    await expect(emitOrLog(ctx, "acp-spawn", "company-1", { type: "spawn" }, "session spawn")).resolves.toBeUndefined();

    expect(emit).toHaveBeenCalledWith("acp-spawn", "company-1", { type: "spawn" });
    expect(ctx.logger.error).not.toHaveBeenCalled();
  });

  it("logs and swallows a rejected emit", async () => {
    const emit = vi.fn().mockRejectedValue(new Error("host RPC unavailable"));
    const ctx = mockCtx(emit);

    await expect(emitOrLog(ctx, "acp-spawn", "company-1", { type: "message" }, "routed message")).resolves.toBeUndefined();

    expect(ctx.logger.error).toHaveBeenCalledWith(
      "Failed to emit host event",
      expect.objectContaining({
        event: "acp-spawn",
        type: "message",
        site: "routed message",
        companyId: "company-1",
        error: expect.stringContaining("host RPC unavailable"),
      }),
    );
  });

  // The reason this module uses try/catch rather than `.catch(...)`. A
  // `.catch()` is only attached to a promise that was actually returned; a
  // host RPC proxy that throws synchronously (permission denied,
  // uninitialized transport) never returns one, so the throw escapes past
  // the guard that exists to stop it. Every one of the emit call sites
  // routes through here, so this one test covers all of them.
  it("logs and swallows an emit that throws synchronously", async () => {
    const emit = vi.fn(() => {
      throw new Error("host RPC unavailable");
    });
    const ctx = mockCtx(emit);

    await expect(emitOrLog(ctx, "acp-spawn", "company-1", { type: "cancel" }, "session cancel")).resolves.toBeUndefined();

    expect(ctx.logger.error).toHaveBeenCalledWith(
      "Failed to emit host event",
      expect.objectContaining({ site: "session cancel", error: expect.stringContaining("host RPC unavailable") }),
    );
  });

  it("includes the call site's ids and omits an absent payload type", async () => {
    const emit = vi.fn().mockRejectedValue(new Error("host RPC unavailable"));
    const ctx = mockCtx(emit);

    await emitOrLog(ctx, "escalation.resolved", "company-1", { escalationId: "e1" }, "escalation resolved", {
      escalationId: "e1",
    });

    const fields = (ctx.logger.error as ReturnType<typeof vi.fn>).mock.calls[0][1] as Record<string, unknown>;
    expect(fields.escalationId).toBe("e1");
    expect(fields.type).toBeUndefined();
  });
});
