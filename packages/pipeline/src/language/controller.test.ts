import { describe, expect, it } from 'vitest';
import { DEFAULT_LANGUAGE_SETTINGS, type LanguageSettings } from '@tw/shared';
import { LanguageController, countWords } from './controller.js';

const AUTO: LanguageSettings = DEFAULT_LANGUAGE_SETTINGS;
const MIXED: LanguageSettings = { operatorLang: 'es', passengerSpeaks: { mode: 'auto' }, passengerHears: { mode: 'fixed', lang: 'en' } };
const MANUAL: LanguageSettings = {
  operatorLang: 'es',
  passengerSpeaks: { mode: 'fixed', lang: 'fr' },
  passengerHears: { mode: 'fixed', lang: 'fr' },
};

const PHRASE = 'my flight was cancelled and I need a hotel';

function make(settings: LanguageSettings = AUTO) {
  let clock = 1000;
  return new LanguageController(settings, { now: () => (clock += 1) });
}

const both = (lang: string, text = PHRASE) => ({ text, sttLang: lang, translatorLang: lang });

describe('LanguageController detection', () => {
  it('starts unknown and not usable', () => {
    const controller = make();
    expect(controller.getState().status).toBe('unknown');
    expect(controller.heardLanguage()).toEqual({ lang: null, usable: false });
  });

  it('confirms only after both signals agree on 2 consecutive segments', () => {
    const controller = make();
    const first = controller.observe(both('en'));
    expect(first.state).toMatchObject({ lang: 'en', status: 'tentative', agreeingSegments: 1, source: 'stt+translator' });
    expect(controller.heardLanguage()).toEqual({ lang: 'en', usable: true });
    const second = controller.observe(both('en'));
    expect(second.state).toMatchObject({ lang: 'en', status: 'confirmed', agreeingSegments: 2 });
    expect(second.notice).toBeNull();
  });

  it('normalises codes such as en-US and eng', () => {
    const controller = make();
    controller.observe({ text: PHRASE, sttLang: 'en-US', translatorLang: 'eng' });
    expect(controller.getState().lang).toBe('en');
  });

  it('ignores short blips: they are neither evidence for nor against', () => {
    const controller = make();
    controller.observe(both('en'));
    controller.observe(both('en'));
    const update = controller.observe({ text: 'ok', sttLang: 'fr', translatorLang: 'it' });
    expect(update.changed).toBe(false);
    expect(controller.getState()).toMatchObject({ lang: 'en', status: 'confirmed' });
  });

  it('counts characters for scripts without spaces', () => {
    expect(countWords('你好，我的航班被取消了')).toBe(1);
    const controller = make();
    controller.observe({ text: '你好，我的航班被取消了，我需要酒店', sttLang: 'zh', translatorLang: 'zh' });
    expect(controller.getState().lang).toBe('zh');
  });

  it('warns once when the two signals disagree before anything is confirmed', () => {
    const controller = make();
    const first = controller.observe({ text: PHRASE, sttLang: 'pt', translatorLang: 'es' });
    expect(first.state.status).toBe('uncertain');
    expect(first.notice).toMatchObject({ kind: 'uncertain', candidates: { stt: 'pt', translator: 'es' } });
    expect(controller.heardLanguage().usable).toBe(false);
    const second = controller.observe({ text: PHRASE, sttLang: 'pt', translatorLang: 'es' });
    expect(second.changed).toBe(false);
    expect(second.notice).toBeNull();
  });

  it('a low STT probability is weak evidence and does not confirm', () => {
    const controller = make();
    controller.observe({ ...both('en'), sttProbability: 0.3 });
    controller.observe({ ...both('en'), sttProbability: 0.3 });
    expect(controller.getState().status).not.toBe('confirmed');
    expect(controller.getState().status).toBe('uncertain');
  });

  it('a single doubtful segment does not change a confirmed language', () => {
    const controller = make();
    controller.observe(both('en'));
    controller.observe(both('en'));
    const doubtful = controller.observe({ text: PHRASE, sttLang: 'fr', translatorLang: 'it' });
    expect(doubtful.changed).toBe(false);
    expect(controller.getState()).toMatchObject({ lang: 'en', status: 'confirmed' });
  });

  it('repeated disagreement on a confirmed language ends in an uncertain warning, keeping the language', () => {
    const controller = make();
    controller.observe(both('en'));
    controller.observe(both('en'));
    controller.observe({ text: PHRASE, sttLang: 'fr', translatorLang: 'it' });
    controller.observe({ text: PHRASE, sttLang: 'fr', translatorLang: 'it' });
    const third = controller.observe({ text: PHRASE, sttLang: 'fr', translatorLang: 'it' });
    expect(third.state).toMatchObject({ lang: 'en', status: 'uncertain' });
    expect(third.notice?.kind).toBe('uncertain');
  });

  it('switches a confirmed language only after 3 consecutive confirming segments, and says so', () => {
    const controller = make();
    controller.observe(both('en'));
    controller.observe(both('en'));
    expect(controller.observe(both('pt')).changed).toBe(false);
    expect(controller.observe(both('pt')).changed).toBe(false);
    expect(controller.getState().lang).toBe('en');
    const third = controller.observe(both('pt'));
    expect(third.state).toMatchObject({ lang: 'pt', status: 'confirmed', agreeingSegments: 3 });
    expect(third.notice).toMatchObject({ kind: 'changed', lang: 'pt' });
  });

  it('an interrupted run of another language does not switch', () => {
    const controller = make();
    controller.observe(both('en'));
    controller.observe(both('en'));
    controller.observe(both('pt'));
    controller.observe(both('pt'));
    controller.observe(both('en'));
    controller.observe(both('pt'));
    controller.observe(both('pt'));
    expect(controller.getState().lang).toBe('en');
  });

  it('a lone signal gives a tentative guess that is not usable until both agree', () => {
    const controller = make();
    const update = controller.observe({ text: PHRASE, sttLang: 'it', translatorLang: null });
    expect(update.state).toMatchObject({ lang: 'it', status: 'tentative', source: 'stt', agreeingSegments: 0 });
    expect(controller.heardLanguage()).toEqual({ lang: 'it', usable: false });
  });

  it('two unclear segments in a row become uncertain', () => {
    const controller = make();
    controller.observe({ text: PHRASE, sttLang: null, translatorLang: null });
    const second = controller.observe({ text: PHRASE, sttLang: null, translatorLang: null });
    expect(second.state.status).toBe('uncertain');
    expect(second.notice?.kind).toBe('uncertain');
  });

  it('recovers from uncertain when both signals agree again', () => {
    const controller = make();
    controller.observe({ text: PHRASE, sttLang: 'pt', translatorLang: 'es' });
    controller.observe(both('pt'));
    controller.observe(both('pt'));
    expect(controller.getState()).toMatchObject({ lang: 'pt', status: 'confirmed' });
  });
});

describe('LanguageController settings', () => {
  it('manual mode: the language is fixed, confirmed by the operator and detection is ignored', () => {
    const controller = make(MANUAL);
    expect(controller.getState()).toMatchObject({ lang: 'fr', status: 'confirmed', source: 'operator' });
    const update = controller.observe(both('en'));
    expect(update.changed).toBe(false);
    expect(controller.getState().lang).toBe('fr');
    expect(controller.heardLanguage()).toEqual({ lang: 'fr', usable: true });
  });

  it('mixed mode: the voice language is fixed while the passenger language is detected', () => {
    const controller = make(MIXED);
    expect(controller.heardLanguage()).toEqual({ lang: 'en', usable: true });
    controller.observe(both('pt'));
    controller.observe(both('pt'));
    expect(controller.getState().lang).toBe('pt');
    expect(controller.heardLanguage()).toEqual({ lang: 'en', usable: true });
  });

  it('follow mode uses the detected language once it is usable', () => {
    const controller = make(AUTO);
    controller.observe(both('it'));
    expect(controller.heardLanguage()).toEqual({ lang: 'it', usable: true });
  });

  it('the operator choosing a language resolves an uncertain state at once', () => {
    const controller = make();
    controller.observe({ text: PHRASE, sttLang: 'pt', translatorLang: 'es' });
    expect(controller.getState().status).toBe('uncertain');
    const update = controller.applySettings({ ...AUTO, passengerSpeaks: { mode: 'fixed', lang: 'pt' } });
    expect(update.state).toMatchObject({ lang: 'pt', status: 'confirmed', source: 'operator' });
    expect(controller.heardLanguage()).toEqual({ lang: 'pt', usable: true });
  });

  it('going from manual back to automatic keeps the language as a guess that detection must confirm', () => {
    const controller = make(MANUAL);
    controller.applySettings(AUTO);
    expect(controller.getState()).toMatchObject({ lang: 'fr', status: 'tentative', source: 'operator' });
    expect(controller.heardLanguage().usable).toBe(true);
    controller.observe(both('de'));
    expect(controller.getState()).toMatchObject({ lang: 'de', status: 'tentative' });
  });

  it('a channel hint is only used while nothing is known', () => {
    const controller = make();
    expect(controller.setHint('pt-BR').state).toMatchObject({ lang: 'pt', source: 'hint', status: 'tentative' });
    expect(controller.heardLanguage()).toEqual({ lang: 'pt', usable: true });
    expect(controller.setHint('it').changed).toBe(false);
  });

  it('rejects a switch threshold lower than the agreement threshold', () => {
    expect(() => new LanguageController(AUTO, { agreeSegments: 3, switchSegments: 2 })).toThrow(RangeError);
  });
});
