import type { Agent } from "@paperclipai/plugin-sdk";

/**
 * Agent counting for user-facing readouts (/status, daily digest).
 *
 * Availability is decided by a positive filter over the statuses that mean an
 * agent can take work. The SDK union is
 * `error | active | idle | paused | running | pending_approval | terminated`,
 * so subtracting the unavailable ones from the total would count `terminated`
 * and `pending_approval` agents as available. A positive filter also fails
 * safe: a status added to the union later is reported as unavailable until
 * someone decides otherwise, rather than silently inflating the count.
 *
 * `active` is a valid value in the union and shared's agent-eligibility treats
 * it as live, but it is not observed on current hosts. It is counted as working
 * so a host that does emit it reads correctly.
 */

export function isWorking(agent: Agent): boolean {
  return agent.status === "running" || agent.status === "active";
}

export function isAvailable(agent: Agent): boolean {
  return isWorking(agent) || agent.status === "idle";
}

export function isUnavailable(agent: Agent): boolean {
  return agent.status === "paused" || agent.status === "error";
}

export type AgentCounts = {
  total: number;
  working: number;
  available: number;
  unavailable: number;
};

export function countAgents(agents: Agent[]): AgentCounts {
  return {
    total: agents.length,
    working: agents.filter(isWorking).length,
    available: agents.filter(isAvailable).length,
    unavailable: agents.filter(isUnavailable).length,
  };
}
