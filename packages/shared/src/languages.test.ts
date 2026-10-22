import { describe, expect, it } from 'vitest';
import {
  DOCUMENTED_TTS_LANGUAGES,
  LANGUAGES,
  documentationCatalog,
  getLanguage,
  isSelectableLanguage,
  languageNameEs,
  normalizeLanguageCode,
  selectableLanguages,
  voiceEnvVarName,
  type LanguageCatalog,
} from './languages.js';

describe('normalizeLanguageCode', () => {
  it.each([
    ['en-US', 'en'],
    ['EN', 'en'],
    ['pt_BR', 'pt'],
    ['zh-Hans-CN', 'zh'],
    ['  fr ', 'fr'],
    ['eng', 'en'],
    ['spa', 'es'],
    ['fra', 'fr'],
    ['fre', 'fr'],
    ['ita', 'it'],
    ['por', 'pt'],
    ['deu', 'de'],
    ['ger', 'de'],
    ['cmn', 'zh'],
    ['nb', 'no'],
    ['tl', 'fil'],
    ['tgl', 'fil'],
    ['iw', 'he'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeLanguageCode(input)).toBe(expected);
  });

  it.each(['', '  ', 'und', 'xx', 'klingon', null, undefined])('returns null for %s', (input) => {
    expect(normalizeLanguageCode(input)).toBeNull();
  });
});

describe('catalogue entries', () => {
  it('has unique canonical codes and no alias that clashes with another language', () => {
    const seen = new Map<string, string>();
    for (const language of LANGUAGES) {
      for (const key of [language.code, language.iso3, ...(('aliases' in language && language.aliases) || [])]) {
        expect(seen.get(key) ?? language.code, `${key} is used by two languages`).toBe(language.code);
        seen.set(key, language.code);
      }
    }
  });

  it('names languages in Spanish', () => {
    expect(languageNameEs('en')).toBe('Inglés');
    expect(languageNameEs('fr-CA')).toBe('Francés');
    expect(languageNameEs('xx')).toBe('xx');
    expect(languageNameEs(null)).toBe('Desconocido');
    expect(getLanguage('por')?.nativeName).toBe('Português');
  });

  it('builds the per-language voice variable name', () => {
    expect(voiceEnvVarName('pt-BR')).toBe('ELEVENLABS_VOICE_PT');
    expect(voiceEnvVarName('xx')).toBeNull();
  });
});

describe('selectable languages per role', () => {
  const catalog: LanguageCatalog = {
    source: 'live',
    fetchedAt: 1,
    languages: [
      { code: 'es', stt: true, tts: true, translate: true },
      { code: 'en', stt: true, tts: true, translate: true },
      { code: 'fr', stt: true, tts: false, translate: true },
      { code: 'it', stt: false, tts: true, translate: true },
      { code: 'pt', stt: true, tts: true, translate: false },
      { code: 'de-DE', stt: true, tts: true, translate: true },
      { code: 'zz', stt: true, tts: true, translate: true },
    ],
  };
  const codes = (role: Parameters<typeof selectableLanguages>[1]) => selectableLanguages(catalog, role).map((l) => l.code);

  it('passenger speech needs STT and translation', () => {
    expect(codes('passengerSpeaks')).toEqual(['es', 'en', 'fr', 'de']);
  });

  it('voices need TTS and translation', () => {
    expect(codes('operatorVoice')).toEqual(['es', 'en', 'it', 'de']);
    expect(codes('passengerVoice')).toEqual(['es', 'en', 'it', 'de']);
  });

  it('the operator language needs all three', () => {
    expect(codes('operatorLanguage')).toEqual(['es', 'en', 'de']);
  });

  it('never shows something the catalogue does not confirm, nor codes it cannot name', () => {
    expect(codes('passengerSpeaks')).not.toContain('it');
    expect(codes('passengerVoice')).not.toContain('fr');
    expect(codes('passengerVoice')).not.toContain('pt');
    expect(codes('passengerSpeaks')).not.toContain('zz');
  });

  it('isSelectableLanguage normalises the code', () => {
    expect(isSelectableLanguage(catalog, 'passengerSpeaks', 'fr-CA')).toBe(true);
    expect(isSelectableLanguage(catalog, 'passengerVoice', 'fr')).toBe(false);
    expect(isSelectableLanguage(catalog, 'passengerVoice', 'zz')).toBe(false);
  });

  it('an empty catalogue offers nothing', () => {
    expect(selectableLanguages({ source: 'documentation', fetchedAt: 0, languages: [] }, 'passengerSpeaks')).toEqual([]);
  });
});

describe('documentation catalogue', () => {
  const catalog = documentationCatalog();

  it('is labelled as coming from the documentation, with a date', () => {
    expect(catalog.source).toBe('documentation');
    expect(catalog.fetchedAt).toBeGreaterThan(0);
  });

  it('confirms the 32 documented Flash v2.5 languages, including es, en, fr, it and pt', () => {
    expect(DOCUMENTED_TTS_LANGUAGES).toHaveLength(32);
    expect(new Set(DOCUMENTED_TTS_LANGUAGES).size).toBe(32);
    const spoken = selectableLanguages(catalog, 'passengerSpeaks').map((l) => l.code);
    for (const code of ['es', 'en', 'fr', 'it', 'pt', 'hu', 'no', 'vi']) expect(spoken).toContain(code);
    expect(selectableLanguages(catalog, 'passengerVoice')).toHaveLength(32);
  });

  it('does not offer languages without a documented voice', () => {
    const voices = selectableLanguages(catalog, 'passengerVoice').map((l) => l.code);
    for (const code of ['ca', 'gl', 'eu', 'he', 'sw']) expect(voices).not.toContain(code);
  });
});
