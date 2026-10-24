import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { concatPcm, generateSinePcm16, pcm16ToWav, type PcmChunk } from '@tw/shared';
import {
  MacSayEngine,
  NoSystemVoiceEngine,
  SystemVoiceError,
  WindowsSapiEngine,
  parseSayVoices,
  parseWindowsVoices,
  pickSystemVoice,
  wavToInternalPcm,
  type VoiceWorkerProcess,
} from './engines.js';
import { SystemTtsProvider } from './system-tts.js';

const SAY_OUTPUT = [
  'Albert              en_US    # Hello! My name is Albert.',
  'Bad News            en_US    # Hello! My name is Bad News.',
  'Eddy (English (UK)) en_GB    # Hello! My name is Eddy.',
  'Samantha            en_US    # Hello! My name is Samantha.',
  'Mónica              es_ES    # ¡Hola! Me llamo Mónica.',
  'Paulina             es_MX    # ¡Hola! Me llamo Paulina.',
  'Thomas              fr_FR    # Bonjour, je m’appelle Thomas.',
  'Luciana             pt_BR    # Olá, o meu nome é Luciana.',
  'Joana               pt_PT    # Olá! Chamo-me Joana.',
  'Nora                nb_NO    # Hei, jeg heter Nora.',
].join('\n');

describe('choosing the computer voice', () => {
  const voices = parseSayVoices(SAY_OUTPUT);

  it('reads the macOS voice list, including names with spaces and parentheses', () => {
    expect(voices).toHaveLength(10);
    expect(voices[2]).toEqual({ name: 'Eddy (English (UK))', locale: 'en-GB' });
  });

  it('prefers the main locale and natural voices, and never a novelty voice', () => {
    expect(pickSystemVoice(voices, 'es')?.name).toBe('Mónica');
    expect(pickSystemVoice(voices, 'en')?.name).toBe('Samantha');
    expect(pickSystemVoice(voices, 'pt')?.name).toBe('Joana');
    expect(pickSystemVoice(voices, 'no')?.name).toBe('Nora');
    expect(pickSystemVoice(voices.filter((v) => v.name !== 'Samantha' && !v.name.startsWith('Eddy')), 'en')).toBeNull();
  });

  it('says there is no voice instead of reading a language with another one', () => {
    expect(pickSystemVoice(voices, 'it')).toBeNull();
  });

  it('reads the Windows voice list', () => {
    const list = parseWindowsVoices('READY es-ES|Microsoft Helena Desktop;en-US|Microsoft Zira Desktop');
    expect(list).toEqual([
      { locale: 'es-ES', name: 'Microsoft Helena Desktop' },
      { locale: 'en-US', name: 'Microsoft Zira Desktop' },
    ]);
    expect(pickSystemVoice(list, 'es')?.name).toBe('Microsoft Helena Desktop');
    expect(parseWindowsVoices('READY ')).toEqual([]);
  });
});

describe('WAV to the internal format', () => {
  it('keeps 16 kHz mono as it is, resamples other rates and mixes stereo down', () => {
    const tone = generateSinePcm16(440, 100, 0.3, 16000);
    expect(Buffer.from(wavToInternalPcm(pcm16ToWav(tone, 16000, 1))).equals(Buffer.from(tone))).toBe(true);
    const at22k = generateSinePcm16(440, 100, 0.3, 22050);
    expect(wavToInternalPcm(pcm16ToWav(at22k, 22050, 1)).byteLength).toBeGreaterThan(3150);
    expect(wavToInternalPcm(pcm16ToWav(at22k, 22050, 1)).byteLength).toBeLessThan(3250);
    const stereo = concatPcm([tone, tone]);
    expect(wavToInternalPcm(pcm16ToWav(stereo, 16000, 2)).byteLength).toBe(tone.byteLength);
  });
});

describe('macOS engine', () => {
  it('writes the text to a file, asks `say` for 16-bit 16 kHz and returns the audio', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tw-say-'));
    const calls: string[][] = [];
    let textSeen = '';
    const engine = new MacSayEngine({
      tempDir: dir,
      run: async (command, args) => {
        calls.push([command, ...args]);
        if (args[0] === '-v' && args[1] === '?') return { stdout: SAY_OUTPUT };
        const out = args[args.indexOf('-o') + 1]!;
        textSeen = await readFile(args[args.indexOf('-f') + 1]!, 'utf8');
        await writeFile(out, pcm16ToWav(generateSinePcm16(300, 200, 0.3, 16000), 16000, 1));
        return { stdout: '' };
      },
    });
    const pcm = await engine.synthesize('-- ¿Dónde está su hotel?', 'es');
    expect(pcm.byteLength).toBe(6400);
    expect(textSeen).toBe('-- ¿Dónde está su hotel?');
    expect(calls[1]).toEqual(expect.arrayContaining(['say', '-v', 'Mónica', '--data-format=LEI16@16000']));
    await expect(engine.synthesize('ciao', 'it')).rejects.toMatchObject({ kind: 'no_voice' });
  });

  it('reports a failure of `say` as a system voice error', async () => {
    const engine = new MacSayEngine({
      run: (_command, args) => (args[1] === '?' ? Promise.resolve({ stdout: SAY_OUTPUT }) : Promise.reject(new Error('exit 1'))),
    });
    await expect(engine.synthesize('hola', 'es')).rejects.toBeInstanceOf(SystemVoiceError);
  });
});

/** A fake PowerShell worker that speaks the line protocol of WINDOWS_VOICE_SCRIPT. */
class FakeWorker extends EventEmitter implements VoiceWorkerProcess {
  readonly stdout = new EventEmitter();
  readonly requests: { voice: string; text: string; out: string }[] = [];
  killed = false;
  constructor(
    private readonly behaviour: { voices?: string; fail?: boolean; silent?: boolean } = {},
  ) {
    super();
    queueMicrotask(() => this.stdout.emit('data', Buffer.from(`﻿READY ${behaviour.voices ?? 'es-ES|Microsoft Helena Desktop;en-US|Microsoft Zira Desktop'}\r\n`)));
  }
  readonly stdin = {
    write: (data: string): boolean => {
      const request = JSON.parse(Buffer.from(data.trim(), 'base64').toString('utf8')) as { id: string; voice: string; text: string; out: string };
      this.requests.push(request);
      if (this.behaviour.silent) return true;
      void (async () => {
        if (this.behaviour.fail) {
          this.stdout.emit('data', `ERR ${request.id} No se pudo seleccionar la voz\r\n`);
          return;
        }
        await writeFile(request.out, pcm16ToWav(generateSinePcm16(300, 100, 0.3, 16000), 16000, 1));
        // Answers may arrive split across chunks.
        this.stdout.emit('data', 'OK ');
        this.stdout.emit('data', `${request.id}\r\n`);
      })();
      return true;
    },
    end: (): void => undefined,
  };
  kill(): boolean {
    this.killed = true;
    this.emit('exit', 1);
    return true;
  }
}

describe('Windows engine', () => {
  it('keeps one worker for every phrase and reads the WAV it writes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tw-sapi-'));
    const workers: FakeWorker[] = [];
    const engine = new WindowsSapiEngine({ tempDir: dir, spawn: () => workers[workers.push(new FakeWorker()) - 1]! });
    const [first, second] = await Promise.all([engine.synthesize('Hola, buenos días', 'es'), engine.synthesize('Hello there', 'en')]);
    expect(first.byteLength).toBe(3200);
    expect(second.byteLength).toBe(3200);
    expect(workers).toHaveLength(1);
    expect(workers[0]!.requests.map((r) => r.voice)).toEqual(['Microsoft Helena Desktop', 'Microsoft Zira Desktop']);
    await expect(engine.synthesize('Bonjour', 'fr')).rejects.toMatchObject({ kind: 'no_voice' });
    await engine.close();
    expect(workers[0]!.killed).toBe(true);
  });

  it('turns an ERR answer into an error and a stuck worker into a timeout with a fresh worker next time', async () => {
    const failing = new WindowsSapiEngine({ spawn: () => new FakeWorker({ fail: true }) });
    await expect(failing.synthesize('Hola', 'es')).rejects.toThrow(/No se pudo seleccionar la voz/);
    await failing.close();

    const workers: FakeWorker[] = [];
    const stuck = new WindowsSapiEngine({ timeoutMs: 100, spawn: () => workers[workers.push(new FakeWorker({ silent: workers.length === 0 })) - 1]! });
    await expect(stuck.synthesize('Hola', 'es')).rejects.toMatchObject({ kind: 'timeout' });
    expect(workers[0]!.killed).toBe(true);
    const dir = await mkdtemp(join(tmpdir(), 'tw-sapi-'));
    void dir;
    await expect(stuck.synthesize('Hola', 'es')).resolves.toBeInstanceOf(Uint8Array);
    expect(workers).toHaveLength(2);
    await stuck.close();
  });

  it('reports a computer without the Windows voice', async () => {
    const engine = new WindowsSapiEngine({
      spawn: () => {
        throw new Error('ENOENT powershell.exe');
      },
    });
    await expect(engine.voices()).rejects.toMatchObject({ kind: 'unsupported' });
  });
});

describe('SystemTtsProvider', () => {
  it('speaks what was queued in chunks and says when it is done', async () => {
    const engine = new MacSayEngine({
      run: async (_command, args) => {
        if (args[1] === '?') return { stdout: SAY_OUTPUT };
        await writeFile(args[args.indexOf('-o') + 1]!, pcm16ToWav(generateSinePcm16(300, 250, 0.3, 16000), 16000, 1));
        return { stdout: '' };
      },
    });
    const session = await new SystemTtsProvider(engine, { chunkMs: 100 }).openSession({ lang: 'es' });
    const chunks: PcmChunk[] = [];
    session.onAudio((pcm) => chunks.push(pcm));
    const done = new Promise<void>((resolve) => session.onDone(resolve));
    session.speak('Hola');
    session.speak('¿qué tal?');
    session.flush();
    await done;
    expect(chunks.map((c) => c.byteLength)).toEqual([3200, 3200, 1600]);
    await session.close();
  });

  it('reports an error for a language without voice, and refuses to open where there is no system voice', async () => {
    const engine = new MacSayEngine({ run: () => Promise.resolve({ stdout: SAY_OUTPUT }) });
    const session = await new SystemTtsProvider(engine).openSession({ lang: 'it' });
    const error = new Promise<Error>((resolve) => session.onError(resolve));
    session.speak('Ciao');
    session.flush();
    expect((await error).message).toContain('no tiene voz');
    await expect(new SystemTtsProvider(new NoSystemVoiceEngine()).openSession({ lang: 'es' })).rejects.toMatchObject({ kind: 'unsupported' });
  });
});
