import type { PluginContext } from "@paperclipai/plugin-sdk";
import { sendMessage, escapeMarkdownV2, sendChatAction } from "./telegram-api.js";
import { METRIC_NAMES } from "./constants.js";
import { getSessions, wakeAgentWithIssue } from "./acp-bridge.js";
import { resolveMappedProjectIdForTopic } from "./topic-projects.js";

const TELEGRAM_API = "https://api.telegram.org";

type MediaConfig = {
  briefAgentId: string;
  briefAgentChatIds: string[];
  transcriptionApiKeyRef: string;
  publicUrl?: string;
};

type TelegramMediaMessage = {
  message_id: number;
  chat: { id: number };
  message_thread_id?: number;
  from?: { id: number; username?: string; first_name?: string };
  voice?: { file_id: string; duration: number; mime_type?: string };
  audio?: { file_id: string; duration: number; title?: string; mime_type?: string };
  video_note?: { file_id: string; duration: number };
  document?: { file_id: string; file_name?: string; mime_type?: string };
  photo?: Array<{ file_id: string; width: number; height: number }>;
  caption?: string;
};

export async function handleMediaMessage(
  ctx: PluginContext,
  token: string,
  msg: TelegramMediaMessage,
  config: MediaConfig,
  companyId: string,
): Promise<boolean> {
  const chatId = String(msg.chat.id);
  const threadId = msg.message_thread_id;

  // Determine if this is an intake channel (brief agent) or an agent thread
  const isIntakeChannel = config.briefAgentChatIds.includes(chatId);
  const hasActiveSession = threadId
    ? (await getSessions(ctx, chatId, threadId)).some((s) => s.status === "active")
    : false;

  if (!isIntakeChannel && !hasActiveSession) {
    return false; // Not a media-relevant context
  }

  await sendChatAction(ctx, token, chatId);

  // Extract media file info
  const fileId = extractFileId(msg);
  if (!fileId) return false;

  const isAudio = !!(msg.voice || msg.audio || msg.video_note);

  let textContent = msg.caption ?? "";

  // Transcribe audio/voice if applicable
  if (isAudio && config.transcriptionApiKeyRef) {
    try {
      const transcription = await transcribeAudio(ctx, token, fileId, config.transcriptionApiKeyRef);
      if (transcription) {
        textContent = transcription;

        // Send transcription preview
        await sendMessage(
          ctx,
          token,
          chatId,
          `${escapeMarkdownV2("\ud83c\udfa4")} *Transcription:*\n${escapeMarkdownV2(textContent.slice(0, 500))}${textContent.length > 500 ? escapeMarkdownV2("...") : ""}`,
          {
            parseMode: "MarkdownV2",
            messageThreadId: threadId,
            replyToMessageId: msg.message_id,
          },
        );
      }
    } catch (err) {
      ctx.logger.error("Transcription failed", { error: String(err) });
      textContent = msg.caption ?? "[Audio - transcription failed]";
    }
  }

  if (isIntakeChannel && config.briefAgentId) {
    // Route to Brief Agent via one-shot invocation
    try {
      const prompt = buildBriefPrompt(msg, textContent);
      const { runId } = await ctx.agents.invoke(config.briefAgentId, companyId, {
        prompt,
        reason: "media_intake",
      });

      const hasPublicUrl = config.publicUrl && config.publicUrl.startsWith("https://");
      const inlineKeyboard = hasPublicUrl
        ? [[{ text: "View Run ↗", url: `${config.publicUrl}/agents/${config.briefAgentId}/runs/${runId}` }]]
        : undefined;

      await sendMessage(
        ctx,
        token,
        chatId,
        `${escapeMarkdownV2("\ud83d\udcdd")} Media sent to Brief Agent \\(run: \`${escapeMarkdownV2(runId)}\`\\)`,
        {
          parseMode: "MarkdownV2",
          messageThreadId: threadId,
          replyToMessageId: msg.message_id,
          inlineKeyboard,
        },
      );

      ctx.logger.info("Media routed to brief agent", { runId, briefAgentId: config.briefAgentId });
    } catch (err) {
      ctx.logger.error("Failed to invoke brief agent", { error: String(err) });
      await sendMessage(
        ctx,
        token,
        chatId,
        `Failed to route media to brief agent: ${String(err)}`,
        { messageThreadId: threadId },
      );
    }
  } else if (hasActiveSession && threadId) {
    // Route to the active agent in the thread
    const sessions = await getSessions(ctx, chatId, threadId);
    const activeSessions = sessions.filter((s) => s.status === "active");
    const target = activeSessions.sort(
      (a, b) => new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime(),
    )[0];

    if (target) {
      const mediaLabel = isAudio ? "Audio message" : msg.photo ? "Photo" : "Document";
      const prompt = `[${mediaLabel}] ${textContent || "(no caption)"}`;
      const projectId = await resolveMappedProjectIdForTopic(ctx, chatId, companyId, threadId);

      if (target.transport === "native") {
        await wakeAgentWithIssue(
          ctx,
          target.agentId,
          companyId,
          prompt,
          "media_message",
          projectId,
        );
      } else {
        ctx.events.emit("acp-spawn", companyId, {
          type: "message",
          sessionId: target.sessionId,
          chatId,
          threadId,
          text: prompt,
        });
      }
    }
  }

  await ctx.metrics.write(METRIC_NAMES.mediaProcessed, 1);
  return true;
}

function extractFileId(msg: TelegramMediaMessage): string | null {
  if (msg.voice) return msg.voice.file_id;
  if (msg.audio) return msg.audio.file_id;
  if (msg.video_note) return msg.video_note.file_id;
  if (msg.document) return msg.document.file_id;
  if (msg.photo && msg.photo.length > 0) {
    // Use the largest photo
    return msg.photo.sort((a, b) => b.width * b.height - a.width * a.height)[0]!.file_id;
  }
  return null;
}

async function transcribeAudio(
  ctx: PluginContext,
  botToken: string,
  fileId: string,
  transcriptionApiKeyRef: string,
): Promise<string | null> {
  // 1. Get file path from Telegram (JSON response — ctx.http.fetch works fine for this)
  const fileRes = await ctx.http.fetch(
    `${TELEGRAM_API}/bot${botToken}/getFile?file_id=${fileId}`,
    { method: "GET" },
  );
  const fileData = (await fileRes.json()) as { ok: boolean; result?: { file_path?: string } };
  if (!fileData.ok || !fileData.result?.file_path) {
    ctx.logger.error("Failed to get file path from Telegram", { fileId });
    return null;
  }

  // 2. Download binary audio using native fetch (bypasses RPC bridge UTF-8 corruption)
  const downloadUrl = `${TELEGRAM_API}/file/bot${botToken}/${fileData.result.file_path}`;
  const audioRes = await fetch(downloadUrl);
  const audioBuffer = Buffer.from(await audioRes.arrayBuffer());

  // 3. Resolve the OpenAI API key from Paperclip secrets
  const apiKey = await ctx.secrets.resolve(transcriptionApiKeyRef);

  // 4. Build multipart form data manually (native FormData + Blob works in Node 18+)
  const formData = new FormData();
  formData.append("file", new Blob([audioBuffer], { type: "audio/ogg" }), "audio.ogg");
  formData.append("model", "whisper-1");

  // 5. Send to Whisper API using native fetch (FormData can't be serialized through RPC bridge)
  const whisperRes = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: formData,
  });

  const whisperData = (await whisperRes.json()) as { text?: string };
  return whisperData.text ?? null;
}

function buildBriefPrompt(msg: TelegramMediaMessage, textContent: string): string {
  const parts: string[] = [];

  if (msg.voice) {
    parts.push(`[Voice message, ${msg.voice.duration}s]`);
  } else if (msg.audio) {
    parts.push(`[Audio: ${msg.audio.title ?? "untitled"}, ${msg.audio.duration}s]`);
  } else if (msg.video_note) {
    parts.push(`[Video note, ${msg.video_note.duration}s]`);
  } else if (msg.document) {
    parts.push(`[Document: ${msg.document.file_name ?? "unknown"}]`);
  } else if (msg.photo) {
    parts.push("[Photo]");
  }

  if (textContent) {
    parts.push(textContent);
  }

  const sender = msg.from?.username ?? msg.from?.first_name ?? "unknown";
  parts.push(`\nFrom: ${sender}`);

  return parts.join("\n");
}
