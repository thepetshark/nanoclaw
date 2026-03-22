/**
 * Image processing for NanoClaw.
 *
 * Downloads images from a URL or Buffer, resizes them to fit Claude API limits,
 * and returns base64-encoded data with the appropriate media type.
 */
import sharp from 'sharp';

import { logger } from './logger.js';

/** Maximum dimension (width or height) for images sent to the Claude API. */
const MAX_DIMENSION = 1568;
/** Maximum file size in bytes after resize (~ 5 MB base64 ≈ 3.75 MB raw). */
const MAX_BYTES = 3.75 * 1024 * 1024;
/** Maximum download size from remote URLs. */
const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;

export type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

export interface ProcessedImage {
  base64: string;
  mediaType: ImageMediaType;
}

/**
 * Process an image buffer: resize to fit Claude API limits and encode as base64.
 * Returns null on failure (logged, never throws).
 */
export async function processImageBuffer(
  buffer: Buffer,
): Promise<ProcessedImage | null> {
  try {
    const img = sharp(buffer);
    const metadata = await img.metadata();

    if (!metadata.width || !metadata.height) {
      logger.warn('Image has no dimensions, skipping');
      return null;
    }

    // Resize if either dimension exceeds the limit
    let pipeline = img;
    if (metadata.width > MAX_DIMENSION || metadata.height > MAX_DIMENSION) {
      pipeline = pipeline.resize(MAX_DIMENSION, MAX_DIMENSION, {
        fit: 'inside',
        withoutEnlargement: true,
      });
    }

    // Convert to JPEG for consistent output and smaller size
    let output = await pipeline.jpeg({ quality: 85 }).toBuffer();

    // If still too large, reduce quality
    if (output.length > MAX_BYTES) {
      output = await sharp(buffer)
        .resize(MAX_DIMENSION, MAX_DIMENSION, {
          fit: 'inside',
          withoutEnlargement: true,
        })
        .jpeg({ quality: 60 })
        .toBuffer();
    }

    if (output.length > MAX_BYTES) {
      logger.warn(
        { bytes: output.length },
        'Image still too large after quality reduction, skipping',
      );
      return null;
    }

    return {
      base64: output.toString('base64'),
      mediaType: 'image/jpeg',
    };
  } catch (err) {
    logger.error({ err }, 'Image processing failed');
    return null;
  }
}

/**
 * Download an image from a URL and process it.
 * Returns null on failure.
 */
export async function downloadAndProcessImage(
  url: string,
): Promise<ProcessedImage | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      logger.warn({ url, status: res.status }, 'Image download failed');
      return null;
    }

    const contentLength = Number(res.headers.get('content-length') ?? 0);
    if (contentLength > MAX_DOWNLOAD_BYTES) {
      logger.warn({ url, contentLength }, 'Image too large to download');
      return null;
    }

    const arrayBuffer = await res.arrayBuffer();
    if (arrayBuffer.byteLength > MAX_DOWNLOAD_BYTES) {
      logger.warn({ url, bytes: arrayBuffer.byteLength }, 'Image too large');
      return null;
    }

    return processImageBuffer(Buffer.from(arrayBuffer));
  } catch (err) {
    logger.error({ url, err }, 'Image download error');
    return null;
  }
}
