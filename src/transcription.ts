/**
 * Voice transcription via ElevenLabs Scribe v2.
 *
 * Channel-agnostic: accepts a Buffer of audio data and returns a transcript.
 * Supports OGG/Opus (Telegram), M4A (WhatsApp), MP3, WAV, and most audio/video formats.
 * ElevenLabs Scribe v2 handles format detection automatically — no ffmpeg needed.
 */
import { logger } from './logger.js';

const STT_ENDPOINT = 'https://api.elevenlabs.io/v1/speech-to-text';
const STT_MODEL = 'scribe_v2';
const MAX_VOICE_BYTES = 10 * 1024 * 1024; // 10 MB safety limit

export interface TranscriptionResult {
  text: string;
  language?: string;
}

/**
 * Transcribe audio using ElevenLabs Scribe v2.
 * Returns the transcript text, or null on failure.
 */
export async function transcribeAudio(
  audioBuffer: Buffer,
  apiKey: string,
  options?: { language?: string },
): Promise<TranscriptionResult | null> {
  if (!apiKey) {
    logger.debug('No ElevenLabs API key, skipping transcription');
    return null;
  }

  if (audioBuffer.length === 0) {
    logger.warn('Empty audio buffer, skipping transcription');
    return null;
  }

  if (audioBuffer.length > MAX_VOICE_BYTES) {
    logger.warn(
      { bytes: audioBuffer.length },
      'Audio too large to transcribe, skipping',
    );
    return null;
  }

  try {
    const formData = new FormData();
    formData.append('model_id', STT_MODEL);
    formData.append(
      'file',
      new Blob([audioBuffer]),
      'voice.ogg',
    );
    formData.append('tag_audio_events', 'false');

    if (options?.language) {
      formData.append('language_code', options.language);
    }

    const response = await fetch(STT_ENDPOINT, {
      method: 'POST',
      headers: { 'xi-api-key': apiKey },
      body: formData,
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      logger.warn(
        { status: response.status, body: body.slice(0, 200) },
        'ElevenLabs transcription failed',
      );
      return null;
    }

    const data = (await response.json()) as {
      text?: string;
      language_code?: string;
    };
    const text = data.text?.trim();

    if (!text) {
      logger.debug('ElevenLabs returned empty transcript');
      return null;
    }

    logger.info(
      { chars: text.length, language: data.language_code },
      'Transcribed voice message',
    );

    return {
      text,
      language: data.language_code,
    };
  } catch (err) {
    logger.error({ err }, 'Voice transcription error');
    return null;
  }
}
