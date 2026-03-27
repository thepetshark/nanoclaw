import { describe, it, expect, vi, afterEach } from 'vitest';

import {
  storeImages,
  consumeImages,
  collectImages,
  pruneExpired,
} from './image-cache.js';

describe('image-cache', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const testImage = { base64: 'abc123', mediaType: 'image/jpeg' as const };

  it('stores and consumes images', () => {
    storeImages('chat1', 'msg1', [testImage]);
    const result = consumeImages('chat1', 'msg1');
    expect(result).toEqual([testImage]);
  });

  it('returns undefined for unknown messages', () => {
    expect(consumeImages('chat1', 'unknown')).toBeUndefined();
  });

  it('consumes images only once', () => {
    storeImages('chat1', 'msg2', [testImage]);
    consumeImages('chat1', 'msg2');
    expect(consumeImages('chat1', 'msg2')).toBeUndefined();
  });

  it('collects images from multiple messages', () => {
    const img2 = { base64: 'def456', mediaType: 'image/png' as const };
    storeImages('chat1', 'msg3', [testImage]);
    storeImages('chat1', 'msg4', [img2]);

    const result = collectImages([
      { chat_jid: 'chat1', id: 'msg3' },
      { chat_jid: 'chat1', id: 'msg4' },
      { chat_jid: 'chat1', id: 'msg5' }, // no images
    ]);

    expect(result).toEqual([testImage, img2]);
  });

  it('returns empty array when no images cached', () => {
    const result = collectImages([{ chat_jid: 'chat1', id: 'none' }]);
    expect(result).toEqual([]);
  });

  it('prunes expired entries', () => {
    storeImages('chat1', 'msg6', [testImage]);
    // Fast-forward time past TTL
    vi.useFakeTimers();
    vi.advanceTimersByTime(6 * 60 * 1000); // 6 minutes > 5 min TTL
    pruneExpired();
    vi.useRealTimers();
    expect(consumeImages('chat1', 'msg6')).toBeUndefined();
  });
});
