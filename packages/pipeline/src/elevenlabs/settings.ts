/**
 * Reads the ElevenLabs/translator settings from environment variables (names documented in
 * `.env.example`). Keys are NOT read here: they are resolved per session through `getSecret`, so a
 * key saved in Settings applies without restarting.
 */
import { languageNameEs, normalizeLanguageCode, parseAudioFormat, voiceEnvVarName, type LanguageCode, type WireAudioFormat } from '@tw/shared';
import { ElevenLabsConfigError } from './errors.js';
import {
  ELEVENLABS_DEFAULT_BASE_URL,
  STT_COMMIT_STRATEGIES,
  STT_DEFAULT_AUDIO_FORMAT,
  STT_DEFAULT_COMMIT_STRATEGY,
  STT_DEFAULT_MODEL,
  TTS_DEFAULT_CHUNK_LENGTH_SCHEDULE,
  TTS_DEFAULT_MODEL,
  TTS_DEFAULT_OUTPUT_FORMAT,
  type SttCommitStrategy,
} from './protocol.js';

export type Env = Record<string, string | undefined>;

export const ELEVENLABS_ENV = {
  baseUrl: 'ELEVENLABS_BASE_URL',
  sttModel: 'ELEVENLABS_STT_MODEL',
  sttAudioFormat: 'ELEVENLABS_STT_AUDIO_FORMAT',
  sttCommitStrategy: 'ELEVENLABS_STT_COMMIT_STRATEGY',
  sttVadSilenceSeconds: 'ELEVENLABS_STT_VAD_SILENCE_SECONDS',
  sttIncludeTimestamps: 'ELEVENLABS_STT_INCLUDE_TIMESTAMPS',
  ttsModel: 'ELEVENLABS_TTS_MODEL',
  ttsOutputFormat: 'ELEVENLABS_TTS_OUTPUT_FORMAT',
  ttsChunkSchedule: 'ELEVENLABS_TTS_CHUNK_SCHEDULE',
  translatorModel: 'TRANSLATOR_MODEL',
} as const;

export const TRANSLATOR_DEFAULT_MODEL = 'claude-haiku-5-5';

export interface ElevenLabsSettings {
  baseUrl: string;
  stt: {
    modelId: string;
    audioFormat: WireAudioFormat;
    commitStrategy: SttCommitStrategy;
    vadSilenceSeconds: number | null;
    includeTimestamps: boolean;
  };
  tts: {
    modelId: string;
    outputFormat: WireAudioFormat;
    chunkLengthSchedule: number[];
  };
  translatorModel: string;
}

function text(env: Env, name: string, fallback: string): string {
  const value = env[name]?.trim();
  return value ? value : fallback;
}

function audioFormat(env: Env, name: string, fallback: WireAudioFormat): WireAudioFormat {
  const raw = text(env, name, fallback);
  try {
    parseAudioFormat(raw);
  } catch {
    throw new ElevenLabsConfigError('tts', `${name} no es un formato de audio que este programa sepa decodificar (valor: "${raw}"). Usa pcm_16000, pcm_22050, pcm_24000, pcm_44100 o ulaw_8000.`);
  }
  return raw as WireAudioFormat;
}

/** Reads and validates the non-secret settings. Throws `ElevenLabsConfigError` (Spanish message) on the first problem. */
export function readElevenLabsSettings(env: Env): ElevenLabsSettings {
  const baseUrl = text(env, ELEVENLABS_ENV.baseUrl, ELEVENLABS_DEFAULT_BASE_URL).replace(/\/+$/, '');
  if (!/^wss?:\/\/[^/\s]+/i.test(baseUrl)) {
    throw new ElevenLabsConfigError('stt', `${ELEVENLABS_ENV.baseUrl} debe empezar por wss:// o ws:// (valor: "${baseUrl}")`);
  }

  const commitStrategy = text(env, ELEVENLABS_ENV.sttCommitStrategy, STT_DEFAULT_COMMIT_STRATEGY);
  if (!(STT_COMMIT_STRATEGIES as readonly string[]).includes(commitStrategy)) {
    throw new ElevenLabsConfigError('stt', `${ELEVENLABS_ENV.sttCommitStrategy} debe ser uno de: ${STT_COMMIT_STRATEGIES.join(', ')} (valor: "${commitStrategy}")`);
  }

  const vadRaw = env[ELEVENLABS_ENV.sttVadSilenceSeconds]?.trim();
  let vadSilenceSeconds: number | null = null;
  if (vadRaw) {
    const value = Number(vadRaw);
    if (!Number.isFinite(value) || value < 0.3 || value > 3) {
      throw new ElevenLabsConfigError('stt', `${ELEVENLABS_ENV.sttVadSilenceSeconds} debe ser un número entre 0.3 y 3.0 (valor: "${vadRaw}")`);
    }
    vadSilenceSeconds = value;
  }

  const timestampsRaw = env[ELEVENLABS_ENV.sttIncludeTimestamps]?.trim().toLowerCase();
  const includeTimestamps = timestampsRaw ? ['1', 'true', 'yes', 'si', 'sí'].includes(timestampsRaw) : false;

  const scheduleRaw = text(env, ELEVENLABS_ENV.ttsChunkSchedule, TTS_DEFAULT_CHUNK_LENGTH_SCHEDULE.join(','));
  const chunkLengthSchedule = scheduleRaw.split(',').map((item) => Number(item.trim()));
  if (chunkLengthSchedule.length === 0 || chunkLengthSchedule.length > 4 || chunkLengthSchedule.some((value) => !Number.isInteger(value) || value <= 0)) {
    throw new ElevenLabsConfigError('tts', `${ELEVENLABS_ENV.ttsChunkSchedule} debe ser de 1 a 4 números enteros positivos separados por comas (valor: "${scheduleRaw}")`);
  }

  return {
    baseUrl,
    stt: {
      modelId: text(env, ELEVENLABS_ENV.sttModel, STT_DEFAULT_MODEL),
      audioFormat: audioFormat(env, ELEVENLABS_ENV.sttAudioFormat, STT_DEFAULT_AUDIO_FORMAT),
      commitStrategy: commitStrategy as SttCommitStrategy,
      vadSilenceSeconds,
      includeTimestamps,
    },
    tts: {
      modelId: text(env, ELEVENLABS_ENV.ttsModel, TTS_DEFAULT_MODEL),
      outputFormat: audioFormat(env, ELEVENLABS_ENV.ttsOutputFormat, TTS_DEFAULT_OUTPUT_FORMAT),
      chunkLengthSchedule,
    },
    translatorModel: text(env, ELEVENLABS_ENV.translatorModel, TRANSLATOR_DEFAULT_MODEL),
  };
}

/** `voice_id` configured for a language (`ELEVENLABS_VOICE_<CODE>`), or null. No defaults on purpose. */
export function voiceIdFor(env: Env, lang: string): string | null {
  const name = voiceEnvVarName(lang);
  if (!name) return null;
  const value = env[name]?.trim();
  return value ? value : null;
}

/** Spanish explanation of a missing voice, naming the variable to set. */
export function missingVoiceMessage(lang: string): string {
  const code = normalizeLanguageCode(lang);
  if (!code) return `No se puede sintetizar voz: «${lang}» no es un idioma conocido.`;
  return `No hay voz de ElevenLabs configurada para ${languageNameEs(code)} (${code}): define ${voiceEnvVarName(code)} con el voice_id de una voz de tu cuenta y reinicia el servidor.`;
}

/** Languages that have a voice configured, in catalogue order of the codes given. */
export function configuredVoiceLanguages(env: Env, codes: readonly LanguageCode[]): LanguageCode[] {
  return codes.filter((code) => voiceIdFor(env, code) !== null);
}

/** Where a client gets its API key: Settings first, then the environment (see `SecretsStore.resolve`). */
export type ApiKeySource = () => Promise<string | undefined> | string | undefined;

/** Resolves the key and drops blanks. Called when a session opens, never cached by the clients. */
export async function resolveApiKey(source: ApiKeySource): Promise<string | undefined> {
  const value = await source();
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
