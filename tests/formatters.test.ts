import { describe, it, expect } from "vitest";
import {
  formatIssueCreated,
  formatIssueDone,
  formatIssueAssigned,
  formatApprovalCreated,
  formatIssueRequestConfirmation,
  formatAgentError,
  formatAgentRunStarted,
  formatAgentRunFinished,
} from "../src/formatters.js";
import type { PluginEvent } from "@paperclipai/plugin-sdk";

function mockEvent(overrides: Record<string, unknown> = {}): PluginEvent {
  return {
    eventType: "issue.created",
    entityId: "iss-123",
    entityType: "issue",
    companyId: "co-1",
    occurredAt: new Date().toISOString(),
    payload: { identifier: "PROJ-42", title: "Test issue", ...overrides },
  } as PluginEvent;
}

describe("formatIssueCreated", () => {
  it("includes identifier and title", () => {
    const msg = formatIssueCreated(mockEvent());
    expect(msg.text).toContain("PROJ\\-42");
    expect(msg.text).toContain("Test issue");
  });

  it("falls back to entityId when no identifier", () => {
    const msg = formatIssueCreated(mockEvent({ identifier: undefined }));
    expect(msg.text).toContain("iss\\-123");
  });

  it("uses MarkdownV2 parse mode", () => {
    const msg = formatIssueCreated(mockEvent());
    expect(msg.options.parseMode).toBe("MarkdownV2");
  });

  it("includes metadata fields when available", () => {
    const msg = formatIssueCreated(mockEvent({
      status: "open",
      priority: "high",
      assigneeName: "Alice",
      projectName: "Backend",
    }));
    expect(msg.text).toContain("open");
    expect(msg.text).toContain("high");
    expect(msg.text).toContain("Alice");
    expect(msg.text).toContain("Backend");
  });

  it("includes description snippet", () => {
    const msg = formatIssueCreated(mockEvent({ description: "A long description about this issue" }));
    expect(msg.text).toContain("A long description");
  });

  it("truncates long descriptions at word boundary", () => {
    const words = Array(50).fill("word").join(" ");
    const msg = formatIssueCreated(mockEvent({ description: words }));
    expect(msg.text).toContain("\\.\\.\\.");
    expect(msg.text.length).toBeLessThan(words.length * 2);
  });

  it("omits metadata line when no metadata", () => {
    const msg = formatIssueCreated(mockEvent({
      status: undefined,
      priority: undefined,
      assigneeName: undefined,
      projectName: undefined,
    }));
    expect(msg.text).not.toContain("\\|");
  });
});

describe("formatIssueDone", () => {
  it("includes identifier and done text", () => {
    const msg = formatIssueDone(mockEvent());
    expect(msg.text).toContain("PROJ\\-42");
    expect(msg.text).toContain("done");
  });

  it("falls back to entityId", () => {
    const msg = formatIssueDone(mockEvent({ identifier: undefined }));
    expect(msg.text).toContain("iss\\-123");
  });

  it("includes comment when provided", () => {
    const msg = formatIssueDone(mockEvent({ comment: "Board prep package completed for Q3" }));
    expect(msg.text).toContain("Board prep package completed for Q3");
  });

  it("turns delegated completion comments into concise result summaries", () => {
    const msg = formatIssueDone(mockEvent({
      comment: [
        "Completed the controlled model eval and posted the comparison table/recommendation.",
        "",
        "Result: recommend Codex GPT-5.5 as Richie default; keep Sonnet as fallback for synthesis/editorial review.",
        "Next action/owner: CHO-771 already reflects this recommendation, so no further mutation was needed there.",
        "",
        "Compound? memory/doc — already captured.",
      ].join("\n"),
    }));
    expect(msg.text).toContain("Completed the controlled model eval");
    expect(msg.text).toContain("Result: recommend Codex GPT\\-5\\.5 as Richie default");
    expect(msg.text).toContain("Next action/owner: CHO\\-771 already reflects");
    expect(msg.text).not.toContain("Compound");
  });

  it("formats in_review transitions as review-ready summaries", () => {
    const msg = formatIssueDone(mockEvent({
      status: "in_review",
      comment: "Recommendation: approve the patch after operator restart.",
    }));
    expect(msg.text).toContain("Ready for Review");
    expect(msg.text).toContain("is in review");
    expect(msg.text).toContain("Recommendation: approve the patch");
  });

  it("truncates long comments", () => {
    const longComment = Array(80).fill("word").join(" ");
    const msg = formatIssueDone(mockEvent({ comment: longComment }));
    expect(msg.text).toContain("\\.\\.\\.");
  });

  it("omits comment section when no comment", () => {
    const msg = formatIssueDone(mockEvent());
    // Should only have the title and done line, no blockquote
    const lines = msg.text.split("\n").filter((l: string) => l.trim());
    expect(lines.length).toBe(2);
  });
});

describe("formatIssueAssigned", () => {
  it("shows the assigned user when assigning from nobody", () => {
    const msg = formatIssueAssigned(mockEvent({
      assigneeUserId: "user-me",
      assigneeName: "Nuno",
      _previous: { assigneeUserId: null, assigneeName: null },
    }));
    expect(msg.text).toContain("Issue Assigned");
    expect(msg.text).toContain("PROJ\\-42");
    expect(msg.text).toContain("Nuno");
    // No previous-name line
    expect(msg.text).not.toContain("→");
  });

  it("shows 'previous → new' when reassigning from another user", () => {
    const msg = formatIssueAssigned(mockEvent({
      assigneeUserId: "user-me",
      assigneeName: "Nuno",
      _previous: { assigneeUserId: "user-other", assigneeName: "Alice" },
    }));
    expect(msg.text).toContain("Alice");
    expect(msg.text).toContain("Nuno");
    expect(msg.text).toContain("→");
  });

  it("shows 'Unassigned' when the new assignee is null", () => {
    const msg = formatIssueAssigned(mockEvent({
      assigneeUserId: null,
      assigneeName: null,
      _previous: { assigneeUserId: "user-me", assigneeName: "Nuno" },
    }));
    expect(msg.text).toContain("Unassigned");
  });

  it("uses MarkdownV2 parse mode", () => {
    const msg = formatIssueAssigned(mockEvent({ assigneeName: "Nuno" }));
    expect(msg.options.parseMode).toBe("MarkdownV2");
  });

  it("falls back to entityId when no identifier", () => {
    const msg = formatIssueAssigned(mockEvent({ identifier: undefined, assigneeName: "Nuno" }));
    expect(msg.text).toContain("iss\\-123");
  });
});

describe("formatApprovalCreated", () => {
  it("includes approve and reject buttons", () => {
    const msg = formatApprovalCreated(mockEvent({
      type: "deploy",
      approvalId: "apr-1",
      title: "Deploy to prod",
    }));
    expect(msg.options.inlineKeyboard).toBeDefined();
    const buttons = msg.options.inlineKeyboard![0];
    expect(buttons.length).toBe(2);
    expect(buttons[0].text).toBe("Approve");
    expect(buttons[0].callback_data).toBe("approve_apr-1");
    expect(buttons[1].text).toBe("Reject");
    expect(buttons[1].callback_data).toBe("reject_apr-1");
  });

  it("falls back to entityId for approvalId", () => {
    const msg = formatApprovalCreated(mockEvent({ approvalId: undefined }));
    const buttons = msg.options.inlineKeyboard![0];
    expect(buttons[0].callback_data).toBe("approve_iss-123");
  });

  it("includes agent name when provided", () => {
    const msg = formatApprovalCreated(mockEvent({
      agentName: "Builder",
      type: "deploy",
    }));
    expect(msg.text).toContain("Builder");
  });

  it("includes linked issues", () => {
    const msg = formatApprovalCreated(mockEvent({
      linkedIssues: [
        { identifier: "ISS-1", title: "First", status: "open" },
        { identifier: "ISS-2", title: "Second", status: "done" },
      ],
    }));
    expect(msg.text).toContain("ISS\\-1");
    expect(msg.text).toContain("ISS\\-2");
    expect(msg.text).toContain("Linked Issues");
  });

  it("truncates description at word boundary", () => {
    const longDesc = Array(80).fill("word").join(" ");
    const msg = formatApprovalCreated(mockEvent({ description: longDesc }));
    expect(msg.text).toContain("\\.\\.\\.");
  });
});

describe("formatIssueRequestConfirmation", () => {
  it("includes issue link and accept/reject buttons", () => {
    const msg = formatIssueRequestConfirmation(mockEvent({
      eventType: "issue.thread_interaction_created",
      entityId: "int-123",
      interaction: {
        id: "int-123",
        kind: "request_confirmation",
        title: "Restart approval",
        payload: {
          prompt: "Approve restarting Paperclip?",
          acceptLabel: "Approve restart",
          rejectLabel: "Do not restart",
        },
      },
      issueIdentifier: "CHO-781",
      issueTitle: "Add structured review guards",
    }));

    expect(msg.text).toContain("Confirmation Requested");
    expect(msg.text).toContain("CHO\\-781");
    expect(msg.text).toContain("Restart approval");
    expect(msg.text).toContain("Approve restarting Paperclip");
    expect(msg.options.inlineKeyboard).toBeDefined();
    expect(msg.options.inlineKeyboard![0][0]).toEqual({
      text: "Approve restart",
      callback_data: "confirm_accept_int-123",
    });
    expect(msg.options.inlineKeyboard![0][1]).toEqual({
      text: "Do not restart",
      callback_data: "confirm_reject_int-123",
    });
  });

  it("uses an issue link for reject when a rejection reason is required", () => {
    const msg = formatIssueRequestConfirmation(mockEvent({
      entityId: "int-456",
      interaction: {
        id: "int-456",
        kind: "request_confirmation",
        title: "Plan approval",
        payload: {
          rejectLabel: "Request changes",
          rejectRequiresReason: true,
        },
      },
      issueIdentifier: "CHO-788",
    }), { baseUrl: "https://paperclip.example", issuePrefix: "CHO" });

    expect(msg.options.inlineKeyboard![0][0].callback_data).toBe("confirm_accept_int-456");
    expect(msg.options.inlineKeyboard![1][0]).toEqual({
      text: "Request changes",
      url: "https://paperclip.example/CHO/issues/CHO-788",
    });
  });
});

describe("formatAgentError", () => {
  it("includes agent name and error", () => {
    const msg = formatAgentError(mockEvent({
      agentName: "Builder",
      error: "Connection refused",
    }));
    expect(msg.text).toContain("Builder");
    expect(msg.text).toContain("Connection refused");
  });

  it("truncates long error messages", () => {
    const longError = "x".repeat(600);
    const msg = formatAgentError(mockEvent({ error: longError }));
    expect(msg.text).toContain("\\.\\.\\.");
    expect(msg.text).not.toContain("x".repeat(501));
  });

  it("falls back to entityId for agent name", () => {
    const msg = formatAgentError(mockEvent({ agentName: undefined, name: undefined }));
    expect(msg.text).toContain("iss\\-123");
  });
});

describe("formatAgentRunStarted", () => {
  it("includes agent name", () => {
    const msg = formatAgentRunStarted(mockEvent({ agentName: "Deployer" }));
    expect(msg.text).toContain("Deployer");
    expect(msg.text).toContain("started");
  });

  it("disables notification", () => {
    const msg = formatAgentRunStarted(mockEvent());
    expect(msg.options.disableNotification).toBe(true);
  });
});

describe("formatAgentRunFinished", () => {
  it("includes agent name and completion text", () => {
    const msg = formatAgentRunFinished(mockEvent({ agentName: "Deployer" }));
    expect(msg.text).toContain("Deployer");
    expect(msg.text).toContain("completed");
  });

  it("disables notification", () => {
    const msg = formatAgentRunFinished(mockEvent());
    expect(msg.options.disableNotification).toBe(true);
  });
});
