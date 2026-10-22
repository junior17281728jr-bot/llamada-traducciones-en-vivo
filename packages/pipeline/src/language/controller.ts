/**
 * Language state machine of one call: decides which language the passenger speaks and which
 * language the translated operator voice uses.
 *
 * Detection combines two independent signals per finished segment: the language the STT reports
 * and the one the translator identifies. The language is CONFIRMED only when both agree on
 * several consecutive segments with enough text; a single doubtful segment never changes a
 * confirmed language, and disagreement raises an explicit `uncertain` notice for the operator.
 * No timers or I/O here: the pipeline owns the clock-driven parts (holding text, fallback).
 */
import {
  DEFAULT_FALLBACK_LANGUAGE,
  UNKNOWN_LANGUAGE_STATE,
  normalizeLanguageCode,
  resolvePassengerSpokenLang,
  type LanguageCode,
  type LanguageNotice,
  type LanguageSettings,
  type LanguageState,
} from '@tw/shared';

export interface LanguageControllerConfig {
  /** Consecutive segments in which both signals must agree before the language is confirmed. */
  agreeSegments: number;
  /** Words a segment needs to count as evidence (or `minChars` characters, for scripts without spaces). */
  minWords: number;
  minChars: number;
  /** STT language probability below this makes a segment weak evidence (only if the STT reports one). */
  minProbability: number;
  /** Consecutive segments in another language needed to change a confirmed one. Must be >= agreeSegments. */
  switchSegments: number;
  fallbackLang: LanguageCode;
  now: () => number;
}

export const DEFAULT_LANGUAGE_CONTROLLER_CONFIG: LanguageControllerConfig = {
  agreeSegments: 2,
  minWords: 3,
  minChars: 12,
  minProbability: 0.6,
  switchSegments: 3,
  fallbackLang: DEFAULT_FALLBACK_LANGUAGE,
  now: () => Date.now(),
};

export interface LanguageEvidence {
  text: string;
  sttLang?: string | null;
  sttProbability?: number | null;
  translatorLang?: string | null;
}

export interface LanguageUpdate {
  state: LanguageState;
  /** Warning that goes with this change, or null. */
  notice: LanguageNotice | null;
  /** True when `state` or `notice` differs from what was reported before. */
  changed: boolean;
}

export interface HeardLanguage {
  lang: LanguageCode | null;
  /** True when the voice may start in `lang` right away; false means "hold the text until it is known". */
  usable: boolean;
}

export function countWords(text: string): number {
  return text.split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
}

/**
 * Language of the translated voice the passenger hears for `settings` given what is known about
 * the passenger's language. Pure: the pipeline calls it with the settings snapshot of each phrase,
 * so a change made mid-call only affects the phrases that come after it.
 */
export function heardLanguageFor(settings: LanguageSettings, state: LanguageState): HeardLanguage {
  if (settings.passengerHears.mode === 'fixed') return { lang: settings.passengerHears.lang, usable: true };
  const lang = resolvePassengerSpokenLang(settings, state.lang);
  if (lang === null) return { lang: null, usable: false };
  if (settings.passengerSpeaks.mode === 'fixed') return { lang, usable: true };
  const usable =
    state.status === 'confirmed' ||
    (state.status === 'tentative' && (state.agreeingSegments >= 1 || state.source === 'hint' || state.source === 'operator'));
  return { lang, usable };
}

export class LanguageController {
  private readonly config: LanguageControllerConfig;
  private settings: LanguageSettings;
  private state: LanguageState = UNKNOWN_LANGUAGE_STATE;
  private pending: { lang: LanguageCode; count: number } | null = null;
  private unclearStreak = 0;
  private disagreeStreak = 0;

  constructor(settings: LanguageSettings, config: Partial<LanguageControllerConfig> = {}) {
    this.config = { ...DEFAULT_LANGUAGE_CONTROLLER_CONFIG, ...config };
    if (this.config.switchSegments < this.config.agreeSegments) {
      throw new RangeError('switchSegments must be >= agreeSegments');
    }
    this.settings = settings;
    this.syncWithSettings(null);
  }

  getSettings(): LanguageSettings {
    return this.settings;
  }

  getState(): LanguageState {
    return this.state;
  }

  get fallbackLang(): LanguageCode {
    return this.config.fallbackLang;
  }

  /** The operator (or the preferences) changed the settings. Applies to the next phrases. */
  applySettings(settings: LanguageSettings): LanguageUpdate {
    const previousSettings = this.settings;
    const before = this.state;
    this.settings = settings;
    this.syncWithSettings(previousSettings);
    return { state: this.state, notice: null, changed: before !== this.state };
  }

  /** A language hint known before any audio (channel metadata). Only used while nothing is known. */
  setHint(lang: string | null | undefined): LanguageUpdate {
    const code = normalizeLanguageCode(lang);
    if (code === null || this.state.lang !== null || this.settings.passengerSpeaks.mode === 'fixed') {
      return { state: this.state, notice: null, changed: false };
    }
    this.state = { lang: code, status: 'tentative', source: 'hint', probability: null, agreeingSegments: 0 };
    return { state: this.state, notice: null, changed: true };
  }

  /** Mirrors a state computed elsewhere (the operator-to-passenger pipeline follows the other direction). */
  adoptState(state: LanguageState): void {
    this.state = state;
  }

  /** Language of the translated voice the passenger hears, and whether it can be used right now. */
  heardLanguage(): HeardLanguage {
    return heardLanguageFor(this.settings, this.state);
  }

  fallbackNotice(lang: string | null): LanguageNotice {
    return { kind: 'fallback_used', lang, candidates: { stt: null, translator: null }, at: this.config.now() };
  }

  /** Feeds one finished segment of the passenger. */
  observe(evidence: LanguageEvidence): LanguageUpdate {
    if (this.settings.passengerSpeaks.mode === 'fixed') return this.unchanged();
    if (!this.hasEnoughText(evidence.text)) return this.unchanged();

    const stt = normalizeLanguageCode(evidence.sttLang);
    const translator = normalizeLanguageCode(evidence.translatorLang);
    const probability = evidence.sttProbability ?? null;
    const weak = probability !== null && probability < this.config.minProbability;

    if (stt !== null && translator !== null && stt === translator && !weak) {
      return this.agreement(stt, probability);
    }
    if (stt !== null && translator !== null && stt !== translator) {
      return this.disagreement(stt, translator, probability);
    }
    return this.unclear(stt ?? translator, stt !== null ? 'stt' : 'translator', weak, probability, stt, translator);
  }

  private syncWithSettings(previous: LanguageSettings | null): void {
    this.pending = null;
    this.unclearStreak = 0;
    this.disagreeStreak = 0;
    const speaks = this.settings.passengerSpeaks;
    if (speaks.mode === 'fixed') {
      this.state = {
        lang: speaks.lang,
        status: 'confirmed',
        source: 'operator',
        probability: null,
        agreeingSegments: this.config.agreeSegments,
      };
    } else if (previous?.passengerSpeaks.mode === 'fixed') {
      // Back to automatic: keep the last language as a guess until detection confirms it.
      this.state = { lang: this.state.lang, status: 'tentative', source: 'operator', probability: null, agreeingSegments: 0 };
    } else if (previous === null) {
      this.state = UNKNOWN_LANGUAGE_STATE;
    }
  }

  private hasEnoughText(text: string): boolean {
    return countWords(text) >= this.config.minWords || text.trim().length >= this.config.minChars;
  }

  private unchanged(): LanguageUpdate {
    return { state: this.state, notice: null, changed: false };
  }

  private agreement(lang: LanguageCode, probability: number | null): LanguageUpdate {
    this.unclearStreak = 0;
    this.disagreeStreak = 0;
    const current = this.state;
    const confirmedAt = (count: number): LanguageState['status'] =>
      count >= this.config.agreeSegments ? 'confirmed' : 'tentative';

    if (current.lang === lang) {
      this.pending = null;
      const agreeing = current.agreeingSegments + 1;
      this.state = { lang, status: confirmedAt(agreeing), source: 'stt+translator', probability, agreeingSegments: agreeing };
      return { state: this.state, notice: null, changed: true };
    }

    if (current.lang === null || current.status !== 'confirmed') {
      this.pending = null;
      this.state = { lang, status: confirmedAt(1), source: 'stt+translator', probability, agreeingSegments: 1 };
      return { state: this.state, notice: null, changed: true };
    }

    // A confirmed language only changes after several consecutive segments in another one.
    this.pending = this.pending?.lang === lang ? { lang, count: this.pending.count + 1 } : { lang, count: 1 };
    if (this.pending.count < this.config.switchSegments) return this.unchanged();
    const count = this.pending.count;
    this.pending = null;
    this.state = { lang, status: 'confirmed', source: 'stt+translator', probability, agreeingSegments: count };
    const notice: LanguageNotice = { kind: 'changed', lang, candidates: { stt: lang, translator: lang }, at: this.config.now() };
    return { state: this.state, notice, changed: true };
  }

  private disagreement(
    stt: LanguageCode,
    translator: LanguageCode,
    probability: number | null,
  ): LanguageUpdate {
    this.pending = null;
    this.unclearStreak = 0;
    this.disagreeStreak += 1;
    const current = this.state;
    if (current.status === 'confirmed' && this.disagreeStreak < this.config.switchSegments) return this.unchanged();
    if (current.status === 'uncertain') return this.unchanged();
    return this.becomeUncertain(probability, stt, translator);
  }

  private unclear(
    lang: LanguageCode | null,
    source: 'stt' | 'translator',
    weak: boolean,
    probability: number | null,
    stt: LanguageCode | null,
    translator: LanguageCode | null,
  ): LanguageUpdate {
    this.pending = null;
    const current = this.state;

    if (lang !== null && !weak) {
      if (current.lang === null) {
        this.unclearStreak += 1;
        this.state = { lang, status: 'tentative', source, probability, agreeingSegments: 0 };
        return { state: this.state, notice: null, changed: true };
      }
      if (current.lang === lang) {
        this.unclearStreak = 0;
        return this.unchanged();
      }
    }

    this.unclearStreak += 1;
    const limit = current.status === 'confirmed' ? this.config.switchSegments : 2;
    if (current.status === 'uncertain' || this.unclearStreak < limit) return this.unchanged();
    return this.becomeUncertain(probability, stt, translator);
  }

  private becomeUncertain(
    probability: number | null,
    stt: LanguageCode | null,
    translator: LanguageCode | null,
  ): LanguageUpdate {
    const current = this.state;
    this.state = { lang: current.lang, status: 'uncertain', source: current.source, probability, agreeingSegments: 0 };
    const notice: LanguageNotice = {
      kind: 'uncertain',
      lang: current.lang,
      candidates: { stt, translator },
      at: this.config.now(),
    };
    return { state: this.state, notice, changed: true };
  }
}
