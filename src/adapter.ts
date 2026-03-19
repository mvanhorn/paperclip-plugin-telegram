import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  sendMessage,
  editMessage as editTelegramMessage,
  escapeMarkdownV2,
} from "./telegram-api.js";
import type { SendMessageOptions } from "./telegram-api.js";

export type MessageRef = {
  chatId: string;
  threadId: string;
  messageId: string;
};

export type ActionButton = {
  label: string;
  callbackData: string;
};

export type SendOpts = {
  replyTo?: string;
  silent?: boolean;
};

export interface PlatformAdapter {
  platformId: string;
  sendText(chatId: string, threadId: string | undefined, text: string, opts?: SendOpts): Promise<MessageRef>;
  sendButtons(chatId: string, threadId: string | undefined, text: string, buttons: ActionButton[]): Promise<MessageRef>;
  editMessage(ref: MessageRef, text: string, buttons?: ActionButton[]): Promise<void>;
  formatAgentLabel(agentName: string): string;
  formatMention(userId: string): string;
  formatCodeBlock(code: string, lang?: string): string;
}

export class TelegramAdapter implements PlatformAdapter {
  platformId = "telegram" as const;

  constructor(
    private ctx: PluginContext,
    private botToken: string,
  ) {}

  async sendText(
    chatId: string,
    threadId: string | undefined,
    text: string,
    opts?: SendOpts,
  ): Promise<MessageRef> {
    const options: SendMessageOptions = {
      parseMode: "MarkdownV2",
    };
    if (threadId) options.messageThreadId = Number(threadId);
    if (opts?.replyTo) options.replyToMessageId = Number(opts.replyTo);
    if (opts?.silent) options.disableNotification = true;

    const messageId = await sendMessage(this.ctx, this.botToken, chatId, text, options);
    return {
      chatId,
      threadId: threadId || "",
      messageId: String(messageId ?? ""),
    };
  }

  async sendButtons(
    chatId: string,
    threadId: string | undefined,
    text: string,
    buttons: ActionButton[],
  ): Promise<MessageRef> {
    const keyboard = [];
    for (let i = 0; i < buttons.length; i += 2) {
      const row = buttons.slice(i, i + 2).map((b) => ({
        text: b.label,
        callback_data: b.callbackData,
      }));
      keyboard.push(row);
    }

    const options: SendMessageOptions = {
      parseMode: "MarkdownV2",
      inlineKeyboard: keyboard,
    };
    if (threadId) options.messageThreadId = Number(threadId);

    const messageId = await sendMessage(this.ctx, this.botToken, chatId, text, options);
    return {
      chatId,
      threadId: threadId || "",
      messageId: String(messageId ?? ""),
    };
  }

  async editMessage(ref: MessageRef, text: string, buttons?: ActionButton[]): Promise<void> {
    const keyboard = buttons
      ? (() => {
          const rows = [];
          for (let i = 0; i < buttons.length; i += 2) {
            const row = buttons.slice(i, i + 2).map((b) => ({
              text: b.label,
              callback_data: b.callbackData,
            }));
            rows.push(row);
          }
          return rows;
        })()
      : undefined;

    await editTelegramMessage(
      this.ctx,
      this.botToken,
      ref.chatId,
      Number(ref.messageId),
      text,
      { parseMode: "MarkdownV2", inlineKeyboard: keyboard },
    );
  }

  formatAgentLabel(agentName: string): string {
    return `*\\[${escapeMarkdownV2(agentName)}\\]*`;
  }

  formatMention(userId: string): string {
    return `@${escapeMarkdownV2(userId)}`;
  }

  formatCodeBlock(code: string, lang?: string): string {
    return lang ? `\`\`\`${lang}\n${code}\n\`\`\`` : `\`\`\`\n${code}\n\`\`\``;
  }
}
