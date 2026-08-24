import { describe, expect, it } from "vitest";
import type { Agent } from "@paperclipai/plugin-sdk";
import { countAgents, isAvailable, isUnavailable, isWorking } from "../src/agent-status.js";

function agent(status: string): Agent {
  return { id: `a-${status}`, name: `Agent ${status}`, status } as Agent;
}

// The SDK union, so a status added later shows up here as a failing case
// rather than silently inflating a user-facing count.
const ALL_STATUSES = [
  "error",
  "active",
  "idle",
  "paused",
  "running",
  "pending_approval",
  "terminated",
];

describe("agent status predicates", () => {
  it("treats running and active as working", () => {
    expect(ALL_STATUSES.filter((s) => isWorking(agent(s)))).toEqual(["active", "running"]);
  });

  it("treats working agents and idle ones as available", () => {
    expect(ALL_STATUSES.filter((s) => isAvailable(agent(s)))).toEqual(["active", "idle", "running"]);
  });

  it("treats paused and error as unavailable", () => {
    expect(ALL_STATUSES.filter((s) => isUnavailable(agent(s)))).toEqual(["error", "paused"]);
  });

  it("excludes terminated and pending_approval from availability", () => {
    expect(isAvailable(agent("terminated"))).toBe(false);
    expect(isAvailable(agent("pending_approval"))).toBe(false);
  });

  it("reports an unknown future status as unavailable rather than available", () => {
    const unknown = agent("some_new_status_from_a_later_sdk");
    expect(isWorking(unknown)).toBe(false);
    expect(isAvailable(unknown)).toBe(false);
  });
});

describe("countAgents", () => {
  it("counts availability positively instead of subtracting paused/error", () => {
    const counts = countAgents([
      agent("running"),
      agent("idle"),
      agent("paused"),
      agent("terminated"),
      agent("pending_approval"),
    ]);
    expect(counts).toEqual({ total: 5, working: 1, available: 2, unavailable: 1 });
  });

  it("counts a working agent as available too", () => {
    expect(countAgents([agent("running")])).toEqual({
      total: 1,
      working: 1,
      available: 1,
      unavailable: 0,
    });
  });

  it("returns zeroes for an empty company", () => {
    expect(countAgents([])).toEqual({ total: 0, working: 0, available: 0, unavailable: 0 });
  });
});
