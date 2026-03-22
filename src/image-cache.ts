/**
 * In-memory cache for image attachments.
 *
 * Images are too large to store in SQLite. This cache holds processed images
 * keyed by chat JID + message ID, with automatic TTL expiry so they don't
 * accumulate indefinitely. Images are consumed (deleted) after being read.
 */
import { MessageImage } from './types.js';

interface CachedImages {
  images: MessageImage[];
  expiresAt: number;
}

const TTL_MS = 5 * 60 * 1000; // 5 minutes
const cache = new Map<string, CachedImages>();

function key(chatJid: string, messageId: string): string {
  return `${chatJid}:${messageId}`;
}

export function storeImages(
  chatJid: string,
  messageId: string,
  images: MessageImage[],
): void {
  cache.set(key(chatJid, messageId), {
    images,
    expiresAt: Date.now() + TTL_MS,
  });
}

/**
 * Retrieve and consume images for a message.
 * Returns the images and removes them from the cache.
 */
export function consumeImages(
  chatJid: string,
  messageId: string,
): MessageImage[] | undefined {
  const k = key(chatJid, messageId);
  const entry = cache.get(k);
  if (!entry) return undefined;
  cache.delete(k);
  if (entry.expiresAt < Date.now()) return undefined;
  return entry.images;
}

/**
 * Collect all cached images for a set of messages.
 * Consumes them from the cache.
 */
export function collectImages(
  messages: Array<{ chat_jid: string; id: string }>,
): MessageImage[] {
  const result: MessageImage[] = [];
  for (const msg of messages) {
    const images = consumeImages(msg.chat_jid, msg.id);
    if (images) result.push(...images);
  }
  return result;
}

/**
 * Peek at cached images for a set of messages without consuming them.
 */
export function peekImages(
  messages: Array<{ chat_jid: string; id: string }>,
): MessageImage[] {
  const now = Date.now();
  const result: MessageImage[] = [];
  for (const msg of messages) {
    const entry = cache.get(key(msg.chat_jid, msg.id));
    if (entry && entry.expiresAt >= now) result.push(...entry.images);
  }
  return result;
}

/** Purge expired entries. Called periodically. */
export function pruneExpired(): void {
  const now = Date.now();
  for (const [k, entry] of cache) {
    if (entry.expiresAt < now) cache.delete(k);
  }
}
