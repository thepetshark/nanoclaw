import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { transcribeAudio } from './transcription.js';

describe('transcribeAudio', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('returns transcript on successful API call', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ text: 'Hello world', language_code: 'en' }),
    }) as any;

    const result = await transcribeAudio(
      Buffer.from('fake-audio'),
      'test-key',
    );

    expect(result).toEqual({ text: 'Hello world', language: 'en' });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://api.elevenlabs.io/v1/speech-to-text',
      expect.objectContaining({
        method: 'POST',
        headers: { 'xi-api-key': 'test-key' },
      }),
    );
  });

  it('returns null when no API key', async () => {
    const result = await transcribeAudio(Buffer.from('audio'), '');
    expect(result).toBeNull();
  });

  it('returns null for empty buffer', async () => {
    const result = await transcribeAudio(Buffer.alloc(0), 'test-key');
    expect(result).toBeNull();
  });

  it('returns null for oversized buffer', async () => {
    const big = Buffer.alloc(11 * 1024 * 1024);
    const result = await transcribeAudio(big, 'test-key');
    expect(result).toBeNull();
  });

  it('returns null on API error', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
    }) as any;

    const result = await transcribeAudio(
      Buffer.from('fake-audio'),
      'bad-key',
    );
    expect(result).toBeNull();
  });

  it('returns null on empty transcript', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ text: '' }),
    }) as any;

    const result = await transcribeAudio(
      Buffer.from('fake-audio'),
      'test-key',
    );
    expect(result).toBeNull();
  });

  it('returns null on network error', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(
      new Error('Network failure'),
    ) as any;

    const result = await transcribeAudio(
      Buffer.from('fake-audio'),
      'test-key',
    );
    expect(result).toBeNull();
  });

  it('passes language option when specified', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ text: 'Bonjour', language_code: 'fr' }),
    }) as any;

    const result = await transcribeAudio(
      Buffer.from('fake-audio'),
      'test-key',
      { language: 'fr' },
    );

    expect(result).toEqual({ text: 'Bonjour', language: 'fr' });
  });
});
