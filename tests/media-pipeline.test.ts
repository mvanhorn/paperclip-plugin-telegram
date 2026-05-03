import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleMediaMessage } from "../src/media-pipeline.js";
import type { PluginContext } from "@paperclipai/plugin-sdk";

let sentMessages: Array<{ chatId: string; text: string; options?: Record<string, unknown> }> = [];
let stateStore: Record<string, unknown> = {};
let emittedEvents: Array<{ event: string; companyId: string; payload: unknown }> = [];

vi.mock("../src/telegram-api.js", async () => {
  const actual = await vi.importActual("../src/telegram-api.js") as Record<string, unknown>;
  return {
    ...actual,
    sendMessage: vi.fn(async (_ctx: unknown, _token: string, chatId: string, text: string, options?: Record<string, unknown>) => {
      sentMessages.push({ chatId, text, options });
      return 1;
    }),
    sendChatAction: vi.fn(),
  };
});

vi.mock("../src/acp-bridge.js", async () => {
  return {
    getSessions: vi.fn(async (_ctx: unknown, _chatId: string, _threadId: number) => {
      const key = `sessions_${_chatId}_${_threadId}`;
      return (stateStore[key] as unknown[]) ?? [];
    }),
    wakeAgentWithIssue: vi.fn(async () => "mock-issue-id"),
  };
});

function mockCtx(): PluginContext {
  return {
    http: {
      fetch: vi.fn().mockResolvedValue({
        json: () => Promise.resolve({
          ok: true,
          result: { file_path: "voice/file_0.oga" },
        }),
        blob: () => Promise.resolve(new Blob(["audio"])),
      }),
    },
    metrics: { write: vi.fn() },
    state: {
      get: vi.fn(async (key: { stateKey: string }) => stateStore[key.stateKey] ?? null),
      set: vi.fn(async (key: { stateKey: string }, value: unknown) => {
        stateStore[key.stateKey] = value;
      }),
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    events: {
      emit: vi.fn((event: string, companyId: string, payload: unknown) => {
        emittedEvents.push({ event, companyId, payload });
      }),
    },
    agents: {
      invoke: vi.fn().mockResolvedValue({ runId: "run-1" }),
      sessions: {
        sendMessage: vi.fn(),
      },
    },
    secrets: {
      resolve: vi.fn().mockResolvedValue("sk-test-key"),
    },
  } as unknown as PluginContext;
}

const defaultConfig = {
  briefAgentId: "brief-agent",
  briefAgentChatIds: ["intake-chat"],
  transcriptionApiKeyRef: "openai-key",
};

beforeEach(() => {
  sentMessages = [];
  stateStore = {};
  emittedEvents = [];

  vi.stubGlobal("fetch", vi.fn(async (url: unknown) => {
    const u = String(url);
    if (u.includes("openai.com")) {
      return new Response(JSON.stringify({ text: "Transcribed" }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (u.includes("api.telegram.org")) {
      return new Response(new ArrayBuffer(8));
    }
    throw new Error(`Unmocked native fetch: ${u}`);
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Intake detection", () => {
  it("processes media in intake channel", async () => {
    const ctx = mockCtx();
    const result = await handleMediaMessage(ctx, "token", {
      message_id: 1,
      chat: { id: Number("intake-chat") || 123 },
      voice: { file_id: "voice-1", duration: 5 },
      from: { id: 1, username: "user1" },
    }, {
      ...defaultConfig,
      briefAgentChatIds: ["123"],
    }, "company-1");

    // Chat id "123" is in briefAgentChatIds -> intake channel
    expect(result).toBe(true);
  });

  it("skips media not in intake channel and not in agent thread", async () => {
    const ctx = mockCtx();
    const result = await handleMediaMessage(ctx, "token", {
      message_id: 1,
      chat: { id: 999 },
      voice: { file_id: "voice-1", duration: 5 },
    }, defaultConfig, "company-1");

    expect(result).toBe(false);
  });

  it("processes media in agent thread with active session", async () => {
    stateStore["sessions_456_42"] = [{
      sessionId: "s1",
      agentId: "a1",
      agentName: "builder",
      agentDisplayName: "Builder",
      transport: "acp",
      spawnedAt: "2026-01-01T00:00:00Z",
      status: "active",
      lastActivityAt: "2026-01-01T00:00:00Z",
    }];

    const ctx = mockCtx();
    const result = await handleMediaMessage(ctx, "token", {
      message_id: 1,
      chat: { id: 456 },
      message_thread_id: 42,
      document: { file_id: "doc-1", file_name: "report.pdf", mime_type: "application/pdf" },
    }, { ...defaultConfig, briefAgentChatIds: [] }, "company-1");

    expect(result).toBe(true);
  });

  it("skips media in thread without active session", async () => {
    stateStore["sessions_456_42"] = [{
      sessionId: "s1",
      agentId: "a1",
      agentName: "builder",
      agentDisplayName: "Builder",
      transport: "acp",
      spawnedAt: "2026-01-01T00:00:00Z",
      status: "closed",
      lastActivityAt: "2026-01-01T00:00:00Z",
    }];

    const ctx = mockCtx();
    const result = await handleMediaMessage(ctx, "token", {
      message_id: 1,
      chat: { id: 456 },
      message_thread_id: 42,
      voice: { file_id: "voice-1", duration: 5 },
    }, { ...defaultConfig, briefAgentChatIds: [] }, "company-1");

    expect(result).toBe(false);
  });
});

describe("Audio type detection", () => {
  it("detects voice messages as audio", async () => {
    const ctx = mockCtx();

    await handleMediaMessage(ctx, "token", {
      message_id: 1,
      chat: { id: 123 },
      voice: { file_id: "voice-1", duration: 5, mime_type: "audio/ogg" },
      from: { id: 1, username: "user1" },
    }, { ...defaultConfig, briefAgentChatIds: ["123"] }, "company-1");

    // Should show transcription preview
    expect(sentMessages.some(m => m.text.includes("Transcription"))).toBe(true);
  });

  it("detects audio messages as audio", async () => {
    const ctx = mockCtx();

    await handleMediaMessage(ctx, "token", {
      message_id: 1,
      chat: { id: 123 },
      audio: { file_id: "audio-1", duration: 120, title: "Song", mime_type: "audio/mpeg" },
      from: { id: 1, username: "user1" },
    }, { ...defaultConfig, briefAgentChatIds: ["123"] }, "company-1");

    expect(sentMessages.some(m => m.text.includes("Transcription"))).toBe(true);
  });

  it("detects video_note as audio (transcribable)", async () => {
    const ctx = mockCtx();

    await handleMediaMessage(ctx, "token", {
      message_id: 1,
      chat: { id: 123 },
      video_note: { file_id: "vn-1", duration: 10 },
      from: { id: 1, username: "user1" },
    }, { ...defaultConfig, briefAgentChatIds: ["123"] }, "company-1");

    expect(sentMessages.some(m => m.text.includes("Transcription"))).toBe(true);
  });

  it("does not transcribe photo messages", async () => {
    const ctx = mockCtx();
    await handleMediaMessage(ctx, "token", {
      message_id: 1,
      chat: { id: 123 },
      photo: [{ file_id: "photo-1", width: 800, height: 600 }],
      caption: "A nice photo",
      from: { id: 1, username: "user1" },
    }, { ...defaultConfig, briefAgentChatIds: ["123"] }, "company-1");

    // Should not show transcription, but should still process
    expect(sentMessages.every(m => !m.text.includes("Transcription"))).toBe(true);
  });

  it("does not transcribe document messages", async () => {
    const ctx = mockCtx();
    await handleMediaMessage(ctx, "token", {
      message_id: 1,
      chat: { id: 123 },
      document: { file_id: "doc-1", file_name: "file.pdf", mime_type: "application/pdf" },
      from: { id: 1, username: "user1" },
    }, { ...defaultConfig, briefAgentChatIds: ["123"] }, "company-1");

    expect(sentMessages.every(m => !m.text.includes("Transcription"))).toBe(true);
  });
});

describe("Media routing to agents in threads", () => {
  it("routes media to most recently active agent in thread", async () => {
    stateStore["sessions_456_42"] = [
      {
        sessionId: "s1",
        agentId: "a1",
        agentName: "builder",
        agentDisplayName: "Builder",
        transport: "acp",
        spawnedAt: "2026-01-01T00:00:00Z",
        status: "active",
        lastActivityAt: "2026-01-01T00:00:00Z",
      },
      {
        sessionId: "s2",
        agentId: "a2",
        agentName: "tester",
        agentDisplayName: "Tester",
        transport: "acp",
        spawnedAt: "2026-01-01T00:00:00Z",
        status: "active",
        lastActivityAt: "2026-01-02T00:00:00Z", // more recent
      },
    ];

    const ctx = mockCtx();
    await handleMediaMessage(ctx, "token", {
      message_id: 1,
      chat: { id: 456 },
      message_thread_id: 42,
      document: { file_id: "doc-1", file_name: "file.txt", mime_type: "text/plain" },
      caption: "Check this",
    }, { ...defaultConfig, briefAgentChatIds: [] }, "company-1");

    // Should emit ACP event to the most recently active agent (s2)
    const acp = emittedEvents.find(e => e.event === "acp-spawn");
    expect(acp).toBeDefined();
    expect((acp!.payload as Record<string, unknown>).sessionId).toBe("s2");
  });

  it("sends to native session when transport is native", async () => {
    const { wakeAgentWithIssue } = await import("../src/acp-bridge.js");

    stateStore["sessions_456_42"] = [{
      sessionId: "s1",
      agentId: "a1",
      agentName: "builder",
      agentDisplayName: "Builder",
      transport: "native",
      spawnedAt: "2026-01-01T00:00:00Z",
      status: "active",
      lastActivityAt: "2026-01-01T00:00:00Z",
    }];

    const ctx = mockCtx();
    await handleMediaMessage(ctx, "token", {
      message_id: 1,
      chat: { id: 456 },
      message_thread_id: 42,
      document: { file_id: "doc-1", file_name: "file.txt" },
    }, { ...defaultConfig, briefAgentChatIds: [] }, "company-1");

    expect(wakeAgentWithIssue).toHaveBeenCalled();
  });
});

describe("Returns false for empty media", () => {
  it("returns false when no file can be extracted", async () => {
    const ctx = mockCtx();
    const result = await handleMediaMessage(ctx, "token", {
      message_id: 1,
      chat: { id: 123 },
      // no voice, audio, video_note, document, or photo
    }, { ...defaultConfig, briefAgentChatIds: ["123"] }, "company-1");

    expect(result).toBe(false);
  });
});
