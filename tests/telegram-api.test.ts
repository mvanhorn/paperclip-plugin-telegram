import { describe, it, expect, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { escapeMarkdownV2, truncateAtWord, answerCallbackQuery } from "../src/telegram-api.js";

describe("escapeMarkdownV2", () => {
  it("escapes underscores", () => {
    expect(escapeMarkdownV2("hello_world")).toBe("hello\\_world");
  });

  it("escapes asterisks", () => {
    expect(escapeMarkdownV2("*bold*")).toBe("\\*bold\\*");
  });

  it("escapes brackets", () => {
    expect(escapeMarkdownV2("[link](url)")).toBe("\\[link\\]\\(url\\)");
  });

  it("escapes backticks", () => {
    expect(escapeMarkdownV2("`code`")).toBe("\\`code\\`");
  });

  it("escapes tildes", () => {
    expect(escapeMarkdownV2("~strikethrough~")).toBe("\\~strikethrough\\~");
  });

  it("escapes hashes", () => {
    expect(escapeMarkdownV2("#heading")).toBe("\\#heading");
  });

  it("escapes plus signs", () => {
    expect(escapeMarkdownV2("a+b")).toBe("a\\+b");
  });

  it("escapes hyphens", () => {
    expect(escapeMarkdownV2("a-b")).toBe("a\\-b");
  });

  it("escapes equal signs", () => {
    expect(escapeMarkdownV2("a=b")).toBe("a\\=b");
  });

  it("escapes pipes", () => {
    expect(escapeMarkdownV2("a|b")).toBe("a\\|b");
  });

  it("escapes curly braces", () => {
    expect(escapeMarkdownV2("{a}")).toBe("\\{a\\}");
  });

  it("escapes dots", () => {
    expect(escapeMarkdownV2("a.b")).toBe("a\\.b");
  });

  it("escapes exclamation marks", () => {
    expect(escapeMarkdownV2("hello!")).toBe("hello\\!");
  });

  it("escapes backslashes", () => {
    expect(escapeMarkdownV2("a\\b")).toBe("a\\\\b");
  });

  it("escapes greater than", () => {
    expect(escapeMarkdownV2("a>b")).toBe("a\\>b");
  });

  it("handles multiple special chars in one string", () => {
    expect(escapeMarkdownV2("PROJ-42: Fix [bug] #1"))
      .toBe("PROJ\\-42: Fix \\[bug\\] \\#1");
  });

  it("leaves plain text unchanged", () => {
    expect(escapeMarkdownV2("hello world")).toBe("hello world");
  });

  it("handles empty string", () => {
    expect(escapeMarkdownV2("")).toBe("");
  });
});

describe("truncateAtWord", () => {
  it("returns text unchanged if shorter than max", () => {
    expect(truncateAtWord("hello", 10)).toBe("hello");
  });

  it("returns text unchanged if equal to max", () => {
    expect(truncateAtWord("hello", 5)).toBe("hello");
  });

  it("truncates at word boundary and adds ellipsis", () => {
    const result = truncateAtWord("hello world foo bar baz", 15);
    expect(result).toBe("hello world...");
  });

  it("falls back to hard cut when no good word boundary", () => {
    const result = truncateAtWord("abcdefghijklmnopqrstuvwxyz", 10);
    expect(result).toBe("abcdefghij...");
    expect(result.length).toBe(13);
  });

  it("handles single word longer than max", () => {
    const result = truncateAtWord("superlongword", 5);
    expect(result).toBe("super...");
  });

  it("handles text with trailing space at boundary", () => {
    const result = truncateAtWord("aa bb cc dd ee ff", 8);
    expect(result).toBe("aa bb cc...");
  });
});

// answerCallbackQuery swallows the HTTP call in a try/catch, so a rejected
// callback query (e.g. an expired button press) never throws — the ok:false
// branch below is the only thing that makes that rejection observable at all.
// It was untested directly: the other suites that exercise this code path
// (workflow-approval.test.ts, bla-606-callback-repro.test.ts) mock
// answerCallbackQuery itself, so the real implementation's branches never ran.
describe("answerCallbackQuery", () => {
  function mockCtx(responses: unknown[]): PluginContext {
    return {
      http: {
        fetch: vi.fn(async () => ({ json: async () => responses.shift() ?? { ok: true } })),
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as unknown as PluginContext;
  }

  it("does not log when Telegram accepts the answer", async () => {
    const ctx = mockCtx([{ ok: true }]);

    await answerCallbackQuery(ctx, "tok", "cbq-1", "ok");

    expect(ctx.logger.error).not.toHaveBeenCalled();
  });

  it("logs Telegram's rejection reason instead of swallowing it", async () => {
    // A 200 response with ok:false (e.g. an expired callback query) never
    // throws, so this branch is the only thing that makes a rejection
    // observable -- without it the button press vanishes without a trace.
    const ctx = mockCtx([{ ok: false, error_code: 400, description: "query is too old" }]);

    await answerCallbackQuery(ctx, "tok", "cbq-1", "Approved");

    expect(ctx.logger.error).toHaveBeenCalledWith(
      "Telegram answerCallbackQuery rejected",
      expect.objectContaining({ callbackQueryId: "cbq-1", error_code: 400, description: "query is too old" }),
    );
  });
});
