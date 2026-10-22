/**
 * Language catalogue and code normalisation.
 *
 * The canonical code is ISO 639-1 (two letters) except Filipino, which has no 639-1
 * code and uses `fil`. Whether a given provider (STT/TTS) supports a language is a
 * separate question answered in the provider packages, not here.
 */

export interface LanguageInfo<Code extends string = string> {
  /** Canonical code (ISO 639-1; `fil` for Filipino). */
  readonly code: Code;
  /** ISO 639-3 code. */
  readonly iso3: string;
  /** Name in Spanish, for the operator UI. */
  readonly nameEs: string;
  /** Name in the language itself. */
  readonly nativeName: string;
  /** Other codes that normalise to this language (ISO 639-3/B, legacy and macrolanguage codes). */
  readonly aliases?: readonly string[];
}

export const LANGUAGES = [
  { code: 'es', iso3: 'spa', nameEs: 'Español', nativeName: 'Español' },
  { code: 'en', iso3: 'eng', nameEs: 'Inglés', nativeName: 'English' },
  { code: 'fr', iso3: 'fra', nameEs: 'Francés', nativeName: 'Français', aliases: ['fre'] },
  { code: 'it', iso3: 'ita', nameEs: 'Italiano', nativeName: 'Italiano' },
  { code: 'pt', iso3: 'por', nameEs: 'Portugués', nativeName: 'Português' },
  { code: 'de', iso3: 'deu', nameEs: 'Alemán', nativeName: 'Deutsch', aliases: ['ger'] },
  { code: 'nl', iso3: 'nld', nameEs: 'Neerlandés', nativeName: 'Nederlands', aliases: ['dut'] },
  { code: 'pl', iso3: 'pol', nameEs: 'Polaco', nativeName: 'Polski' },
  { code: 'tr', iso3: 'tur', nameEs: 'Turco', nativeName: 'Türkçe' },
  { code: 'ar', iso3: 'ara', nameEs: 'Árabe', nativeName: 'العربية' },
  { code: 'ru', iso3: 'rus', nameEs: 'Ruso', nativeName: 'Русский' },
  { code: 'zh', iso3: 'zho', nameEs: 'Chino', nativeName: '中文', aliases: ['chi', 'cmn', 'yue'] },
  { code: 'ja', iso3: 'jpn', nameEs: 'Japonés', nativeName: '日本語' },
  { code: 'ko', iso3: 'kor', nameEs: 'Coreano', nativeName: '한국어' },
  { code: 'hi', iso3: 'hin', nameEs: 'Hindi', nativeName: 'हिन्दी' },
  { code: 'ca', iso3: 'cat', nameEs: 'Catalán', nativeName: 'Català' },
  { code: 'gl', iso3: 'glg', nameEs: 'Gallego', nativeName: 'Galego' },
  { code: 'eu', iso3: 'eus', nameEs: 'Vasco', nativeName: 'Euskara', aliases: ['baq'] },
  { code: 'sv', iso3: 'swe', nameEs: 'Sueco', nativeName: 'Svenska' },
  { code: 'da', iso3: 'dan', nameEs: 'Danés', nativeName: 'Dansk' },
  { code: 'no', iso3: 'nor', nameEs: 'Noruego', nativeName: 'Norsk', aliases: ['nb', 'nn', 'nob', 'nno'] },
  { code: 'fi', iso3: 'fin', nameEs: 'Finés', nativeName: 'Suomi' },
  { code: 'cs', iso3: 'ces', nameEs: 'Checo', nativeName: 'Čeština', aliases: ['cze'] },
  { code: 'sk', iso3: 'slk', nameEs: 'Eslovaco', nativeName: 'Slovenčina', aliases: ['slo'] },
  { code: 'hu', iso3: 'hun', nameEs: 'Húngaro', nativeName: 'Magyar' },
  { code: 'ro', iso3: 'ron', nameEs: 'Rumano', nativeName: 'Română', aliases: ['rum', 'mo'] },
  { code: 'bg', iso3: 'bul', nameEs: 'Búlgaro', nativeName: 'Български' },
  { code: 'el', iso3: 'ell', nameEs: 'Griego', nativeName: 'Ελληνικά', aliases: ['gre'] },
  { code: 'uk', iso3: 'ukr', nameEs: 'Ucraniano', nativeName: 'Українська' },
  { code: 'hr', iso3: 'hrv', nameEs: 'Croata', nativeName: 'Hrvatski' },
  { code: 'sr', iso3: 'srp', nameEs: 'Serbio', nativeName: 'Српски' },
  { code: 'sl', iso3: 'slv', nameEs: 'Esloveno', nativeName: 'Slovenščina' },
  { code: 'lt', iso3: 'lit', nameEs: 'Lituano', nativeName: 'Lietuvių' },
  { code: 'lv', iso3: 'lav', nameEs: 'Letón', nativeName: 'Latviešu' },
  { code: 'et', iso3: 'est', nameEs: 'Estonio', nativeName: 'Eesti' },
  { code: 'he', iso3: 'heb', nameEs: 'Hebreo', nativeName: 'עברית', aliases: ['iw'] },
  { code: 'fa', iso3: 'fas', nameEs: 'Persa', nativeName: 'فارسی', aliases: ['per'] },
  { code: 'ur', iso3: 'urd', nameEs: 'Urdu', nativeName: 'اردو' },
  { code: 'bn', iso3: 'ben', nameEs: 'Bengalí', nativeName: 'বাংলা' },
  { code: 'ta', iso3: 'tam', nameEs: 'Tamil', nativeName: 'தமிழ்' },
  { code: 'id', iso3: 'ind', nameEs: 'Indonesio', nativeName: 'Bahasa Indonesia', aliases: ['in'] },
  { code: 'ms', iso3: 'msa', nameEs: 'Malayo', nativeName: 'Bahasa Melayu', aliases: ['may'] },
  { code: 'vi', iso3: 'vie', nameEs: 'Vietnamita', nativeName: 'Tiếng Việt' },
  { code: 'th', iso3: 'tha', nameEs: 'Tailandés', nativeName: 'ไทย' },
  { code: 'fil', iso3: 'fil', nameEs: 'Filipino', nativeName: 'Filipino', aliases: ['tl', 'tgl'] },
  { code: 'sw', iso3: 'swa', nameEs: 'Suajili', nativeName: 'Kiswahili' },
] as const satisfies readonly LanguageInfo[];

export type LanguageCode = (typeof LANGUAGES)[number]['code'];

/** All canonical codes, as a tuple usable with `z.enum`. */
export const LANGUAGE_CODES = LANGUAGES.map((language) => language.code) as unknown as readonly [
  LanguageCode,
  ...LanguageCode[],
];

/** The operators always speak Spanish. */
export const OPERATOR_LANGUAGE: LanguageCode = 'es';

/** Languages the passengers speak most, in the order the operator UI should offer them. */
export const COMMON_PASSENGER_LANGUAGES: readonly LanguageCode[] = [
  'en',
  'fr',
  'it',
  'pt',
  'de',
  'nl',
  'pl',
  'ru',
  'ar',
  'zh',
  'tr',
  'ja',
  'ko',
  'hi',
];

const byCode = new Map<string, LanguageInfo<LanguageCode>>();
const byAlias = new Map<string, LanguageCode>();

for (const language of LANGUAGES as readonly LanguageInfo<LanguageCode>[]) {
  byCode.set(language.code, language);
  byAlias.set(language.code, language.code);
  byAlias.set(language.iso3, language.code);
  for (const alias of language.aliases ?? []) byAlias.set(alias, language.code);
}

/**
 * Normalises a language tag to a canonical code, or returns null when it is unknown.
 * Accepts ISO 639-1/639-3 codes, BCP-47 tags (`en-US`, `pt_BR`, `zh-Hans-CN`),
 * any letter case and surrounding whitespace.
 */
export function normalizeLanguageCode(input: string | null | undefined): LanguageCode | null {
  if (typeof input !== 'string') return null;
  const primary = input.trim().toLowerCase().replace(/_/g, '-').split('-')[0];
  if (!primary) return null;
  return byAlias.get(primary) ?? null;
}

/** Catalogue entry for any code `normalizeLanguageCode` understands. */
export function getLanguage(code: string | null | undefined): LanguageInfo<LanguageCode> | undefined {
  const normalized = normalizeLanguageCode(code);
  return normalized ? byCode.get(normalized) : undefined;
}

/** True for codes in the catalogue (after normalisation). */
export function isKnownLanguage(code: string | null | undefined): boolean {
  return normalizeLanguageCode(code) !== null;
}

/** Spanish name for the UI; falls back to the raw input (or "Desconocido") for unknown codes. */
export function languageNameEs(code: string | null | undefined): string {
  const language = getLanguage(code);
  if (language) return language.nameEs;
  return code && code.trim() ? code.trim() : 'Desconocido';
}

/** Name of the per-language voice variable, e.g. `ELEVENLABS_VOICE_PT` for `pt-BR`. */
export function voiceEnvVarName(code: string): string | null {
  const normalized = normalizeLanguageCode(code);
  return normalized ? `ELEVENLABS_VOICE_${normalized.toUpperCase()}` : null;
}

// ---------------------------------------------------------------------------
// Capability catalogue: which languages each service handles
// ---------------------------------------------------------------------------

/** Where a catalogue came from. `documentation` is the built-in list; `live` is a query to the provider. */
export const CATALOG_SOURCES = ['documentation', 'live'] as const;
export type CatalogSource = (typeof CATALOG_SOURCES)[number];

/**
 * What is CONFIRMED for one language. A `false` means "not confirmed", not "known to be
 * unsupported": the UI shows only what is confirmed.
 */
export interface LanguageSupport {
  /** Canonical code (see `normalizeLanguageCode`). */
  code: string;
  /** Speech to text (the passenger can speak it). */
  stt: boolean;
  /** Text to speech (a voice can be configured for it). */
  tts: boolean;
  /** The translator handles it. */
  translate: boolean;
}

export interface LanguageCatalog {
  source: CatalogSource;
  /** Epoch ms: when a live query was made, or the date the built-in list was written. */
  fetchedAt: number;
  languages: LanguageSupport[];
}

/**
 * Where a language is chosen in the UI:
 * - `passengerSpeaks`: language the passenger talks (STT + translatable).
 * - `operatorVoice`: language of the voice the operator hears (TTS + translatable).
 * - `passengerVoice`: language of the voice the passenger hears (TTS + translatable).
 * - `operatorLanguage`: the operator's own language, spoken and heard (STT + TTS + translatable).
 */
export const LANGUAGE_ROLES = ['passengerSpeaks', 'operatorVoice', 'passengerVoice', 'operatorLanguage'] as const;
export type LanguageRole = (typeof LANGUAGE_ROLES)[number];

function supports(entry: LanguageSupport, role: LanguageRole): boolean {
  switch (role) {
    case 'passengerSpeaks':
      return entry.stt && entry.translate;
    case 'operatorVoice':
    case 'passengerVoice':
      return entry.tts && entry.translate;
    case 'operatorLanguage':
      return entry.stt && entry.tts && entry.translate;
  }
}

/**
 * Languages the user may pick for `role`: only those the catalogue CONFIRMS for every
 * service the role needs. Order follows `LANGUAGES`. Codes outside `LANGUAGES` are ignored.
 */
export function selectableLanguages(
  catalog: LanguageCatalog,
  role: LanguageRole,
): LanguageInfo<LanguageCode>[] {
  const confirmed = new Set<LanguageCode>();
  for (const entry of catalog.languages) {
    const code = normalizeLanguageCode(entry.code);
    if (code && supports(entry, role)) confirmed.add(code);
  }
  return (LANGUAGES as readonly LanguageInfo<LanguageCode>[]).filter((language) => confirmed.has(language.code));
}

/** True when `code` is selectable for `role` in `catalog`. */
export function isSelectableLanguage(catalog: LanguageCatalog, role: LanguageRole, code: string | null | undefined): boolean {
  const normalized = normalizeLanguageCode(code);
  return normalized !== null && selectableLanguages(catalog, role).some((language) => language.code === normalized);
}

/**
 * UNVERIFIED (from search summaries of the ElevenLabs docs, never checked against the API):
 * Flash v2.5 covers 32 languages, the 29 of Multilingual v2 plus Hungarian, Norwegian and Vietnamese.
 */
export const DOCUMENTED_TTS_LANGUAGES: readonly LanguageCode[] = [
  'en', 'ja', 'zh', 'de', 'hi', 'fr', 'ko', 'pt', 'it', 'es', 'id', 'nl', 'tr', 'fil', 'pl', 'sv',
  'bg', 'ro', 'ar', 'cs', 'el', 'fi', 'hr', 'ms', 'sk', 'da', 'ta', 'uk', 'ru', 'hu', 'no', 'vi',
];

/** Date the built-in list was written (epoch ms), shown in Settings next to the source. */
export const DOCUMENTATION_CATALOG_DATE = Date.UTC(2026, 9, 22);

/**
 * Built-in catalogue. UNVERIFIED: Scribe v2 Realtime declares 90+ languages without a list we
 * could check, so STT is only marked for the languages that also have a documented TTS voice
 * (all of them are major languages); translation is assumed for the same set. Nothing else is
 * offered until a live query (`source: 'live'`) confirms it.
 */
export function documentationCatalog(fetchedAt: number = DOCUMENTATION_CATALOG_DATE): LanguageCatalog {
  const documented = new Set<string>(DOCUMENTED_TTS_LANGUAGES);
  return {
    source: 'documentation',
    fetchedAt,
    languages: LANGUAGES.map((language) => {
      const confirmed = documented.has(language.code);
      return { code: language.code, stt: confirmed, tts: confirmed, translate: confirmed };
    }),
  };
}
