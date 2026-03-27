import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { processImageBuffer, downloadAndProcessImage } from './image.js';

// Create a minimal valid JPEG buffer (smallest possible JPEG)
function makeTestJpeg(width = 100, height = 100): Buffer {
  // We can't create a real JPEG without sharp, so we'll use sharp in tests
  // For unit tests, we rely on sharp being available
  return Buffer.alloc(0); // placeholder — real tests use sharp
}

describe('processImageBuffer', () => {
  it('returns null for empty buffer', async () => {
    const result = await processImageBuffer(Buffer.alloc(0));
    expect(result).toBeNull();
  });

  it('returns null for invalid image data', async () => {
    const result = await processImageBuffer(Buffer.from('not an image'));
    expect(result).toBeNull();
  });

  it('processes a valid image and returns base64 jpeg', async () => {
    // Create a small test image using sharp
    const sharp = (await import('sharp')).default;
    const testImage = await sharp({
      create: {
        width: 200,
        height: 200,
        channels: 3,
        background: { r: 255, g: 0, b: 0 },
      },
    })
      .png()
      .toBuffer();

    const result = await processImageBuffer(testImage);
    expect(result).not.toBeNull();
    expect(result!.mediaType).toBe('image/jpeg');
    expect(result!.base64).toBeTruthy();
    // Verify it's valid base64
    expect(() => Buffer.from(result!.base64, 'base64')).not.toThrow();
  });

  it('resizes images larger than max dimension', async () => {
    const sharp = (await import('sharp')).default;
    const largeImage = await sharp({
      create: {
        width: 3000,
        height: 2000,
        channels: 3,
        background: { r: 0, g: 255, b: 0 },
      },
    })
      .png()
      .toBuffer();

    const result = await processImageBuffer(largeImage);
    expect(result).not.toBeNull();

    // Decode and check dimensions
    const decoded = Buffer.from(result!.base64, 'base64');
    const metadata = await sharp(decoded).metadata();
    expect(metadata.width).toBeLessThanOrEqual(1568);
    expect(metadata.height).toBeLessThanOrEqual(1568);
  });

  it('preserves small images without enlargement', async () => {
    const sharp = (await import('sharp')).default;
    const smallImage = await sharp({
      create: {
        width: 50,
        height: 50,
        channels: 3,
        background: { r: 0, g: 0, b: 255 },
      },
    })
      .png()
      .toBuffer();

    const result = await processImageBuffer(smallImage);
    expect(result).not.toBeNull();

    const decoded = Buffer.from(result!.base64, 'base64');
    const metadata = await sharp(decoded).metadata();
    expect(metadata.width).toBe(50);
    expect(metadata.height).toBe(50);
  });
});

describe('downloadAndProcessImage', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('returns null on HTTP error', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      headers: new Headers(),
    }) as any;

    const result = await downloadAndProcessImage('https://example.com/img.jpg');
    expect(result).toBeNull();
  });

  it('returns null when content-length exceeds limit', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-length': '100000000' }),
      arrayBuffer: async () => new ArrayBuffer(0),
    }) as any;

    const result = await downloadAndProcessImage(
      'https://example.com/huge.jpg',
    );
    expect(result).toBeNull();
  });

  it('returns null on network error', async () => {
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new Error('network error')) as any;

    const result = await downloadAndProcessImage('https://example.com/img.jpg');
    expect(result).toBeNull();
  });

  it('downloads and processes a valid image', async () => {
    const sharp = (await import('sharp')).default;
    const testImage = await sharp({
      create: {
        width: 100,
        height: 100,
        channels: 3,
        background: { r: 128, g: 128, b: 128 },
      },
    })
      .jpeg()
      .toBuffer();

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-length': testImage.length.toString() }),
      arrayBuffer: async () =>
        testImage.buffer.slice(
          testImage.byteOffset,
          testImage.byteOffset + testImage.byteLength,
        ),
    }) as any;

    const result = await downloadAndProcessImage('https://example.com/img.jpg');
    expect(result).not.toBeNull();
    expect(result!.mediaType).toBe('image/jpeg');
  });
});
