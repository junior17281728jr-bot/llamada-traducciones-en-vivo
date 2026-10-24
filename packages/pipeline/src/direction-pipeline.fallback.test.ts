import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LANGUAGE_SETTINGS,
  concatPcm,
  silencePcm16,
  synthesizeSpeechSignal,
  type DirectionFallback,
  type PcmChunk,
  type SttProvider,
  type SttSession,
  type TtsProvider,
  type TtsSession,
  type Unsubscribe,
} from '@tw/shared';
import { TranslationDirectionPipeline, type DirectionPipelineOptions } from './direction-pipeline.js';
import { utteranceKey } from './factory.js';
import { MockTextTranslator, type MockTranslatorOptions } from './mock/mock-translator.js';
import { MockTts, mockVoicePitchHz } from './mock/mock-tts.js';
import { NoSystemVoiceEngine } from './system-voice/engines.js';
import { SystemTtsProvider } from './system-voice/system-tts.js';
import { ScriptedStt } from './mock/scripted-stt.js';
import { UtteranceBus } from './mock/utterance-bus.js';
import { Emitter } from './util/emitter.js';

const CALL = 'c-fallback';
const EN = 'my flight was cancelled and I need a hotel';
const EN_ES = 'Mi vuelo fue cancelado y necesito un hotel.';

type BrokenMode = 'open-fails' | 'error-before-audio' | 'never-answers';

/** A main voice that fails the way a real service can: refuses to open, errors, or never sends audio. */
class BrokenTts implements TtsProvider {
  opens = 0;
  constructor(public mode: BrokenMode | 'works') {}
  openSession(options: { lang: string }): Promise<TtsSession> {
    this.opens += 1;
    if (this.mode === 'open-fails') return Promise.reject(new Error('401 clave de ElevenLabs rechazada'));
    if (this.mode === 'works') return new MockTts({}).openSession(options);
    return Promise.resolve(new BrokenSession(options.lang, this.mode));
  }
}

class BrokenSession implements TtsSession {
  private readonly errors = new Emitter<Error>();
  private readonly audio = new Emitter<PcmChunk>();
  private readonly done = new Emitter<void>();
  constructor(
    readonly lang: string,
    private readonly mode: BrokenMode,
  ) {}
  speak(): void {}
  flush(): void {
    if (this.mode === 'error-before-audio') queueMicrotask(() => this.errors.emit(new Error('socket cerrado')));
  }
  cancel(): void {}
  prewarm(): Promise<void> {
    return Promise.resolve();
  }
  onAudio(handler: (pcm: PcmChunk) => void): Unsubscribe {
    return this.audio.on(handler);
  }
  onDone(handler: () => void): Unsubscribe {
    return this.done.on(handler);
  }
  onError(handler: (error: Error) => void): Unsubscribe {
    return this.errors.on(handler);
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

/** The plan B voice: a mock that counts what it spoke. */
function backupVoice() {
  const spoken: string[] = [];
  const tts = new MockTts({ onOpen: (lang) => spoken.push(lang) });
  return { tts, spoken };
}

interface RigOptions {
  tts?: TtsProvider;
  fallbackTts?: TtsProvider;
  stt?: SttProvider;
  translator?: MockTranslatorOptions;
  pipeline?: Partial<DirectionPipelineOptions>;
}

function rig(options: RigOptions = {}) {
  const bus = new UtteranceBus();
  const stt = options.stt ?? new ScriptedStt({ bus, key: utteranceKey(CALL, 'passenger') });
  const pipe = new TranslationDirectionPipeline(
    { callId: CALL, direction: 'passenger_to_operator', settings: DEFAULT_LANGUAGE_SETTINGS },
    {
      stt,
      translator: new MockTextTranslator(options.translator),
      tts: options.tts ?? new MockTts({}),
      ...(options.fallbackTts ? { fallbackTts: options.fallbackTts } : {}),
    },
    {
      holdMs: 200,
      receivingHangoverMs: 30,
      errorDisplayMs: 30,
      fallback: { systemVoice: true, originalVoice: true },
      voiceFirstAudioTimeoutMs: 150,
      ...options.pipeline,
    },
  );
  const out: Uint8Array[] = [];
  const fallbacks: DirectionFallback[] = [];
  pipe.onAudio((pcm) => out.push(pcm));
  pipe.onFallback((state) => fallbacks.push(state));
  return { bus, pipe, out, fallbacks };
}

type Rig = ReturnType<typeof rig>;

function say(r: Rig, text: string, lang: string): void {
  r.bus.say(utteranceKey(CALL, 'passenger'), { text, lang });
  const signal = concatPcm([synthesizeSpeechSignal(text, { pitchHz: 200 }), silencePcm16(200)]);
  for (let offset = 0; offset < signal.byteLength; offset += 640) r.pipe.pushAudio(signal.slice(offset, offset + 640));
}

async function waitFor(condition: () => boolean, what: string, timeoutMs = 4000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error(`Timeout waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const spanishVoice = (): Uint8Array => synthesizeSpeechSignal(EN_ES, { pitchHz: mockVoicePitchHz('es') });
const same = (a: Uint8Array, b: Uint8Array): boolean => Buffer.from(a).equals(Buffer.from(b));

describe('plan B: the computer voice when the main voice fails', () => {
  for (const mode of ['open-fails', 'error-before-audio', 'never-answers'] as const) {
    it(`speaks the phrase with the plan B voice when the main voice ${mode}`, async () => {
      const backup = backupVoice();
      const r = rig({ tts: new BrokenTts(mode), fallbackTts: backup.tts });
      say(r, EN, 'en');
      await waitFor(() => r.fallbacks.some((state) => state.systemVoice), 'the system voice state');
      await waitFor(() => concatPcm(r.out).byteLength >= spanishVoice().byteLength, 'the translated phrase');
      expect(same(concatPcm(r.out), spanishVoice())).toBe(true);
      expect(backup.spoken).toContain('es');
      expect(r.pipe.getFallback()).toMatchObject({ systemVoice: true, originalVoice: false });
      expect(r.pipe.getFallback().detail).toContain('voz del ordenador');
      await r.pipe.close();
    });
  }

  it('after a failure the next phrase goes straight to the plan B voice, and the main voice is tried again later', async () => {
    let clock = 1000;
    const main = new BrokenTts('open-fails');
    const backup = backupVoice();
    const r = rig({ tts: main, fallbackTts: backup.tts, pipeline: { now: () => clock, primaryVoiceCooldownMs: 60_000 } });
    say(r, EN, 'en');
    await waitFor(() => r.out.length > 0 && r.pipe.getFallback().systemVoice, 'the first phrase');
    const opensAfterFirst = main.opens;
    r.out.length = 0;
    say(r, EN, 'en');
    await waitFor(() => concatPcm(r.out).byteLength >= spanishVoice().byteLength, 'the second phrase');
    expect(main.opens).toBe(opensAfterFirst);

    // The main voice is back: after the cooldown it is used again and the plan B state clears.
    main.mode = 'works';
    clock += 61_000;
    r.out.length = 0;
    say(r, EN, 'en');
    await waitFor(() => !r.pipe.getFallback().systemVoice, 'the main voice back');
    expect(main.opens).toBeGreaterThan(opensAfterFirst);
    await r.pipe.close();
  });

  it('with the plan B voice turned off, a broken main voice leaves the text and relays the original voice', async () => {
    const backup = backupVoice();
    const r = rig({ tts: new BrokenTts('open-fails'), fallbackTts: backup.tts, pipeline: { fallback: { systemVoice: false, originalVoice: true } } });
    say(r, EN, 'en');
    await waitFor(() => r.pipe.getFallback().originalVoice, 'the original voice relay');
    expect(backup.spoken).toHaveLength(0);
    expect(r.out).toHaveLength(0);
    expect(r.pipe.getFallback().detail).toContain('voz original');
    await r.pipe.close();
  });

  it('when every voice fails, the original voice is relayed for a while and then the voices are tried again', async () => {
    const r = rig({ tts: new BrokenTts('open-fails'), fallbackTts: new BrokenTts('open-fails'), pipeline: { voiceRetryMs: 80 } });
    say(r, EN, 'en');
    await waitFor(() => r.pipe.getFallback().originalVoice, 'the relay');
    await waitFor(() => !r.pipe.getFallback().originalVoice, 'the retry window');
    await r.pipe.close();
  });
});

describe('plan B never plays translated audio over the original voice', () => {
  it('drops a phrase already queued or playing as soon as the relay starts', async () => {
    let n = 0;
    const r = rig({
      translator: { failWhen: () => ++n >= 3 },
      tts: new MockTts({ realtime: true }),
      pipeline: { fallback: { systemVoice: false, originalVoice: true } },
    });
    let relaying = false;
    let overlapped = 0;
    r.pipe.onFallback((state) => {
      relaying = state.originalVoice;
    });
    r.pipe.onAudio((pcm) => {
      if (relaying) overlapped += pcm.byteLength;
    });
    say(r, 'my flight was cancelled and I need a hotel for tonight please', 'en');
    say(r, 'where is the baggage claim for international arrivals', 'en');
    say(r, 'thank you very much', 'en');
    await waitFor(() => relaying, 'the relay', 8000);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(overlapped).toBe(0);
    await r.pipe.close();
  });

  it('while the main voice cools down, it is still tried when the computer voice cannot speak', async () => {
    let fails = 1;
    let opens = 0;
    const flaky: TtsProvider = {
      openSession: (options) => {
        opens += 1;
        if (fails-- > 0) return Promise.reject(new Error('ElevenLabs 503 una vez'));
        return new MockTts({}).openSession(options);
      },
    };
    const r = rig({ tts: flaky, fallbackTts: new SystemTtsProvider(new NoSystemVoiceEngine()), pipeline: { voiceRetryMs: 200 } });
    say(r, EN, 'en');
    await waitFor(() => r.pipe.getFallback().originalVoice, 'the relay after both voices failed');
    await waitFor(() => !r.pipe.getFallback().originalVoice, 'the retry window');
    say(r, EN, 'en');
    await waitFor(() => concatPcm(r.out).byteLength >= spanishVoice().byteLength, 'the main voice again, inside its cooldown');
    expect(opens).toBe(2);
    await r.pipe.close();
  });
});

describe('plan B: the original voice when transcription or translation is down', () => {
  it('relays the original voice while the translator fails, and stops as soon as a translation works', async () => {
    let failing = true;
    const r = rig({ translator: { failWhen: () => failing } });
    say(r, EN, 'en');
    await waitFor(() => r.pipe.getFallback().originalVoice, 'the relay');
    expect(r.pipe.getFallback().detail).toContain('traducción no responde');
    expect(r.out).toHaveLength(0);

    // This phrase was said while the original voice was relayed: it is translated on screen but not spoken late.
    failing = false;
    say(r, EN, 'en');
    await waitFor(() => !r.pipe.getFallback().originalVoice, 'the end of the relay');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(r.out).toHaveLength(0);

    // The next phrase is translated and spoken again.
    say(r, EN, 'en');
    await waitFor(() => concatPcm(r.out).byteLength >= spanishVoice().byteLength, 'the translated phrase spoken again');
    await r.pipe.close();
  });

  it('relays the original voice while the transcription cannot connect, and drops the audio already heard when it comes back', async () => {
    let clock = 0;
    let broken = true;
    const bus = new UtteranceBus();
    const scripted = new ScriptedStt({ bus, key: utteranceKey(CALL, 'passenger') });
    const sent: number[] = [];
    const stt: SttProvider = {
      openSession: async (options): Promise<SttSession> => {
        if (broken) throw new Error('ElevenLabs no responde');
        const session = await scripted.openSession(options);
        const original = session.sendAudio.bind(session);
        session.sendAudio = (pcm) => {
          sent.push(pcm.byteLength);
          original(pcm);
        };
        return session;
      },
    };
    const r = rig({ stt, pipeline: { sttRetries: 0, sttBackoffMinMs: 1000, now: () => clock } });
    const chunk = synthesizeSpeechSignal('hello', { pitchHz: 200 }).slice(0, 640);
    for (let i = 0; i < 20; i++) r.pipe.pushAudio(chunk);
    await waitFor(() => r.pipe.getFallback().originalVoice, 'the relay');
    expect(r.pipe.getFallback().detail).toContain('transcripción no responde');

    broken = false;
    clock += 1000;
    r.pipe.pushAudio(chunk);
    await waitFor(() => !r.pipe.getFallback().originalVoice, 'the end of the relay');
    // Only the chunk that arrived after the recovery reached the transcription, not the 20 relayed ones.
    expect(sent.reduce((sum, bytes) => sum + bytes, 0)).toBeLessThanOrEqual(640);
    await r.pipe.close();
  });

  it('with the original voice turned off, nothing is relayed (only the error is shown)', async () => {
    const r = rig({ translator: { failWhen: () => true }, pipeline: { fallback: { systemVoice: true, originalVoice: false } } });
    const errors: Error[] = [];
    r.pipe.onError((error) => errors.push(error));
    say(r, EN, 'en');
    await waitFor(() => errors.length > 0, 'the translation error');
    expect(r.pipe.getFallback().originalVoice).toBe(false);
    expect(r.fallbacks).toHaveLength(0);
    await r.pipe.close();
  });

  it('a pipeline without plan B (the default) never reports one', async () => {
    const bus = new UtteranceBus();
    const pipe = new TranslationDirectionPipeline(
      { callId: CALL, direction: 'passenger_to_operator', settings: DEFAULT_LANGUAGE_SETTINGS },
      { stt: new ScriptedStt({ bus, key: utteranceKey(CALL, 'passenger') }), translator: new MockTextTranslator({ failWhen: () => true }), tts: new BrokenTts('open-fails') },
      { holdMs: 200, errorDisplayMs: 10 },
    );
    const states: DirectionFallback[] = [];
    pipe.onFallback((state) => states.push(state));
    bus.say(utteranceKey(CALL, 'passenger'), { text: EN, lang: 'en' });
    const signal = concatPcm([synthesizeSpeechSignal(EN, { pitchHz: 200 }), silencePcm16(200)]);
    for (let offset = 0; offset < signal.byteLength; offset += 640) pipe.pushAudio(signal.slice(offset, offset + 640));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(states).toHaveLength(0);
    expect(pipe.getFallback()).toEqual({ systemVoice: false, originalVoice: false, detail: null });
    await pipe.close();
  });
});
