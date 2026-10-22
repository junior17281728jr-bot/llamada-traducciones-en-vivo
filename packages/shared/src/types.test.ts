import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LANGUAGE_SETTINGS,
  DEFAULT_OPERATOR_PREFERENCES,
  LANGUAGE_MODES,
  directionOfSpeaker,
  languageModeOf,
  languageSettingsEqual,
  languageSettingsFromPreferences,
  mergeLanguageSettings,
  resolvePassengerHeardLang,
  resolvePassengerSpokenLang,
  settingsForMode,
  speakerOfDirection,
  type LanguageSettings,
} from './types.js';

const auto: LanguageSettings = DEFAULT_LANGUAGE_SETTINGS;
const manual: LanguageSettings = {
  operatorLang: 'es',
  passengerSpeaks: { mode: 'fixed', lang: 'fr' },
  passengerHears: { mode: 'fixed', lang: 'fr' },
};
const mixed: LanguageSettings = {
  operatorLang: 'es',
  passengerSpeaks: { mode: 'auto' },
  passengerHears: { mode: 'fixed', lang: 'en' },
};

describe('languageModeOf', () => {
  it('maps the three combinations the operator sees', () => {
    expect(languageModeOf(manual)).toBe('manual');
    expect(languageModeOf(auto)).toBe('auto');
    expect(languageModeOf(mixed)).toBe('mixed');
  });

  it('a fixed spoken language with a followed voice is manual', () => {
    expect(languageModeOf({ ...manual, passengerHears: { mode: 'follow' } })).toBe('manual');
  });
});

describe('settingsForMode', () => {
  it('auto detects and follows, keeping the operator language', () => {
    const result = settingsForMode({ ...manual, operatorLang: 'pt' }, 'auto');
    expect(result).toEqual({ operatorLang: 'pt', passengerSpeaks: { mode: 'auto' }, passengerHears: { mode: 'follow' } });
    expect(languageModeOf(result)).toBe('auto');
  });

  it('manual from auto seeds the detected language', () => {
    const result = settingsForMode(auto, 'manual', { passengerLang: 'it-IT' });
    expect(result.passengerSpeaks).toEqual({ mode: 'fixed', lang: 'it' });
    expect(result.passengerHears).toEqual({ mode: 'fixed', lang: 'it' });
  });

  it('manual from auto without detection uses the fallback', () => {
    expect(settingsForMode(auto, 'manual').passengerSpeaks).toEqual({ mode: 'fixed', lang: 'en' });
    expect(settingsForMode(auto, 'manual', { fallbackLang: 'pt' }).passengerHears).toEqual({ mode: 'fixed', lang: 'pt' });
  });

  it('manual from mixed keeps the chosen voice and seeds speech from detection', () => {
    const result = settingsForMode(mixed, 'manual', { passengerLang: 'fr' });
    expect(result.passengerSpeaks).toEqual({ mode: 'fixed', lang: 'fr' });
    expect(result.passengerHears).toEqual({ mode: 'fixed', lang: 'en' });
  });

  it('mixed keeps a voice already fixed, otherwise uses the fixed/detected language', () => {
    expect(settingsForMode(mixed, 'mixed').passengerHears).toEqual({ mode: 'fixed', lang: 'en' });
    expect(settingsForMode(manual, 'mixed').passengerHears).toEqual({ mode: 'fixed', lang: 'fr' });
    expect(settingsForMode(auto, 'mixed', { passengerLang: 'de' }).passengerHears).toEqual({ mode: 'fixed', lang: 'de' });
  });

  it('always produces settings whose mode is the requested one', () => {
    for (const from of [auto, manual, mixed]) {
      for (const mode of LANGUAGE_MODES) {
        expect(languageModeOf(settingsForMode(from, mode, { passengerLang: 'fr' }))).toBe(mode);
      }
    }
  });
});

describe('mergeLanguageSettings / languageSettingsEqual', () => {
  it('merges only the keys present', () => {
    const merged = mergeLanguageSettings(auto, { passengerHears: { mode: 'fixed', lang: 'it' } });
    expect(merged).toEqual({ ...auto, passengerHears: { mode: 'fixed', lang: 'it' } });
    expect(mergeLanguageSettings(auto, {})).toEqual(auto);
  });

  it('compares by meaning', () => {
    expect(languageSettingsEqual(auto, { ...auto })).toBe(true);
    expect(languageSettingsEqual(manual, { ...manual, passengerHears: { mode: 'fixed', lang: 'it' } })).toBe(false);
    expect(languageSettingsEqual(auto, mixed)).toBe(false);
  });
});

describe('resolving the languages in use', () => {
  it('spoken: the fixed language wins, auto uses the detected one', () => {
    expect(resolvePassengerSpokenLang(manual, 'en')).toBe('fr');
    expect(resolvePassengerSpokenLang(auto, 'en-GB')).toBe('en');
    expect(resolvePassengerSpokenLang(auto, null)).toBeNull();
  });

  it('heard: follow uses what the passenger speaks, fixed ignores detection', () => {
    expect(resolvePassengerHeardLang(auto, 'it')).toBe('it');
    expect(resolvePassengerHeardLang(auto, undefined)).toBeNull();
    expect(resolvePassengerHeardLang(mixed, 'it')).toBe('en');
    expect(resolvePassengerHeardLang({ ...manual, passengerHears: { mode: 'follow' } }, 'it')).toBe('fr');
  });
});

describe('preferences', () => {
  it('turn into the settings a call starts with', () => {
    expect(languageSettingsFromPreferences(DEFAULT_OPERATOR_PREFERENCES)).toEqual(auto);
    expect(
      languageSettingsFromPreferences({
        ...DEFAULT_OPERATOR_PREFERENCES,
        defaultMode: 'manual',
        defaultPassengerSpeaks: 'it',
      }),
    ).toEqual({ operatorLang: 'es', passengerSpeaks: { mode: 'fixed', lang: 'it' }, passengerHears: { mode: 'fixed', lang: 'it' } });
    expect(
      languageSettingsFromPreferences({ ...DEFAULT_OPERATOR_PREFERENCES, defaultMode: 'mixed', defaultPassengerHears: 'pt' }),
    ).toEqual({ operatorLang: 'es', passengerSpeaks: { mode: 'auto' }, passengerHears: { mode: 'fixed', lang: 'pt' } });
  });

  it('manual without saved languages falls back to English', () => {
    const settings = languageSettingsFromPreferences({ ...DEFAULT_OPERATOR_PREFERENCES, defaultMode: 'manual' });
    expect(settings.passengerSpeaks).toEqual({ mode: 'fixed', lang: 'en' });
  });
});

describe('directions and speakers', () => {
  it('maps in both ways', () => {
    expect(speakerOfDirection('passenger_to_operator')).toBe('passenger');
    expect(speakerOfDirection('operator_to_passenger')).toBe('operator');
    expect(directionOfSpeaker('operator')).toBe('operator_to_passenger');
    expect(directionOfSpeaker(speakerOfDirection('passenger_to_operator'))).toBe('passenger_to_operator');
  });
});
