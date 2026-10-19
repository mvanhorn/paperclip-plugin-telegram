import { describe, expect, it } from "vitest";
import type { IssueThreadInteraction } from "@paperclipai/shared";
import {
  isActionableInteraction,
  isNotifyOnlyInteraction,
  isForwardableInteraction,
  buildInteractionCallbackData,
  parseInteractionCallbackData,
  createRecentIssueTracker,
  mergeInteractionCandidates,
  INTERACTION_ACCEPT_PREFIX,
  INTERACTION_REJECT_PREFIX,
} from "../src/interaction-routing.js";

function interaction(overrides: Partial<IssueThreadInteraction> = {}): IssueThreadInteraction {
  return {
    id: "int-1",
    kind: "request_confirmation",
    status: "pending",
    payload: { version: 1, prompt: "Ship it?" },
    ...overrides,
  } as IssueThreadInteraction;
}

describe("isActionableInteraction", () => {
  it("accepts a pending request_confirmation", () => {
    expect(isActionableInteraction(interaction())).toBe(true);
  });

  it("rejects non-pending confirmations", () => {
    for (const status of ["accepted", "rejected", "answered", "cancelled", "expired", "failed"] as const) {
      expect(isActionableInteraction(interaction({ status }))).toBe(false);
    }
  });

  it("rejects kinds that cannot be resolved by accept/reject", () => {
    for (const kind of [
      "suggest_tasks",
      "ask_user_questions",
      "request_checkbox_confirmation",
      "request_item_verdicts",
      "connection_intent",
    ] as const) {
      expect(isActionableInteraction(interaction({ kind } as Partial<IssueThreadInteraction>))).toBe(false);
    }
  });
});

describe("isNotifyOnlyInteraction / isForwardableInteraction", () => {
  it("treats pending ask_user_questions and request_item_verdicts as notify-only", () => {
    for (const kind of ["ask_user_questions", "request_item_verdicts"] as const) {
      const i = interaction({ kind } as Partial<IssueThreadInteraction>);
      expect(isNotifyOnlyInteraction(i)).toBe(true);
      expect(isActionableInteraction(i)).toBe(false);
      expect(isForwardableInteraction(i)).toBe(true);
    }
  });

  it("does not treat request_confirmation as notify-only (it is actionable)", () => {
    const i = interaction();
    expect(isNotifyOnlyInteraction(i)).toBe(false);
    expect(isForwardableInteraction(i)).toBe(true);
  });

  it("ignores non-pending notify-only kinds", () => {
    expect(
      isNotifyOnlyInteraction(
        interaction({ kind: "ask_user_questions", status: "answered" } as Partial<IssueThreadInteraction>),
      ),
    ).toBe(false);
  });

  it("leaves kinds that stay on the digest unforwardable", () => {
    for (const kind of ["suggest_tasks", "request_checkbox_confirmation", "connection_intent"] as const) {
      expect(isForwardableInteraction(interaction({ kind } as Partial<IssueThreadInteraction>))).toBe(false);
    }
  });
});

describe("interaction callback_data codec", () => {
  const uuid = "6f8f1c7e-2b4a-4c1d-9e3a-1f2b3c4d5e6f";

  it("round-trips accept and reject", () => {
    expect(parseInteractionCallbackData(buildInteractionCallbackData("accept", uuid))).toEqual({
      action: "accept",
      interactionId: uuid,
    });
    expect(parseInteractionCallbackData(buildInteractionCallbackData("reject", uuid))).toEqual({
      action: "reject",
      interactionId: uuid,
    });
  });

  it("stays within Telegram's 64-byte callback_data limit", () => {
    expect(Buffer.byteLength(buildInteractionCallbackData("accept", uuid))).toBeLessThanOrEqual(64);
    expect(Buffer.byteLength(buildInteractionCallbackData("reject", uuid))).toBeLessThanOrEqual(64);
  });

  it("ignores foreign callback_data (approvals, escalations, empty ids)", () => {
    expect(parseInteractionCallbackData(`approve_${uuid}`)).toBeNull();
    expect(parseInteractionCallbackData(`reject_${uuid}`)).toBeNull();
    expect(parseInteractionCallbackData(`esc_defer_${uuid}`)).toBeNull();
    expect(parseInteractionCallbackData(INTERACTION_ACCEPT_PREFIX)).toBeNull();
    expect(parseInteractionCallbackData(INTERACTION_REJECT_PREFIX)).toBeNull();
  });

  it("uses prefixes distinct from the approval prefixes", () => {
    expect(INTERACTION_ACCEPT_PREFIX.startsWith("approve_")).toBe(false);
    expect(INTERACTION_REJECT_PREFIX.startsWith("reject_")).toBe(false);
  });
});

describe("createRecentIssueTracker", () => {
  it("returns recorded issues as candidates", () => {
    const tracker = createRecentIssueTracker();
    tracker.record("issue-a", "company-1", 1_000);
    tracker.record("issue-b", "company-2", 1_000);

    expect(tracker.candidates(1_000)).toEqual([
      { issueId: "issue-a", companyId: "company-1" },
      { issueId: "issue-b", companyId: "company-2" },
    ]);
  });

  it("ignores empty issue or company ids", () => {
    const tracker = createRecentIssueTracker();
    tracker.record("", "company-1", 1_000);
    tracker.record("issue-a", "", 1_000);
    expect(tracker.size).toBe(0);
  });

  it("drops entries older than the TTL", () => {
    const tracker = createRecentIssueTracker({ ttlMs: 5_000 });
    tracker.record("issue-a", "company-1", 1_000);

    // Still inside the window.
    expect(tracker.candidates(5_900)).toHaveLength(1);
    // Past the window.
    expect(tracker.candidates(6_000)).toHaveLength(0);
  });

  it("refreshes an issue's timestamp on re-record so an active issue never ages out", () => {
    const tracker = createRecentIssueTracker({ ttlMs: 5_000 });
    tracker.record("issue-a", "company-1", 1_000);
    tracker.record("issue-a", "company-1", 4_000);

    // Would have expired at 6_000 on the first timestamp, but the re-record
    // pushed it to 9_000.
    expect(tracker.candidates(6_000)).toEqual([{ issueId: "issue-a", companyId: "company-1" }]);
  });

  it("keeps only the newest entries when it would grow past maxEntries", () => {
    const tracker = createRecentIssueTracker({ maxEntries: 2 });
    tracker.record("issue-a", "company-1", 1_000);
    tracker.record("issue-b", "company-1", 2_000);
    tracker.record("issue-c", "company-1", 3_000);

    const ids = tracker.candidates(3_000).map((candidate) => candidate.issueId);
    expect(ids).toHaveLength(2);
    expect(ids).toContain("issue-b");
    expect(ids).toContain("issue-c");
    expect(ids).not.toContain("issue-a");
  });
});

describe("mergeInteractionCandidates", () => {
  it("dedupes by issue id, first source winning its company attribution", () => {
    const merged = mergeInteractionCandidates(
      [
        [{ issueId: "issue-a", companyId: "company-1" }],
        [
          { issueId: "issue-a", companyId: "company-OTHER" },
          { issueId: "issue-b", companyId: "company-2" },
        ],
      ],
      10,
    );

    expect(merged).toEqual([
      { issueId: "issue-a", companyId: "company-1" },
      { issueId: "issue-b", companyId: "company-2" },
    ]);
  });

  it("skips entries missing an issue or company id", () => {
    const merged = mergeInteractionCandidates(
      [[{ issueId: "", companyId: "c" }, { issueId: "issue-a", companyId: "" }]],
      10,
    );
    expect(merged).toEqual([]);
  });

  it("never exceeds the cap", () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ issueId: `issue-${i}`, companyId: "c" }));
    expect(mergeInteractionCandidates([many], 5)).toHaveLength(5);
  });
});
