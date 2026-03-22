import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('./env.js', () => ({
  readEnvFile: vi.fn(() => ({})),
}));

import {
  extractVoiceTranscripts,
  buildTranscriptHeader,
  adaptForSpeech,
  generateTTS,
} from './voice-response.js';
import { NewMessage } from './types.js';

function msg(content: string): NewMessage {
  return {
    id: '1',
    chat_jid: 'tg:123',
    sender: '456',
    sender_name: 'Alice',
    content,
    timestamp: '2026-01-01T00:00:00.000Z',
  };
}

describe('extractVoiceTranscripts', () => {
  it('extracts transcript from voice message', () => {
    const result = extractVoiceTranscripts([msg('[Voice: Hello world]')]);
    expect(result).toEqual(['Hello world']);
  });

  it('extracts multiple transcripts', () => {
    const result = extractVoiceTranscripts([
      msg('[Voice: First message]'),
      msg('normal text'),
      msg('[Voice: Second message]'),
    ]);
    expect(result).toEqual(['First message', 'Second message']);
  });

  it('returns empty array when no voice messages', () => {
    const result = extractVoiceTranscripts([
      msg('Hello'),
      msg('[Voice message]'),
      msg('[Photo]'),
    ]);
    expect(result).toEqual([]);
  });

  it('does not match partial patterns', () => {
    const result = extractVoiceTranscripts([
      msg('I said [Voice: something] in my message'),
    ]);
    expect(result).toEqual([]);
  });
});

describe('buildTranscriptHeader', () => {
  it('returns empty string for no transcripts', () => {
    expect(buildTranscriptHeader([])).toBe('');
  });

  it('builds header for single transcript', () => {
    const header = buildTranscriptHeader(['Did this work?']);
    expect(header).toContain('Did this work?');
    expect(header).toContain('🎤');
    expect(header.endsWith('\n\n')).toBe(true);
  });

  it('builds header for multiple transcripts', () => {
    const header = buildTranscriptHeader(['First', 'Second']);
    expect(header).toContain('First');
    expect(header).toContain('Second');
    expect(header).toContain('🎤');
  });
});

describe('adaptForSpeech', () => {
  it('returns null for very short text', async () => {
    const result = await adaptForSpeech('Got it.');
    expect(result).toBeNull();
  });

  // Full integration tests for adaptForSpeech require a running container
  // and credential proxy. Tested manually via voice message flow.
});

describe('generateTTS', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns null when no API key', async () => {
    const result = await generateTTS('Hello', '');
    expect(result).toBeNull();
  });

  it('returns audio buffer on success', async () => {
    const fakeAudio = new ArrayBuffer(1000);
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => fakeAudio,
    }) as any;

    const result = await generateTTS('Hello world', 'test-key');
    expect(result).toBeInstanceOf(Buffer);
    expect(result!.length).toBe(1000);
  });

  it('returns null on API error', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
    }) as any;

    const result = await generateTTS('Hello', 'bad-key');
    expect(result).toBeNull();
  });
});
