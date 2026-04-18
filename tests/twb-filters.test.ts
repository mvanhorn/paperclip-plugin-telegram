import { describe, it, expect } from "vitest";
import type { PluginEvent } from "@paperclipai/plugin-sdk";
import {
  commentMentionsBoard,
  isInboxChatAllowed,
  formatIssueBlocked,
  formatBoardMention,
} from "../src/formatters.js";

function makeEvent(payload: Record<string, unknown>, overrides: Partial<PluginEvent> = {}): PluginEvent {
  return {
    eventType: "issue.comment.created",
    entityId: "iss-1",
    entityType: "issue",
    companyId: "co-1",
    occurredAt: new Date().toISOString(),
    payload,
    ...overrides,
  } as PluginEvent;
}

describe("commentMentionsBoard", () => {
  it("matches exact handle", () => {
    expect(commentMentionsBoard("hey @jonas can you check this", ["jonas"])).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(commentMentionsBoard("ping @Jonas", ["jonas"])).toBe(true);
    expect(commentMentionsBoard("ping @jonas", ["Jonas"])).toBe(true);
  });

  it("accepts '@' prefix in the username list", () => {
    expect(commentMentionsBoard("ping @jonas", ["@jonas"])).toBe(true);
  });

  it("returns false when no match", () => {
    expect(commentMentionsBoard("ping @alice", ["jonas", "bob"])).toBe(false);
  });

  it("does not match partial handle (word boundary required)", () => {
    expect(commentMentionsBoard("ping @jonasX please", ["jonas"])).toBe(false);
  });

  it("matches when mention is at end of string", () => {
    expect(commentMentionsBoard("ping @jonas", ["jonas"])).toBe(true);
  });

  it("matches when followed by punctuation", () => {
    expect(commentMentionsBoard("fyi @jonas!", ["jonas"])).toBe(true);
    expect(commentMentionsBoard("fyi @jonas, please review", ["jonas"])).toBe(true);
  });

  it("returns false with empty body or empty usernames", () => {
    expect(commentMentionsBoard("", ["jonas"])).toBe(false);
    expect(commentMentionsBoard("ping @jonas", [])).toBe(false);
    expect(commentMentionsBoard("ping @jonas", [""])).toBe(false);
  });

  it("tries multiple usernames", () => {
    expect(commentMentionsBoard("cc @alice @bob", ["jonas", "bob"])).toBe(true);
  });
});

describe("isInboxChatAllowed", () => {
  it("allows defaultChatId when no explicit allow-list", () => {
    expect(isInboxChatAllowed("123", "123", [])).toBe(true);
  });

  it("rejects non-default chat when no allow-list", () => {
    expect(isInboxChatAllowed("999", "123", [])).toBe(false);
  });

  it("honors allow-list when set (overrides default)", () => {
    expect(isInboxChatAllowed("123", "123", ["456"])).toBe(false);
    expect(isInboxChatAllowed("456", "123", ["456"])).toBe(true);
  });

  it("ignores empty strings in the allow-list", () => {
    expect(isInboxChatAllowed("123", "123", ["", "  "])).toBe(true);
  });

  it("rejects empty chatId", () => {
    expect(isInboxChatAllowed("", "123", [])).toBe(false);
  });

  it("rejects when default is empty and no allow-list", () => {
    expect(isInboxChatAllowed("123", "", [])).toBe(false);
  });
});

describe("formatIssueBlocked", () => {
  it("renders identifier, title, assignee and blocker comment", () => {
    const msg = formatIssueBlocked(
      makeEvent(
        {
          identifier: "WAA-10",
          title: "Broken thing",
          assigneeName: "Jonas",
          comment: "Waiting on DNS",
          status: "blocked",
        },
        { eventType: "issue.updated", entityId: "iss-10" },
      ),
      { baseUrl: "https://pc.example.com", issuePrefix: "WAA" },
    );
    expect(msg.text).toContain("Issue Blocked");
    expect(msg.text).toContain("WAA\\-10");
    expect(msg.text).toContain("Broken thing");
    expect(msg.text).toContain("Jonas");
    expect(msg.text).toContain("Waiting on DNS");
    expect(msg.options.parseMode).toBe("MarkdownV2");
  });
});

describe("formatBoardMention", () => {
  it("renders author, issue identifier, and comment body", () => {
    const msg = formatBoardMention(
      makeEvent({
        issueId: "iss-1",
        issueIdentifier: "WAA-12",
        issueTitle: "Pipeline flaky",
        authorName: "alice",
        body: "hey @jonas can you help?",
      }),
      { baseUrl: "https://pc.example.com", issuePrefix: "WAA" },
    );
    expect(msg.text).toContain("Board mentioned");
    expect(msg.text).toContain("WAA\\-12");
    expect(msg.text).toContain("alice");
    expect(msg.text).toContain("hey @jonas can you help?");
  });
});
