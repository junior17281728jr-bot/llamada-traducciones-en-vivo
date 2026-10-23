/**
 * Domain types shared by server, pipeline, desktop app and simulator.
 * Timestamps are epoch milliseconds; `startMs`/`endMs` are milliseconds since the call was answered.
 */
import { normalizeLanguageCode, OPERATOR_LANGUAGE, type LanguageCode } from './languages.js';

/** Opaque call identifier, unique across the whole system. */
export type CallId = string;

export const DIRECTIONS = ['inbound', 'outbound', 'local'] as const;
/**
 * `inbound`: a passenger called us. `outbound`: an operator dialed out. `local`: "modo audio del PC",
 * the call happens in another program (e.g. WhatsApp Desktop) and its audio reaches us through virtual
 * audio cables on the operator's computer.
 */
export type Direction = (typeof DIRECTIONS)[number];

export const PROVIDER_MODES = ['mock', 'elevenlabs'] as const;
/** Which STT/translation/TTS implementations the server runs (`PROVIDERS` env var). */
export type ProviderMode = (typeof PROVIDER_MODES)[number];

export const CHANNEL_KINDS = ['mock', 'twilio', 'whatsapp', 'desktop-audio'] as const;
/**
 * Which telephony channel the server uses (`CHANNEL` env var). `desktop-audio` means no telephone line at
 * all: only "local" calls fed by the operator's computer (virtual audio cables); local calls are also
 * available alongside every other channel.
 */
export type ChannelKind = (typeof CHANNEL_KINDS)[number];

export const SPEAKERS = ['operator', 'passenger'] as const;
export type Speaker = (typeof SPEAKERS)[number];

export const CALL_STATES = ['queued', 'ringing', 'dialing', 'active', 'ended'] as const;
/**
 * - `queued`: inbound call waiting because every operator is busy.
 * - `ringing`: inbound call ringing on an operator's app, or outbound call ringing at the passenger.
 * - `dialing`: outbound call being placed (before the far end rings).
 * - `active`: answered, audio flowing, translation running.
 * - `ended`: finished (see `CallEndReason`).
 */
export type CallState = (typeof CALL_STATES)[number];

export const CALL_END_REASONS = [
  'hangup_operator',
  'hangup_passenger',
  'rejected',
  'no_answer',
  'busy',
  'failed',
  'cancelled',
  'server_shutdown',
  /** The operator's app lost its connection and did not come back within the grace period. */
  'connection_lost',
] as const;
export type CallEndReason = (typeof CALL_END_REASONS)[number];

// ---------------------------------------------------------------------------
// Translation directions and pipeline stages
// ---------------------------------------------------------------------------

export const PIPELINE_DIRECTIONS = ['passenger_to_operator', 'operator_to_passenger'] as const;
/**
 * One translated sense of the conversation. Each one is a "lane" in the call screen:
 * `passenger_to_operator` is the Pasajero lane, `operator_to_passenger` the Operador lane.
 */
export type PipelineDirection = (typeof PIPELINE_DIRECTIONS)[number];

/** Who is speaking in the given direction. */
export function speakerOfDirection(direction: PipelineDirection): Speaker {
  return direction === 'passenger_to_operator' ? 'passenger' : 'operator';
}

/** The translated direction that carries the given speaker's voice. */
export function directionOfSpeaker(speaker: Speaker): PipelineDirection {
  return speaker === 'passenger' ? 'passenger_to_operator' : 'operator_to_passenger';
}

export const PIPELINE_STAGES = ['idle', 'receiving', 'transcribing', 'translating', 'speaking', 'error'] as const;
/**
 * What one direction is doing right now:
 * `receiving` voice is arriving, `transcribing` STT is working, `translating` the translator is
 * working, `speaking` the translated voice is being produced/played, `error` a stage failed.
 */
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

/** Emitted by a `DirectionPipeline` on every stage change; the server adds the `callId`. */
export interface PipelineStageEvent {
  direction: PipelineDirection;
  stage: PipelineStage;
  /** Segment the stage refers to, when there is one. */
  segmentId?: string;
  /** Short human-readable detail (mostly for `error`). */
  detail?: string;
}

export const SERVICE_STATUSES = ['ok', 'degraded', 'down', 'simulated', 'unconfigured', 'configured'] as const;
/**
 * Health of one external dependency. `simulated` means a local mock, never a real service.
 * `configured` means a key exists but nothing has been checked against the service yet; `ok` is only
 * reported after a successful connection test.
 */
export type ServiceStatus = (typeof SERVICE_STATUSES)[number];

// ---------------------------------------------------------------------------
// Transcript
// ---------------------------------------------------------------------------

/**
 * One utterance, original and translated. Partial results reuse the same `id` with
 * `final: false`. The speaker's language is `originalLang`; the text is rendered for the
 * listener in `translatedLang`.
 */
export interface TranscriptSegment {
  id: string;
  callId: CallId;
  speaker: Speaker;
  /** Language of `originalText` (normalised code); null while it is still undetected. */
  originalLang: string | null;
  originalText: string;
  /** Null until the translation is available (always null on early partials). */
  translatedLang: string | null;
  translatedText: string | null;
  startMs: number;
  endMs: number;
  final: boolean;
  createdAt: number;
}

/** Persistent summary of a call (history). */
export interface CallRecord {
  id: CallId;
  direction: Direction;
  remoteNumber: string;
  operatorId: string | null;
  /** Passenger language: chosen by the operator or detected; null while unknown. */
  passengerLang: string | null;
  state: CallState;
  createdAt: number;
  answeredAt: number | null;
  endedAt: number | null;
  endReason: CallEndReason | null;
  /** True when a recording exists for this call. */
  recorded: boolean;
}

export const OPERATOR_ROLES = ['operator', 'admin'] as const;
export type OperatorRole = (typeof OPERATOR_ROLES)[number];

export const OPERATOR_STATUSES = ['offline', 'available', 'ringing', 'in_call'] as const;
export type OperatorStatus = (typeof OPERATOR_STATUSES)[number];

export interface OperatorInfo {
  id: string;
  /** Display name. */
  name: string;
  /** `admin` may edit API keys and run connection tests. */
  role: OperatorRole;
  status: OperatorStatus;
  currentCallId: CallId | null;
  /** When true, inbound calls offered to this operator are answered automatically. */
  autoAccept: boolean;
}

// ---------------------------------------------------------------------------
// Language settings of a call
// ---------------------------------------------------------------------------

/** Language the passenger speaks: detected automatically or fixed by the operator. */
export type PassengerSpeaks = { mode: 'auto' } | { mode: 'fixed'; lang: LanguageCode };

/**
 * Language of the translated operator voice the passenger hears: the same language the
 * passenger speaks or was detected in (`follow`), or a fixed one.
 */
export type PassengerHears = { mode: 'follow' } | { mode: 'fixed'; lang: LanguageCode };

/** Three independent concepts per call. Changes apply to the NEXT phrases, never to audio already playing. */
export interface LanguageSettings {
  /** Language the operator speaks and hears. */
  operatorLang: LanguageCode;
  passengerSpeaks: PassengerSpeaks;
  passengerHears: PassengerHears;
}

export type PartialLanguageSettings = Partial<LanguageSettings>;

export const LANGUAGE_MODES = ['manual', 'auto', 'mixed'] as const;
/**
 * What the operator sees:
 * - `manual`: passengerSpeaks fixed + passengerHears fixed.
 * - `auto`: passengerSpeaks auto + passengerHears follow.
 * - `mixed`: passengerSpeaks auto + passengerHears fixed.
 */
export type LanguageMode = (typeof LANGUAGE_MODES)[number];

/** Spanish labels for the mode selector. */
export const LANGUAGE_MODE_LABELS_ES: Record<LanguageMode, string> = {
  manual: 'Manual',
  auto: 'Automático',
  mixed: 'Mixto',
};

export const DEFAULT_FALLBACK_LANGUAGE: LanguageCode = 'en';

export const DEFAULT_LANGUAGE_SETTINGS: LanguageSettings = {
  operatorLang: OPERATOR_LANGUAGE,
  passengerSpeaks: { mode: 'auto' },
  passengerHears: { mode: 'follow' },
};

/**
 * Mode shown for `settings`. A fixed spoken language with a `follow` voice is functionally
 * manual (the voice language equals the fixed spoken one), so it is reported as `manual`.
 */
export function languageModeOf(settings: LanguageSettings): LanguageMode {
  if (settings.passengerSpeaks.mode === 'fixed') return 'manual';
  return settings.passengerHears.mode === 'follow' ? 'auto' : 'mixed';
}

export interface LanguageModeHints {
  /** Passenger language detected so far, used to seed fixed languages when leaving `auto`. */
  passengerLang?: string | null;
  /** Used when nothing else is known. Defaults to {@link DEFAULT_FALLBACK_LANGUAGE}. */
  fallbackLang?: LanguageCode;
}

/**
 * Settings after switching to `mode`, keeping every language the operator already chose.
 * Languages needed by the new mode come from (in order) the current settings, the detected
 * passenger language, then the fallback.
 */
export function settingsForMode(
  current: LanguageSettings,
  mode: LanguageMode,
  hints: LanguageModeHints = {},
): LanguageSettings {
  const fallback = hints.fallbackLang ?? DEFAULT_FALLBACK_LANGUAGE;
  const detected = normalizeLanguageCode(hints.passengerLang);
  const fixedSpoken = current.passengerSpeaks.mode === 'fixed' ? current.passengerSpeaks.lang : null;
  const fixedHeard = current.passengerHears.mode === 'fixed' ? current.passengerHears.lang : null;

  switch (mode) {
    case 'auto':
      return { ...current, passengerSpeaks: { mode: 'auto' }, passengerHears: { mode: 'follow' } };
    case 'manual': {
      const spoken = fixedSpoken ?? detected ?? fixedHeard ?? fallback;
      return {
        ...current,
        passengerSpeaks: { mode: 'fixed', lang: spoken },
        passengerHears: { mode: 'fixed', lang: fixedHeard ?? spoken },
      };
    }
    case 'mixed': {
      const heard = fixedHeard ?? fixedSpoken ?? detected ?? fallback;
      return { ...current, passengerSpeaks: { mode: 'auto' }, passengerHears: { mode: 'fixed', lang: heard } };
    }
  }
}

/** Applies a partial change (what `call.setLanguages` carries) on top of `base`. */
export function mergeLanguageSettings(base: LanguageSettings, patch: PartialLanguageSettings): LanguageSettings {
  return {
    operatorLang: patch.operatorLang ?? base.operatorLang,
    passengerSpeaks: patch.passengerSpeaks ?? base.passengerSpeaks,
    passengerHears: patch.passengerHears ?? base.passengerHears,
  };
}

/** True when two settings objects mean the same thing. */
export function languageSettingsEqual(a: LanguageSettings, b: LanguageSettings): boolean {
  const sameChoice = (x: { mode: string; lang?: string }, y: { mode: string; lang?: string }): boolean =>
    x.mode === y.mode && x.lang === y.lang;
  return (
    a.operatorLang === b.operatorLang &&
    sameChoice(a.passengerSpeaks, b.passengerSpeaks) &&
    sameChoice(a.passengerHears, b.passengerHears)
  );
}

/**
 * Language the passenger is expected to speak now: the fixed one, or the detected one in `auto`.
 * Null while unknown.
 */
export function resolvePassengerSpokenLang(
  settings: LanguageSettings,
  detectedLang: string | null | undefined,
): LanguageCode | null {
  return settings.passengerSpeaks.mode === 'fixed'
    ? settings.passengerSpeaks.lang
    : normalizeLanguageCode(detectedLang);
}

/**
 * Language of the voice the passenger hears: the fixed one, or (follow) the language the
 * passenger speaks. Null while unknown, which is when the pipeline retains the operator's text.
 */
export function resolvePassengerHeardLang(
  settings: LanguageSettings,
  detectedLang: string | null | undefined,
): LanguageCode | null {
  if (settings.passengerHears.mode === 'fixed') return settings.passengerHears.lang;
  return resolvePassengerSpokenLang(settings, detectedLang);
}

// ---------------------------------------------------------------------------
// Detected passenger language
// ---------------------------------------------------------------------------

export const LANGUAGE_STATUSES = ['unknown', 'tentative', 'confirmed', 'uncertain'] as const;
/**
 * - `unknown`: nothing detected yet.
 * - `tentative`: one signal, or agreement on fewer segments than required.
 * - `confirmed`: both signals agree on enough consecutive segments (or the operator fixed it).
 * - `uncertain`: signals disagree, text too short or probability low; the operator is warned.
 */
export type LanguageStatus = (typeof LANGUAGE_STATUSES)[number];

export const LANGUAGE_SIGNAL_SOURCES = ['stt', 'translator', 'stt+translator', 'operator', 'hint', 'fallback'] as const;
/** Which signal produced the language: STT per segment, Claude's identification, both, the operator, a channel hint or the fallback. */
export type LanguageSignalSource = (typeof LANGUAGE_SIGNAL_SOURCES)[number];

export interface LanguageState {
  /** Detected passenger language (normalised when known), null while unknown. */
  lang: string | null;
  status: LanguageStatus;
  source: LanguageSignalSource | null;
  /** Language probability reported by the STT for the last segment (UNVERIFIED field), if any. */
  probability: number | null;
  /** Consecutive segments in which both signals agreed on `lang`. */
  agreeingSegments: number;
}

export const UNKNOWN_LANGUAGE_STATE: LanguageState = {
  lang: null,
  status: 'unknown',
  source: null,
  probability: null,
  agreeingSegments: 0,
};

export const LANGUAGE_NOTICE_KINDS = ['uncertain', 'changed', 'fallback_used'] as const;
/**
 * Explicit warning for the operator:
 * - `uncertain`: the signals disagree or are weak; the operator may pick the language by hand.
 * - `changed`: the passenger switched to another language (`lang` is the new one).
 * - `fallback_used`: held text was released with the fallback language (`lang`).
 */
export type LanguageNoticeKind = (typeof LANGUAGE_NOTICE_KINDS)[number];

export interface LanguageNotice {
  kind: LanguageNoticeKind;
  /** Language the notice is about (new language, or the fallback used); null when none applies. */
  lang: string | null;
  /** What each signal said for the last segment. */
  candidates: { stt: string | null; translator: string | null };
  at: number;
}

// ---------------------------------------------------------------------------
// Operator preferences
// ---------------------------------------------------------------------------

/** Per-operator defaults applied when each call starts. */
export interface OperatorPreferences {
  /** Language the operator speaks and hears. */
  operatorLang: LanguageCode;
  defaultMode: LanguageMode;
  /** Passenger spoken language used by `manual` (null: use the fallback). */
  defaultPassengerSpeaks: LanguageCode | null;
  /** Passenger voice language used by `manual` and `mixed` (null: use the spoken one or the fallback). */
  defaultPassengerHears: LanguageCode | null;
  autoAccept: boolean;
}

export const DEFAULT_OPERATOR_PREFERENCES: OperatorPreferences = {
  operatorLang: OPERATOR_LANGUAGE,
  defaultMode: 'auto',
  defaultPassengerSpeaks: null,
  defaultPassengerHears: null,
  autoAccept: false,
};

/** Language settings a new call starts with for an operator. */
export function languageSettingsFromPreferences(
  preferences: OperatorPreferences,
  fallbackLang: LanguageCode = DEFAULT_FALLBACK_LANGUAGE,
): LanguageSettings {
  const spoken = preferences.defaultPassengerSpeaks ?? fallbackLang;
  const heard = preferences.defaultPassengerHears ?? preferences.defaultPassengerSpeaks ?? fallbackLang;
  switch (preferences.defaultMode) {
    case 'auto':
      return { operatorLang: preferences.operatorLang, passengerSpeaks: { mode: 'auto' }, passengerHears: { mode: 'follow' } };
    case 'manual':
      return {
        operatorLang: preferences.operatorLang,
        passengerSpeaks: { mode: 'fixed', lang: spoken },
        passengerHears: { mode: 'fixed', lang: heard },
      };
    case 'mixed':
      return {
        operatorLang: preferences.operatorLang,
        passengerSpeaks: { mode: 'auto' },
        passengerHears: { mode: 'fixed', lang: heard },
      };
  }
}
