/**
 * Voice Response Module for NanoClaw
 *
 * Handles the outbound voice response pipeline:
 * 1. Detect if inbound messages contained voice transcriptions
 * 2. Adapt the agent's text response for speech (via Claude Haiku)
 * 3. Generate OGG/Opus audio via ElevenLabs TTS
 *
 * All voice logic runs at the host level — agents are unaware of voice.
 *
 * TTS config is read from ~/.config/nanoclaw/voice.json.
 * Falls back to built-in defaults if the config file doesn't exist.
 * Uses the same format as OpenClaw's ~/.config/elevenlabs/config.json
 * for easy portability, but stored separately so NanoClaw is self-contained.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { logger } from './logger.js';
import { NewMessage, RegisteredGroup } from './types.js';

const ELEVENLABS_TTS_ENDPOINT = 'https://api.elevenlabs.io/v1/text-to-speech';

// Built-in defaults (used when config file doesn't exist)
const DEFAULT_VOICE_ID = 'JBFqnCBsd6RMkjVDRZzb'; // George
const DEFAULT_MODEL = 'eleven_turbo_v2_5';
const DEFAULT_SPEED = 1.0;

export interface VoiceConfig {
  default_voice?: string;
  current_voice?: string;
  model?: string;
  speed?: number;
  voices?: Record<string, string>;
}

let cachedConfig: VoiceConfig | null = null;

/**
 * Load voice config from ~/.config/nanoclaw/voice.json.
 * Same format as OpenClaw's config for portability.
 */
export function loadVoiceConfig(): VoiceConfig {
  if (cachedConfig) return cachedConfig;

  const configPath = path.join(
    os.homedir(),
    '.config',
    'nanoclaw',
    'voice.json',
  );

  try {
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, 'utf-8');
      cachedConfig = JSON.parse(content) as VoiceConfig;
      logger.info(
        {
          voice: cachedConfig.current_voice || cachedConfig.default_voice,
          model: cachedConfig.model,
        },
        'Loaded voice config',
      );
      return cachedConfig;
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to load voice config, using defaults');
  }

  cachedConfig = {};
  return cachedConfig;
}

/** Resolve the current voice ID from config. */
export function resolveVoiceId(): string {
  const config = loadVoiceConfig();
  const voiceName = config.current_voice || config.default_voice;

  if (voiceName && config.voices?.[voiceName]) {
    return config.voices[voiceName];
  }

  // voiceName might be a raw ID
  if (voiceName && voiceName.length > 10) return voiceName;

  return DEFAULT_VOICE_ID;
}

/** Resolve the TTS model from config. */
function resolveModel(): string {
  return loadVoiceConfig().model || DEFAULT_MODEL;
}

/** Resolve the speech speed from config. */
function resolveSpeed(): number {
  return loadVoiceConfig().speed || DEFAULT_SPEED;
}

const VOICE_TRANSCRIPT_PATTERN = /^\[Voice: (.+)\]$/s;

/**
 * Extract voice transcripts from a batch of inbound messages.
 * Returns the transcripts (in order) or empty array if no voice messages.
 */
export function extractVoiceTranscripts(messages: NewMessage[]): string[] {
  const transcripts: string[] = [];
  for (const msg of messages) {
    const match = msg.content.match(VOICE_TRANSCRIPT_PATTERN);
    if (match) {
      transcripts.push(match[1]);
    }
  }
  return transcripts;
}

/**
 * Build the transcript header to prepend to the agent's text response.
 * Shows what the user said via voice so it's visible in conversation history.
 */
export function buildTranscriptHeader(transcripts: string[]): string {
  if (transcripts.length === 0) return '';
  if (transcripts.length === 1) {
    return `> 🎤 _"${transcripts[0]}"_\n\n`;
  }
  // Multiple voice messages in one batch
  const lines = transcripts.map((t) => `> _"${t}"_`).join('\n');
  return `> 🎤\n${lines}\n\n`;
}

const ADAPT_PROMPT_TEMPLATE = `TASK: Adapt the provided text for spoken delivery. DO NOT answer, discuss, or respond to the content. DO NOT use any tools. Reply with ONLY the rewritten text and nothing else.

RULES:
- Strip: code blocks, inline code, URLs, markdown formatting, tables, JSON, file paths, command output, logs
- For code: say "I've included that in the text"
- For URLs: say "I'll include the link" or skip
- For tables: summarize the key points conversationally
- Keep: core meaning, explanations, reasoning, opinions, personality, humor
- Style: conversational, as if speaking across a desk. Short sentences. Natural pauses.
- Don't say "here's" or "below" (no visual reference in speech)
- Don't enumerate with numbers unless it's truly a sequence
- Contractions are fine (it's, don't, won't)
- 2-4 sentences for simple responses, longer for substantive ones
- If the input is ≤15 words or a pure acknowledgment, reply exactly: NO_SPEAK

TEXT TO REWRITE:
"""
{TEXT}
"""`;

/**
 * Adapt a text response for spoken delivery using a lightweight container.
 * Spawns a one-shot container that runs Claude Haiku via the SDK (handles OAuth).
 * Returns the adapted text, or null if the response shouldn't be spoken.
 */
export async function adaptForSpeech(text: string): Promise<string | null> {
  // Quick check: skip very short responses without spawning a container
  const wordCount = text.trim().split(/\s+/).length;
  if (wordCount <= 10) return null;

  try {
    const { runContainerAgent } = await import('./container-runner.js');

    const adapterGroup: RegisteredGroup = {
      name: 'voice-adapter',
      folder: 'voice-adapter',
      trigger: '',
      added_at: new Date().toISOString(),
      isMain: false,
      requiresTrigger: false,
      containerConfig: {
        timeout: 30_000, // 30 seconds max
      },
    };

    const prompt = ADAPT_PROMPT_TEMPLATE.replace('{TEXT}', text);

    // Resolve on the first streaming output — don't wait for container exit.
    // The container enters an IPC wait loop after responding, so awaiting
    // runContainerAgent would block for the full idle timeout (30+ min).
    const adaptedText = await new Promise<string | null>((resolve) => {
      let resolved = false;
      let containerProc: import('child_process').ChildProcess | null = null;
      let containerName = '';

      runContainerAgent(
        adapterGroup,
        {
          prompt,
          groupFolder: 'voice-adapter',
          chatJid: 'internal:voice-adapter',
          isMain: false,
        },
        (proc, name) => {
          containerProc = proc;
          containerName = name;
        },
        async (result) => {
          if (resolved) return;
          if (result.result) {
            resolved = true;
            const text = (
              typeof result.result === 'string'
                ? result.result
                : JSON.stringify(result.result)
            )
              .replace(/<internal>[\s\S]*?<\/internal>/g, '')
              .trim();
            resolve(text || null);

            // Kill the container — we have our result
            if (containerName) {
              const { stopContainer, CONTAINER_RUNTIME_BIN } =
                await import('./container-runtime.js');
              const { exec } = await import('child_process');
              exec(stopContainer(containerName), { timeout: 10_000 });
            }
          }
          if (result.status === 'error' && !resolved) {
            resolved = true;
            resolve(null);
          }
        },
      ).catch((err) => {
        if (!resolved) {
          resolved = true;
          logger.error({ err }, 'Voice adapter container error');
          resolve(null);
        }
      });

      // Safety timeout — don't wait forever
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          logger.warn('Voice adapter timed out');
          resolve(null);
          if (containerName) {
            import('./container-runtime.js').then(({ stopContainer }) => {
              import('child_process').then(({ exec }) => {
                exec(stopContainer(containerName), { timeout: 10_000 });
              });
            });
          }
        }
      }, 60_000);
    });

    if (!adaptedText || adaptedText === 'NO_SPEAK') {
      logger.info('Voice adapter returned NO_SPEAK or empty');
      return null;
    }

    logger.info(
      { original: text.length, adapted: adaptedText.length },
      'Adapted response for speech',
    );
    return adaptedText;
  } catch (err) {
    logger.error({ err }, 'Speech adaptation error');
    return null;
  }
}

/**
 * Generate OGG/Opus audio from text using ElevenLabs TTS.
 * Voice, model, and speed are resolved from ~/.config/elevenlabs/config.json.
 * Returns the audio buffer, or null on failure.
 */
export async function generateTTS(
  text: string,
  elevenLabsKey: string,
  voiceId?: string,
): Promise<Buffer | null> {
  if (!elevenLabsKey) return null;

  const resolvedVoiceId = voiceId || resolveVoiceId();
  const model = resolveModel();
  const speed = resolveSpeed();

  try {
    const url = `${ELEVENLABS_TTS_ENDPOINT}/${resolvedVoiceId}?output_format=opus_48000_128`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'xi-api-key': elevenLabsKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text,
        model_id: model,
        speed: Math.max(0.7, Math.min(1.2, speed)),
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      logger.warn(
        { status: res.status, body: body.slice(0, 200) },
        'ElevenLabs TTS failed',
      );
      return null;
    }

    const arrayBuffer = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    logger.info(
      { bytes: buffer.length, voiceId: resolvedVoiceId },
      'Generated TTS audio',
    );
    return buffer;
  } catch (err) {
    logger.error({ err }, 'TTS generation error');
    return null;
  }
}

/**
 * Full voice response pipeline.
 * Spawns a lightweight container to adapt text for speech (handles OAuth),
 * then generates TTS audio via ElevenLabs. Returns the OGG buffer or null.
 */
export async function createVoiceResponse(
  text: string,
  elevenLabsKey: string,
): Promise<Buffer | null> {
  const adapted = await adaptForSpeech(text);
  if (!adapted) return null;

  return generateTTS(adapted, elevenLabsKey);
}
