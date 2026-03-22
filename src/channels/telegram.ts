import https from 'https';
import { Api, Bot, InputFile } from 'grammy';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { processImageBuffer } from '../image.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import { transcribeAudio } from '../transcription.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

const MAX_VOICE_DOWNLOAD_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_IMAGE_DOWNLOAD_BYTES = 20 * 1024 * 1024; // 20 MB

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

/**
 * Send a message with Telegram Markdown parse mode, falling back to plain text.
 * Claude's output naturally matches Telegram's Markdown v1 format:
 *   *bold*, _italic_, `code`, ```code blocks```, [links](url)
 */
async function sendTelegramMessage(
  api: { sendMessage: Api['sendMessage'] },
  chatId: string | number,
  text: string,
  options: { message_thread_id?: number } = {},
): Promise<void> {
  try {
    await api.sendMessage(chatId, text, {
      ...options,
      parse_mode: 'Markdown',
    });
  } catch (err) {
    // Fallback: send as plain text if Markdown parsing fails
    logger.debug({ err }, 'Markdown send failed, falling back to plain text');
    await api.sendMessage(chatId, text, options);
  }
}

/**
 * Build a JID from a chat ID and optional forum topic thread ID.
 * Telegram's General topic (thread 1) omits message_thread_id from messages.
 * When topic-based JIDs are registered for a group, treat missing thread ID
 * as General topic (1) so messages route correctly.
 */
function buildJid(
  chatId: number,
  threadId: number | undefined,
  registeredGroups?: Record<string, unknown>,
): string {
  if (threadId) return `tg:${chatId}:${threadId}`;
  if (registeredGroups) {
    const prefix = `tg:${chatId}:`;
    const hasTopicRegistrations = Object.keys(registeredGroups).some((jid) =>
      jid.startsWith(prefix),
    );
    if (hasTopicRegistrations) return `tg:${chatId}:1`;
  }
  return `tg:${chatId}`;
}

/**
 * Parse a topic-aware JID into chat ID and optional thread ID.
 * Thread ID 1 is Telegram's General topic — it doesn't accept
 * message_thread_id on outbound API calls, so we omit it.
 */
function parseJid(jid: string): { chatId: string; threadId?: number } {
  const raw = jid.replace(/^tg:/, '');
  const colonIdx = raw.indexOf(':');
  if (colonIdx === -1) return { chatId: raw };
  const threadId = parseInt(raw.slice(colonIdx + 1), 10);
  return {
    chatId: raw.slice(0, colonIdx),
    threadId: threadId === 1 ? undefined : threadId,
  };
}

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;
  private elevenLabsApiKey: string;

  constructor(
    botToken: string,
    opts: TelegramChannelOpts,
    elevenLabsApiKey = '',
  ) {
    this.botToken = botToken;
    this.opts = opts;
    this.elevenLabsApiKey = elevenLabsApiKey;
  }

  /**
   * Download a file from Telegram's servers by file_id.
   * Retries once on transient network errors (ETIMEDOUT, etc.).
   * Returns the file contents as a Buffer, or null on failure.
   */
  private async downloadTelegramFile(
    fileId: string,
    maxBytes = MAX_VOICE_DOWNLOAD_BYTES,
  ): Promise<Buffer | null> {
    const maxAttempts = 2;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const file = await this.bot!.api.getFile(fileId);
        if (!file.file_path) {
          logger.warn({ fileId }, 'Telegram getFile returned no file_path');
          return null;
        }

        const url = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
        const res = await fetch(url, {
          signal: AbortSignal.timeout(30_000),
        });
        if (!res.ok) {
          logger.warn(
            { fileId, status: res.status },
            'Failed to download Telegram file',
          );
          return null;
        }

        const contentLength = Number(res.headers.get('content-length') ?? 0);
        if (contentLength > maxBytes) {
          logger.warn(
            { fileId, contentLength },
            'Telegram file too large, skipping',
          );
          return null;
        }

        const arrayBuffer = await res.arrayBuffer();
        if (arrayBuffer.byteLength > maxBytes) {
          logger.warn(
            { fileId, bytes: arrayBuffer.byteLength },
            'Telegram file too large, skipping',
          );
          return null;
        }

        return Buffer.from(arrayBuffer);
      } catch (err) {
        if (attempt < maxAttempts) {
          logger.warn(
            { fileId, attempt, err },
            'Telegram file download failed, retrying',
          );
          await new Promise((r) => setTimeout(r, 1000));
          continue;
        }
        logger.error({ fileId, err }, 'Telegram file download error');
        return null;
      }
    }

    return null;
  }

  async connect(): Promise<void> {
    this.bot = new Bot(this.botToken, {
      client: {
        baseFetchConfig: { agent: https.globalAgent, compress: true },
      },
    });

    // Command to get chat ID (useful for registration)
    this.bot.command('chatid', (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const threadId = ctx.message?.message_thread_id;
      const jid = buildJid(chatId, threadId);
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as any).title || 'Unknown';

      const lines = [
        `Chat ID: \`${jid}\``,
        `Name: ${chatName}`,
        `Type: ${chatType}`,
      ];
      if (threadId) lines.push(`Topic: ${threadId}`);
      ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
    });

    // Command to check bot status
    this.bot.command('ping', (ctx) => {
      ctx.reply(`${ASSISTANT_NAME} is online.`);
    });

    // Telegram bot commands handled above — skip them in the general handler
    // so they don't also get stored as messages. All other /commands flow through.
    const TELEGRAM_BOT_COMMANDS = new Set(['chatid', 'ping']);

    this.bot.on('message:text', async (ctx) => {
      if (ctx.message.text.startsWith('/')) {
        const cmd = ctx.message.text.slice(1).split(/[\s@]/)[0].toLowerCase();
        if (TELEGRAM_BOT_COMMANDS.has(cmd)) return;
      }

      const chatJid = buildJid(
        ctx.chat.id,
        ctx.message.message_thread_id,
        this.opts.registeredGroups(),
      );
      let content = ctx.message.text;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';
      const sender = ctx.from?.id.toString() || '';
      const msgId = ctx.message.message_id.toString();

      // Determine chat name
      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : (ctx.chat as any).title || chatJid;

      // Translate Telegram @bot_username mentions into TRIGGER_PATTERN format.
      // Telegram @mentions (e.g., @andy_ai_bot) won't match TRIGGER_PATTERN
      // (e.g., ^@Andy\b), so we prepend the trigger when the bot is @mentioned.
      const botUsername = ctx.me?.username?.toLowerCase();
      if (botUsername) {
        const entities = ctx.message.entities || [];
        const isBotMentioned = entities.some((entity) => {
          if (entity.type === 'mention') {
            const mentionText = content
              .substring(entity.offset, entity.offset + entity.length)
              .toLowerCase();
            return mentionText === `@${botUsername}`;
          }
          return false;
        });
        if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // Store chat metadata for discovery
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'telegram',
        isGroup,
      );

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Telegram chat',
        );
        return;
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Telegram message stored',
      );
    });

    // Handle non-text messages with placeholders so the agent knows something was sent
    const storeNonText = (ctx: any, placeholder: string) => {
      const chatJid = buildJid(
        ctx.chat.id,
        ctx.message?.message_thread_id,
        this.opts.registeredGroups(),
      );
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';

      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );
      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content: `${placeholder}${caption}`,
        timestamp,
        is_from_me: false,
      });
    };

    this.bot.on('message:photo', async (ctx) => {
      const chatJid = buildJid(
        ctx.chat.id,
        ctx.message.message_thread_id,
        this.opts.registeredGroups(),
      );
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';

      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );

      // Telegram provides multiple photo sizes — pick the largest
      const photos = ctx.message.photo;
      const largest = photos[photos.length - 1];
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';
      let content = `[Photo]${caption}`;
      let images: import('../types.js').MessageImage[] | undefined;

      const buffer = await this.downloadTelegramFile(
        largest.file_id,
        MAX_IMAGE_DOWNLOAD_BYTES,
      );
      if (buffer) {
        const processed = await processImageBuffer(buffer);
        if (processed) {
          images = [{ base64: processed.base64, mediaType: processed.mediaType }];
          content = caption.trim() || '[Photo]';
          logger.info(
            { chatJid, sender: senderName, bytes: buffer.length },
            'Processed Telegram image attachment',
          );
        } else {
          content = `[Photo — processing failed]${caption}`;
        }
      } else {
        content = `[Photo — download failed]${caption}`;
      }

      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
        images,
      });
    });
    this.bot.on('message:video', (ctx) => storeNonText(ctx, '[Video]'));
    this.bot.on('message:voice', async (ctx) => {
      const chatJid = buildJid(
        ctx.chat.id,
        ctx.message.message_thread_id,
        this.opts.registeredGroups(),
      );
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';

      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );

      let content = '[Voice message]';

      if (this.elevenLabsApiKey) {
        const audioBuffer = await this.downloadTelegramFile(
          ctx.message.voice.file_id,
        );
        if (audioBuffer) {
          const result = await transcribeAudio(
            audioBuffer,
            this.elevenLabsApiKey,
          );
          if (result) {
            content = `[Voice: ${result.text}]`;
          } else {
            content = '[Voice message — transcription failed]';
          }
        } else {
          content = '[Voice message — download failed]';
        }
      }

      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });
    });
    this.bot.on('message:video_note', (ctx) =>
      storeNonText(ctx, '[Video note]'),
    );
    this.bot.on('message:audio', (ctx) => storeNonText(ctx, '[Audio]'));
    this.bot.on('message:document', (ctx) => {
      const name = ctx.message.document?.file_name || 'file';
      storeNonText(ctx, `[Document: ${name}]`);
    });
    this.bot.on('message:sticker', (ctx) => {
      const emoji = ctx.message.sticker?.emoji || '';
      storeNonText(ctx, `[Sticker ${emoji}]`);
    });
    this.bot.on('message:location', (ctx) => storeNonText(ctx, '[Location]'));
    this.bot.on('message:contact', (ctx) => storeNonText(ctx, '[Contact]'));

    // Handle errors gracefully
    this.bot.catch((err) => {
      logger.error({ err: err.message }, 'Telegram bot error');
    });

    // Start polling — returns a Promise that resolves when started
    return new Promise<void>((resolve) => {
      this.bot!.start({
        onStart: (botInfo) => {
          logger.info(
            { username: botInfo.username, id: botInfo.id },
            'Telegram bot connected',
          );
          console.log(`\n  Telegram bot: @${botInfo.username}`);
          console.log(
            `  Send /chatid to the bot to get a chat's registration ID\n`,
          );
          resolve();
        },
      });
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const { chatId, threadId } = parseJid(jid);
      const options = threadId ? { message_thread_id: threadId } : {};

      // Telegram has a 4096 character limit per message — split if needed
      const MAX_LENGTH = 4096;
      if (text.length <= MAX_LENGTH) {
        await sendTelegramMessage(this.bot.api, chatId, text, options);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await sendTelegramMessage(
            this.bot.api,
            chatId,
            text.slice(i, i + MAX_LENGTH),
            options,
          );
        }
      }
      logger.info({ jid, length: text.length }, 'Telegram message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram message');
    }
  }

  isConnected(): boolean {
    return this.bot !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async disconnect(): Promise<void> {
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
      logger.info('Telegram bot stopped');
    }
  }

  async setTyping(
    jid: string,
    isTyping: boolean,
    action: 'typing' | 'record_voice' = 'typing',
  ): Promise<void> {
    if (!this.bot || !isTyping) return;
    try {
      const { chatId, threadId } = parseJid(jid);
      const options = threadId ? { message_thread_id: threadId } : {};
      await this.bot.api.sendChatAction(chatId, action, options);
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
    }
  }

  async sendVoice(jid: string, audio: Buffer): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }
    try {
      const { chatId, threadId } = parseJid(jid);
      const options = threadId ? { message_thread_id: threadId } : {};
      await this.bot.api.sendVoice(
        chatId,
        new InputFile(audio, 'voice.ogg'),
        options,
      );
      logger.info({ jid }, 'Telegram voice message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram voice message');
    }
  }
}

registerChannel('telegram', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['TELEGRAM_BOT_TOKEN', 'ELEVENLABS_API_KEY']);
  const token =
    process.env.TELEGRAM_BOT_TOKEN || envVars.TELEGRAM_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Telegram: TELEGRAM_BOT_TOKEN not set');
    return null;
  }
  const elevenLabsKey =
    process.env.ELEVENLABS_API_KEY || envVars.ELEVENLABS_API_KEY || '';
  if (!elevenLabsKey) {
    logger.info(
      'Telegram: ELEVENLABS_API_KEY not set — voice messages will not be transcribed',
    );
  }
  return new TelegramChannel(token, opts, elevenLabsKey);
});
