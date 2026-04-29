import { describe, it, expect } from "vitest";
import {
  classifyUpdate,
  shouldDispatchCommand,
  STALE_UPDATE_GRACE_SECONDS,
} from "../src/update-filter.js";

const POLLING_STARTED = 1_000_000;

describe("classifyUpdate (replay & staleness)", () => {
  it("processes a fresh, never-seen update", () => {
    const decision = classifyUpdate(
      { update_id: 100, message: { date: POLLING_STARTED } },
      0,
      POLLING_STARTED,
    );
    expect(decision).toEqual({ action: "process" });
  });

  it("skips an update with the same update_id as the persisted offset (replay)", () => {
    // Acceptance: Same update_id twice sends once at most. The second poll
    // returns the already-persisted update_id, which must be ignored.
    const decision = classifyUpdate(
      { update_id: 100, message: { date: POLLING_STARTED } },
      100,
      POLLING_STARTED,
    );
    expect(decision).toEqual({ action: "skip", reason: "duplicate" });
  });

  it("skips an update older than the persisted offset", () => {
    const decision = classifyUpdate(
      { update_id: 99, message: { date: POLLING_STARTED } },
      100,
      POLLING_STARTED,
    );
    expect(decision).toEqual({ action: "skip", reason: "duplicate" });
  });

  it("skips a stale message that pre-dates plugin boot beyond the grace window", () => {
    // Acceptance: Old update after plugin boot sends zero.
    const decision = classifyUpdate(
      {
        update_id: 200,
        message: { date: POLLING_STARTED - STALE_UPDATE_GRACE_SECONDS - 1 },
      },
      0,
      POLLING_STARTED,
    );
    expect(decision).toEqual({ action: "skip", reason: "stale" });
  });

  it("processes a slightly-old update inside the grace window", () => {
    const decision = classifyUpdate(
      { update_id: 200, message: { date: POLLING_STARTED - 5 } },
      0,
      POLLING_STARTED,
    );
    expect(decision).toEqual({ action: "process" });
  });

  it("uses callback_query date when message date is absent", () => {
    const decision = classifyUpdate(
      {
        update_id: 200,
        callback_query: {
          message: { date: POLLING_STARTED - STALE_UPDATE_GRACE_SECONDS - 100 },
        },
      },
      0,
      POLLING_STARTED,
    );
    expect(decision).toEqual({ action: "skip", reason: "stale" });
  });

  it("processes when no date field is present (cannot prove staleness)", () => {
    const decision = classifyUpdate({ update_id: 200 }, 0, POLLING_STARTED);
    expect(decision).toEqual({ action: "process" });
  });
});

describe("shouldDispatchCommand (commands disabled by default)", () => {
  it("does not dispatch /agents when enableCommands=false", () => {
    // Acceptance: Commands disabled sends zero for /agents.
    expect(
      shouldDispatchCommand(
        "/agents",
        [{ type: "bot_command", offset: 0 }],
        /* enableCommands */ false,
      ),
    ).toBe(false);
  });

  it("dispatches /agents when enableCommands=true", () => {
    expect(
      shouldDispatchCommand(
        "/agents",
        [{ type: "bot_command", offset: 0 }],
        true,
      ),
    ).toBe(true);
  });

  it("does not dispatch when bot_command entity is missing", () => {
    expect(shouldDispatchCommand("/agents", [], true)).toBe(false);
    expect(shouldDispatchCommand("/agents", undefined, true)).toBe(false);
  });

  it("does not dispatch on plain text", () => {
    expect(shouldDispatchCommand("hello", undefined, true)).toBe(false);
  });

  it("does not dispatch when bot_command is not at offset 0", () => {
    expect(
      shouldDispatchCommand(
        "look /agents",
        [{ type: "bot_command", offset: 5 }],
        true,
      ),
    ).toBe(false);
  });
});
