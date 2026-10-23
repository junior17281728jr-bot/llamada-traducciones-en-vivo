import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LANGUAGE_SETTINGS,
  concatPcm,
  silencePcm16,
  synthesizeSpeechSignal,
  type LanguageSettings,
  type LanguageStateEvent,
  type PipelineStageEvent,
  type SttProvider,
  type SttSession,
  type SttSessionOptions,
  type TranscriptSegment,
  UNKNOWN_LANGUAGE_STATE,
} from '@tw/shared';
import { TranslationDirectionPipeline, directAudioFor, type DirectionPipelineOptions } from './direction-pipeline.js';
import { UtteranceBus } from './mock/utterance-bus.js';
import { ScriptedStt } from './mock/scripted-stt.js';
import { MockTextTranslator, type MockTranslatorOptions } from './mock/mock-translator.js';
import { MockTts, mockVoicePitchHz, type MockTtsOptions } from './mock/mock-tts.js';
import { utteranceKey } from './factory.js';

const CALL = 'c1';
const EN = 'my flight was cancelled and I need a hotel';
const EN_ES = 'Mi vuelo fue cancelado y necesito un hotel.';
const ES_CHECK = 'voy a comprobar las opciones de alojamiento disponibles';

class SpyStt implements SttProvider {
  readonly opens: SttSessionOptions[] = [];
  constructor(private readonly inner: ScriptedStt) {}
  openSession(options: SttSessionOptions) {
    this.opens.push(options);
    return this.inner.openSession(options);
  }
}

interface RigOptions {
  settings?: LanguageSettings;
  translator?: MockTranslatorOptions;
  tts?: MockTtsOptions;
  pipeline?: Partial<DirectionPipelineOptions>;
}

function rig(options: RigOptions = {}) {
  const settings = options.settings ?? DEFAULT_LANGUAGE_SETTINGS;
  const bus = new UtteranceBus();
  const translator = new MockTextTranslator(options.translator);
  const out = { passenger: [] as Uint8Array[], operator: [] as Uint8Array[] };
  const opens: { lang: string; chunksSoFar: number }[] = [];
  const tts = new MockTts({
    ...options.tts,
    onOpen: (lang) => opens.push({ lang, chunksSoFar: out.passenger.length + out.operator.length }),
  });
  const sttPassenger = new SpyStt(new ScriptedStt({ bus, key: utteranceKey(CALL, 'passenger') }));
  const sttOperator = new SpyStt(new ScriptedStt({ bus, key: utteranceKey(CALL, 'operator') }));
  const pipelineOptions = { holdMs: 200, receivingHangoverMs: 30, errorDisplayMs: 60, ...options.pipeline };
  const passenger = new TranslationDirectionPipeline(
    { callId: CALL, direction: 'passenger_to_operator', settings },
    { stt: sttPassenger, translator, tts },
    pipelineOptions,
  );
  const operator = new TranslationDirectionPipeline(
    { callId: CALL, direction: 'operator_to_passenger', settings },
    { stt: sttOperator, translator, tts },
    pipelineOptions,
  );

  const segments: TranscriptSegment[] = [];
  const stages = { passenger: [] as PipelineStageEvent[], operator: [] as PipelineStageEvent[] };
  const languageStates: LanguageStateEvent[] = [];
  const operatorLanguageEvents: LanguageStateEvent[] = [];
  passenger.onSegment((s) => segments.push(s));
  operator.onSegment((s) => segments.push(s));
  passenger.onStage((e) => stages.passenger.push(e));
  operator.onStage((e) => stages.operator.push(e));
  passenger.onAudio((c) => out.passenger.push(c));
  operator.onAudio((c) => out.operator.push(c));
  passenger.onLanguageState((event) => {
    languageStates.push(event);
    operator.setPassengerLanguageState(event.state);
  });
  operator.onLanguageState((event) => operatorLanguageEvents.push(event));

  return { bus, translator, passenger, operator, segments, stages, languageStates, operatorLanguageEvents, out, opens, sttPassenger, sttOperator };
}

type Rig = ReturnType<typeof rig>;

function say(r: Rig, who: 'passenger' | 'operator', text: string, lang: string): void {
  r.bus.say(utteranceKey(CALL, who), { text, lang });
  const signal = concatPcm([synthesizeSpeechSignal(text, { pitchHz: who === 'passenger' ? 200 : 130 }), silencePcm16(200)]);
  const target = who === 'passenger' ? r.passenger : r.operator;
  for (let offset = 0; offset < signal.byteLength; offset += 640) {
    target.pushAudio(signal.slice(offset, Math.min(offset + 640, signal.byteLength)));
  }
}

async function waitFor(condition: () => boolean, what: string, timeoutMs = 4000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error(`Timeout waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const voice = (text: string, lang: string) => synthesizeSpeechSignal(text, { pitchHz: mockVoicePitchHz(lang) });
const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean => a.byteLength === b.byteLength && Buffer.from(a).equals(Buffer.from(b));
const finals = (r: Rig, speaker: 'passenger' | 'operator') => r.segments.filter((s) => s.final && s.speaker === speaker);

describe('passenger to operator', () => {
  it('transcribes, translates to the operator language and speaks the translation', async () => {
    const r = rig();
    say(r, 'passenger', EN, 'en');
    await waitFor(() => finals(r, 'passenger').length === 1, 'the final segment');
    const final = finals(r, 'passenger')[0]!;
    expect(final).toMatchObject({
      speaker: 'passenger',
      originalLang: 'en',
      originalText: EN,
      translatedLang: 'es',
      translatedText: EN_ES,
      final: true,
    });
    expect(r.segments.some((s) => !s.final && s.id === final.id && s.translatedText === null)).toBe(true);

    await waitFor(() => r.stages.passenger.at(-1)?.stage === 'idle' && r.out.passenger.length > 0, 'the voice to finish');
    expect(bytesEqual(concatPcm(r.out.passenger), voice(EN_ES, 'es'))).toBe(true);
    expect(r.languageStates.at(-1)?.state).toMatchObject({ lang: 'en', status: 'tentative' });
    await r.passenger.close();
    await r.operator.close();
  });

  it('goes through receiving, transcribing, translating and speaking, and ends idle', async () => {
    const r = rig();
    say(r, 'passenger', EN, 'en');
    await waitFor(() => r.stages.passenger.at(-1)?.stage === 'idle' && r.out.passenger.length > 0, 'idle after speaking');
    const order = r.stages.passenger.map((e) => e.stage);
    const first = (stage: string) => order.indexOf(stage as never);
    expect(first('receiving')).toBeGreaterThanOrEqual(0);
    expect(first('receiving')).toBeLessThan(first('transcribing'));
    expect(first('transcribing')).toBeLessThan(first('translating'));
    expect(first('translating')).toBeLessThan(first('speaking'));
    expect(order.at(-1)).toBe('idle');
    expect(r.stages.passenger.every((e) => e.direction === 'passenger_to_operator')).toBe(true);
    await r.passenger.close();
    await r.operator.close();
  });

  it('silence produces no segments, no stage changes and no audio', async () => {
    const r = rig();
    for (let i = 0; i < 50; i++) r.passenger.pushAudio(silencePcm16(20));
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(r.segments).toHaveLength(0);
    expect(r.stages.passenger).toHaveLength(0);
    expect(r.out.passenger).toHaveLength(0);
    await r.passenger.close();
    await r.operator.close();
  });

  it('a passenger who already speaks the operator language is heard: synthesised until the detection is sure, then the original voice is relayed', async () => {
    const r = rig();
    const ES_1 = 'hola buenos días necesito ayuda';
    const ES_2 = 'necesito un hotel para esta noche por favor';
    // Phrase 1: the STT says Spanish but nothing is confirmed yet. The translator identifies the language (second
    // signal) and returns the text unchanged; the operator hears it synthesised because nobody relays the original yet.
    say(r, 'passenger', ES_1, 'es');
    await waitFor(() => finals(r, 'passenger').length === 1, 'the first final segment');
    expect(finals(r, 'passenger')[0]).toMatchObject({ originalLang: 'es', translatedLang: 'es', translatedText: ES_1 });
    expect(r.translator.calls).toHaveLength(1);
    await waitFor(() => r.stages.passenger.at(-1)?.stage === 'idle' && r.out.passenger.length > 0, 'the synthesised voice');
    expect(bytesEqual(concatPcm(r.out.passenger), voice(ES_1, 'es'))).toBe(true);
    expect(directAudioFor('passenger_to_operator', DEFAULT_LANGUAGE_SETTINGS, UNKNOWN_LANGUAGE_STATE)).toBe(false);
    expect(directAudioFor('passenger_to_operator', DEFAULT_LANGUAGE_SETTINGS, r.languageStates.at(-1)!.state)).toBe(true);

    // Phrase 2: Spanish is now usable, so the session relays the original voice and nothing is synthesised; the
    // translator is still asked once more (second signal) so the language becomes CONFIRMED.
    const audioBefore = r.out.passenger.length;
    say(r, 'passenger', ES_2, 'es');
    await waitFor(() => finals(r, 'passenger').length === 2, 'the second final segment');
    expect(finals(r, 'passenger')[1]).toMatchObject({ originalLang: 'es', translatedLang: 'es', translatedText: ES_2 });
    expect(r.translator.calls).toHaveLength(2);
    await waitFor(() => r.languageStates.at(-1)?.state.status === 'confirmed', 'the confirmation');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(r.out.passenger).toHaveLength(audioBefore);

    // Phrase 3: confirmed and relayed: no translator call at all.
    say(r, 'passenger', 'gracias por su ayuda con la reserva', 'es');
    await waitFor(() => finals(r, 'passenger').length === 3, 'the third final segment');
    expect(r.translator.calls).toHaveLength(2);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(r.out.passenger).toHaveLength(audioBefore);
    await r.passenger.close();
    await r.operator.close();
  });

  it('Manual mode with the same language on both sides: nothing is translated or synthesised in either direction (the original voice is relayed)', async () => {
    const same: LanguageSettings = { operatorLang: 'es', passengerSpeaks: { mode: 'fixed', lang: 'es' }, passengerHears: { mode: 'fixed', lang: 'es' } };
    expect(directAudioFor('passenger_to_operator', same, UNKNOWN_LANGUAGE_STATE)).toBe(true);
    expect(directAudioFor('operator_to_passenger', same, UNKNOWN_LANGUAGE_STATE)).toBe(true);
    const r = rig({ settings: same });
    say(r, 'passenger', 'hola buenos días necesito ayuda', 'es');
    say(r, 'operator', 'buenos días le atiende telecomway', 'es');
    await waitFor(() => finals(r, 'passenger').length === 1 && finals(r, 'operator').length === 1, 'both segments');
    expect(finals(r, 'passenger')[0]).toMatchObject({ translatedLang: 'es', translatedText: 'hola buenos días necesito ayuda' });
    expect(finals(r, 'operator')[0]).toMatchObject({ translatedLang: 'es', translatedText: 'buenos días le atiende telecomway' });
    expect(r.translator.calls).toHaveLength(0);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(r.out.passenger).toHaveLength(0);
    expect(r.out.operator).toHaveLength(0);
    await r.passenger.close();
    await r.operator.close();
  });

  it('while the original voice is relayed, a change to another language is still noticed and the translation resumes', async () => {
    const r = rig({ pipeline: { controller: { switchSegments: 2 } } });
    say(r, 'passenger', 'hola buenos días necesito ayuda', 'es');
    await waitFor(() => finals(r, 'passenger').length === 1, 'the first Spanish phrase');
    say(r, 'passenger', 'necesito un hotel para esta noche por favor', 'es');
    await waitFor(() => finals(r, 'passenger').length === 2 && r.languageStates.at(-1)?.state.status === 'confirmed', 'Spanish confirmed');
    expect(directAudioFor('passenger_to_operator', DEFAULT_LANGUAGE_SETTINGS, r.languageStates.at(-1)!.state)).toBe(true);
    const calls = r.translator.calls.length;
    // English phrases while Spanish is relayed: translated on screen (and used as evidence) but not spoken, because
    // the operator is hearing the original voice; after `switchSegments` the detection changes and speech resumes.
    say(r, 'passenger', EN, 'en');
    await waitFor(() => finals(r, 'passenger').length === 3, 'the first English phrase');
    expect(r.translator.calls.length).toBe(calls + 1);
    expect(finals(r, 'passenger')[2]).toMatchObject({ translatedLang: 'es', translatedText: EN_ES });
    say(r, 'passenger', EN, 'en');
    await waitFor(() => finals(r, 'passenger').length === 4, 'the second English phrase');
    await waitFor(() => r.languageStates.some((e) => e.notice?.kind === 'changed' && e.notice.lang === 'en'), 'the language change');
    expect(directAudioFor('passenger_to_operator', DEFAULT_LANGUAGE_SETTINGS, r.languageStates.at(-1)!.state)).toBe(false);
    const spokenBefore = concatPcm(r.out.passenger).byteLength;
    say(r, 'passenger', EN, 'en');
    await waitFor(() => finals(r, 'passenger').length === 5, 'the third English phrase');
    await waitFor(() => concatPcm(r.out.passenger).byteLength >= spokenBefore + voice(EN_ES, 'es').byteLength, 'the translated voice again');
    await r.passenger.close();
    await r.operator.close();
  });

  it('keeps the original text and reports an error when the translator fails', async () => {
    const r = rig({ translator: { failWhen: () => true } });
    const errors: Error[] = [];
    r.passenger.onError((e) => errors.push(e));
    say(r, 'passenger', EN, 'en');
    await waitFor(() => finals(r, 'passenger').length === 1, 'the final segment');
    expect(finals(r, 'passenger')[0]).toMatchObject({ originalText: EN, translatedText: null, translatedLang: null });
    expect(errors).toHaveLength(1);
    expect(r.stages.passenger.some((e) => e.stage === 'error' && e.detail?.includes('traducir'))).toBe(true);
    expect(r.out.passenger).toHaveLength(0);
    await r.passenger.close();
    await r.operator.close();
  });

  it('warns that the language changed only after three confirming phrases', async () => {
    const r = rig();
    const phrases: [string, string][] = [
      [EN, 'en'],
      ['hello thanks where is the hotel please', 'en'],
      ['obrigado preciso de ajuda com o voo', 'pt'],
      ['olá estou com um problema no voo', 'pt'],
      ['bom dia preciso de um hotel para hoje', 'pt'],
    ];
    // One phrase at a time, like a real conversation (the pre-connection audio buffer is bounded).
    for (const [index, [text, lang]] of phrases.entries()) {
      say(r, 'passenger', text, lang);
      await waitFor(() => finals(r, 'passenger').length === index + 1, `phrase ${index + 1}`);
    }
    const changes = r.languageStates.filter((e) => e.notice?.kind === 'changed');
    expect(changes).toHaveLength(1);
    expect(changes[0]!.state).toMatchObject({ lang: 'pt', status: 'confirmed' });
    expect(r.languageStates.some((e) => e.state.lang === 'en' && e.state.status === 'confirmed')).toBe(true);
    await r.passenger.close();
    await r.operator.close();
  });

  it('raises an uncertain warning when the two detection signals disagree', async () => {
    const r = rig({ translator: { detect: () => 'es' } });
    say(r, 'passenger', EN, 'pt');
    await waitFor(() => r.languageStates.some((e) => e.notice?.kind === 'uncertain'), 'the uncertain notice');
    const event = r.languageStates.find((e) => e.notice?.kind === 'uncertain')!;
    expect(event.notice?.candidates).toEqual({ stt: 'pt', translator: 'es' });
    expect(event.state.status).toBe('uncertain');
    await r.passenger.close();
    await r.operator.close();
  });

  it('records latency metrics for spoken phrases', async () => {
    const r = rig();
    say(r, 'passenger', EN, 'en');
    await waitFor(() => r.passenger.getMetrics().segments === 1, 'a metric');
    const metrics = r.passenger.getMetrics();
    expect(metrics.last?.totalMs).toBeGreaterThanOrEqual(0);
    expect(metrics.p95TotalMs).not.toBeNull();
    await r.passenger.close();
    await r.operator.close();
  });
});

describe('operator to passenger', () => {
  it('holds the operator text until the passenger language is known, then speaks in it', async () => {
    const r = rig();
    say(r, 'operator', ES_CHECK, 'es');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(finals(r, 'operator')).toHaveLength(0);
    expect(r.out.operator).toHaveLength(0);

    r.operator.setPassengerLanguageState({ lang: 'pt', status: 'confirmed', source: 'stt+translator', probability: null, agreeingSegments: 2 });
    await waitFor(() => finals(r, 'operator').length === 1, 'the released phrase');
    expect(finals(r, 'operator')[0]).toMatchObject({
      speaker: 'operator',
      originalLang: 'es',
      translatedLang: 'pt',
      translatedText: 'Vou verificar as opções de alojamento disponíveis.',
    });
    await waitFor(() => r.stages.operator.at(-1)?.stage === 'idle' && r.out.operator.length > 0, 'the voice to finish');
    expect(bytesEqual(concatPcm(r.out.operator), voice('Vou verificar as opções de alojamento disponíveis.', 'pt'))).toBe(true);
    await r.passenger.close();
    await r.operator.close();
  });

  it('uses the fallback language and warns the operator when the passenger language never becomes known', async () => {
    const r = rig({ pipeline: { holdMs: 60 } });
    say(r, 'operator', ES_CHECK, 'es');
    await waitFor(() => finals(r, 'operator').length === 1, 'the phrase after the hold');
    expect(finals(r, 'operator')[0]).toMatchObject({ translatedLang: 'en', translatedText: 'I will check the available accommodation options.' });
    expect(r.operatorLanguageEvents.some((e) => e.notice?.kind === 'fallback_used' && e.notice.lang === 'en')).toBe(true);
    await r.passenger.close();
    await r.operator.close();
  });

  it('with a fixed voice language speaks at once, without waiting for detection (mixed mode)', async () => {
    const r = rig({ settings: { operatorLang: 'es', passengerSpeaks: { mode: 'auto' }, passengerHears: { mode: 'fixed', lang: 'it' } } });
    say(r, 'operator', ES_CHECK, 'es');
    await waitFor(() => finals(r, 'operator').length === 1, 'the phrase');
    expect(finals(r, 'operator')[0]).toMatchObject({ translatedLang: 'it', translatedText: 'Verificherò le opzioni di alloggio disponibili.' });
    await r.passenger.close();
    await r.operator.close();
  });
});

describe('language change during a call', () => {
  it('never cuts the audio that is playing: the phrase in progress ends in the old language, the next one starts in the new', async () => {
    const mixedEn: LanguageSettings = { operatorLang: 'es', passengerSpeaks: { mode: 'auto' }, passengerHears: { mode: 'fixed', lang: 'en' } };
    const r = rig({ settings: mixedEn, tts: { realtime: true, paceMs: 1 } });

    say(r, 'operator', ES_CHECK, 'es');
    await waitFor(() => r.out.operator.length > 0, 'the first phrase to start playing');
    const chunksAtSwitch = r.out.operator.length;

    // The operator switches the passenger's voice from English to French while the phrase is playing.
    r.operator.applyLanguageSettings({ ...mixedEn, passengerHears: { mode: 'fixed', lang: 'fr' } });
    say(r, 'operator', 'buenos días le atiende telecomway', 'es');

    await waitFor(() => finals(r, 'operator').length === 2, 'both phrases');
    await waitFor(() => r.stages.operator.at(-1)?.stage === 'idle', 'idle after the second phrase');

    const first = 'I will check the available accommodation options.';
    const second = '[es>fr] buenos días le atiende telecomway';
    expect(finals(r, 'operator').map((s) => s.translatedLang)).toEqual(['en', 'fr']);
    expect(finals(r, 'operator').map((s) => s.translatedText)).toEqual([first, second]);

    // The whole output is exactly phrase 1 in English followed by phrase 2 in French:
    // no chunk was dropped, duplicated or cut, and nothing overlapped.
    const expected = concatPcm([voice(first, 'en'), voice(second, 'fr')]);
    const actual = concatPcm(r.out.operator);
    expect(actual.byteLength).toBe(expected.byteLength);
    expect(bytesEqual(actual, expected)).toBe(true);

    // The French voice was prepared while the English phrase was still playing.
    expect(r.opens.map((o) => o.lang)).toEqual(['en', 'fr']);
    const frenchOpen = r.opens[1]!;
    const firstPhraseChunks = Math.ceil(voice(first, 'en').byteLength / 640);
    expect(frenchOpen.chunksSoFar).toBeGreaterThanOrEqual(chunksAtSwitch);
    expect(frenchOpen.chunksSoFar).toBeLessThan(firstPhraseChunks);
    await r.passenger.close();
    await r.operator.close();
  });

  it('switching to a fixed passenger language reopens the transcription at a phrase boundary', async () => {
    const fixedFr: LanguageSettings = { operatorLang: 'es', passengerSpeaks: { mode: 'fixed', lang: 'fr' }, passengerHears: { mode: 'fixed', lang: 'fr' } };
    const r = rig({ settings: fixedFr });
    say(r, 'passenger', 'bonjour je voudrais savoir où est ma navette', 'fr');
    await waitFor(() => finals(r, 'passenger').length === 1, 'the first phrase');
    expect(r.sttPassenger.opens).toEqual([{ lang: 'fr' }]);
    expect(r.translator.calls[0]).toMatchObject({ from: 'fr', to: 'es' });

    r.passenger.applyLanguageSettings({ ...fixedFr, passengerSpeaks: { mode: 'fixed', lang: 'it' } });
    await waitFor(() => r.sttPassenger.opens.length === 2, 'the transcription to reopen');
    expect(r.sttPassenger.opens[1]).toEqual({ lang: 'it' });

    say(r, 'passenger', 'buongiorno vorrei sapere dov è il mio volo', 'it');
    await waitFor(() => finals(r, 'passenger').length === 2, 'the Italian phrase');
    expect(finals(r, 'passenger')[1]).toMatchObject({ originalLang: 'it', translatedLang: 'es' });
    expect(r.translator.calls[1]).toMatchObject({ from: 'it' });
    await r.passenger.close();
    await r.operator.close();
  });

  it('going from automatic to manual makes the operator choice effective at once', async () => {
    const r = rig();
    say(r, 'operator', ES_CHECK, 'es');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(finals(r, 'operator')).toHaveLength(0);
    r.operator.applyLanguageSettings({ operatorLang: 'es', passengerSpeaks: { mode: 'fixed', lang: 'pt' }, passengerHears: { mode: 'fixed', lang: 'pt' } });
    // Held phrases keep the settings they were finalised with (automatic): the detected language still decides.
    r.operator.setPassengerLanguageState({ lang: 'it', status: 'confirmed', source: 'stt+translator', probability: null, agreeingSegments: 2 });
    await waitFor(() => finals(r, 'operator').length === 1, 'the held phrase');
    expect(finals(r, 'operator')[0]!.translatedLang).toBe('it');
    say(r, 'operator', 'buenos días le atiende telecomway', 'es');
    await waitFor(() => finals(r, 'operator').length === 2, 'the next phrase');
    expect(finals(r, 'operator')[1]!.translatedLang).toBe('pt');
    await r.passenger.close();
    await r.operator.close();
  });
});

describe('lifecycle', () => {
  it('stops retrying a transcription that cannot be opened and backs off instead of hammering the service with every chunk', async () => {
    let clock = 0;
    let opens = 0;
    const broken: SttProvider = {
      openSession: (): Promise<SttSession> => {
        opens += 1;
        return Promise.reject(new Error('401 clave rechazada'));
      },
    };
    const details: string[] = [];
    const pipe = new TranslationDirectionPipeline(
      { callId: CALL, direction: 'passenger_to_operator', settings: DEFAULT_LANGUAGE_SETTINGS },
      { stt: broken, translator: new MockTextTranslator(), tts: new MockTts({}) },
      { sttRetries: 1, sttRetryDelayMs: 1, sttBackoffMinMs: 1000, sttBackoffMaxMs: 4000, errorDisplayMs: 10, now: () => clock },
    );
    pipe.onStage((event) => {
      if (event.stage === 'error' && event.detail) details.push(event.detail);
    });
    const chunk = synthesizeSpeechSignal('hola', { pitchHz: 200 }).slice(0, 640);
    pipe.pushAudio(chunk);
    await waitFor(() => opens === 2, 'the first cycle of attempts');
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Fifty more chunks within the back-off window: not a single new attempt.
    for (let i = 0; i < 50; i++) pipe.pushAudio(chunk);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(opens).toBe(2);
    expect(details.at(-1)).toContain('se volverá a intentar en 1 s');

    clock += 1000;
    pipe.pushAudio(chunk);
    await waitFor(() => opens === 4, 'the second cycle after the back-off');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(details.at(-1)).toContain('se volverá a intentar en 2 s');
    pipe.pushAudio(chunk);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(opens).toBe(4);

    // A settings change is a reason to try again at once.
    pipe.applyLanguageSettings({ ...DEFAULT_LANGUAGE_SETTINGS, passengerSpeaks: { mode: 'fixed', lang: 'fr' } });
    await waitFor(() => opens === 6, 'a fresh attempt after the settings change');
    await pipe.close();
  });

  it('close() is idempotent and later audio is ignored', async () => {
    const r = rig();
    await r.operator.close();
    await r.operator.close();
    expect(() => r.operator.pushAudio(silencePcm16(20))).not.toThrow();
    await r.passenger.close();
  });
});
