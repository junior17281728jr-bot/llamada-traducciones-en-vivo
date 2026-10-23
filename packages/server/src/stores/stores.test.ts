import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_OPERATOR_PREFERENCES, generateSinePcm16, parseWav, type CallRecord, type RecordingLeg, type TranscriptSegment } from '@tw/shared';
import { tempDataDir } from '../test-utils.js';
import { FilePreferencesStore } from './preferences.js';
import { FileRecordingStore } from './recordings.js';
import { FileSecretsStore, maskedLast4 } from './secrets.js';
import { FileTranscriptStore } from './transcripts.js';

const KEY = 'sk_test_0123456789abcdef0123';

describe('FileSecretsStore', () => {
  it('encrypts at rest, masks outputs and prefers saved values over the environment', async () => {
    const dir = await tempDataDir();
    const store = new FileSecretsStore(dir, null, { ELEVENLABS_API_KEY: 'env-value-0000000000' });
    expect(await store.getMasked('ELEVENLABS_API_KEY')).toMatchObject({ configured: true, source: 'env', last4: '0000' });
    expect(await store.resolve('ELEVENLABS_API_KEY')).toBe('env-value-0000000000');

    await store.set('ELEVENLABS_API_KEY', KEY);
    expect(await store.resolve('ELEVENLABS_API_KEY')).toBe(KEY);
    const masked = await store.getMasked('ELEVENLABS_API_KEY');
    expect(masked).toMatchObject({ configured: true, source: 'settings', last4: KEY.slice(-4) });
    expect(JSON.stringify(await store.listMasked())).not.toContain(KEY);

    for (const name of await readdir(dir)) {
      expect(await readFile(join(dir, name), 'utf8')).not.toContain(KEY);
    }
    const reopened = new FileSecretsStore(dir, null, {});
    expect(await reopened.resolve('ELEVENLABS_API_KEY')).toBe(KEY);

    await reopened.delete('ELEVENLABS_API_KEY');
    expect(await reopened.resolve('ELEVENLABS_API_KEY')).toBeUndefined();
    expect(await reopened.getMasked('ELEVENLABS_API_KEY')).toMatchObject({ configured: false, source: 'none' });
  });

  it('works with a passphrase; with another one the saved value is reported as unusable instead of crashing', async () => {
    const dir = await tempDataDir();
    await new FileSecretsStore(dir, 'frase-secreta', {}).set('ANTHROPIC_API_KEY', KEY);
    expect(await new FileSecretsStore(dir, 'frase-secreta', {}).resolve('ANTHROPIC_API_KEY')).toBe(KEY);

    const wrong = new FileSecretsStore(dir, 'otra-frase', { ANTHROPIC_API_KEY: 'env-fallback-0123456789' });
    expect(await wrong.resolve('ANTHROPIC_API_KEY')).toBe('env-fallback-0123456789');
    expect(await wrong.isUndecryptable('ANTHROPIC_API_KEY')).toBe(true);
    const masked = await wrong.getMasked('ANTHROPIC_API_KEY');
    expect(masked).toMatchObject({ configured: true, last4: null, source: 'settings' });
    expect(masked.warning).toContain('SECRETS_KEY');
    expect(await new FileSecretsStore(dir, 'otra-frase', {}).resolve('ANTHROPIC_API_KEY')).toBeUndefined();
    // Saving again with the current key makes it usable.
    await wrong.set('ANTHROPIC_API_KEY', KEY);
    expect(await wrong.resolve('ANTHROPIC_API_KEY')).toBe(KEY);
    expect((await wrong.getMasked('ANTHROPIC_API_KEY')).warning).toBeUndefined();
  });

  it('does not reveal any part of short secrets and rejects unknown names', async () => {
    expect(maskedLast4('short')).toBeNull();
    const store = new FileSecretsStore(await tempDataDir(), null, {});
    await expect(store.set('NOT_A_KEY' as never, 'x')).rejects.toThrow('desconocido');
  });
});

describe('FilePreferencesStore', () => {
  it('returns defaults, saves valid preferences and rejects invalid ones', async () => {
    const dir = await tempDataDir();
    const store = new FilePreferencesStore(dir);
    expect(await store.get('op1')).toEqual(DEFAULT_OPERATOR_PREFERENCES);
    const prefs = { ...DEFAULT_OPERATOR_PREFERENCES, defaultMode: 'mixed' as const, defaultPassengerHears: 'en' as const, autoAccept: true };
    await store.set('op1', prefs);
    expect(await new FilePreferencesStore(dir).get('op1')).toEqual(prefs);
    await expect(store.set('op1', { ...prefs, operatorLang: 'xx' as never })).rejects.toThrow();
  });
});

const record = (id: string, createdAt: number, extra: Partial<CallRecord> = {}): CallRecord => ({
  id,
  direction: 'inbound',
  remoteNumber: '+34600111222',
  operatorId: 'op1',
  passengerLang: 'en',
  state: 'ended',
  createdAt,
  answeredAt: createdAt + 1,
  endedAt: createdAt + 5000,
  endReason: 'hangup_operator',
  recorded: false,
  ...extra,
});

const segment = (callId: string, id: string, startMs: number, text: string, final: boolean): TranscriptSegment => ({
  id,
  callId,
  speaker: 'passenger',
  originalLang: 'en',
  originalText: text,
  translatedLang: final ? 'es' : null,
  translatedText: final ? `ES ${text}` : null,
  startMs,
  endMs: startMs + 100,
  final,
  createdAt: startMs,
});

describe('FileTranscriptStore', () => {
  it('saves, lists newest first, filters and keeps the last version of each segment', async () => {
    const dir = await tempDataDir();
    const store = new FileTranscriptStore(dir);
    await store.saveCall(record('a1', 1000));
    await store.saveCall(record('a2', 2000, { direction: 'outbound', operatorId: 'op2' }));
    await store.saveCall(record('a3', 3000));
    expect((await store.listCalls()).map((c) => c.id)).toEqual(['a3', 'a2', 'a1']);
    expect((await store.listCalls({ direction: 'outbound' })).map((c) => c.id)).toEqual(['a2']);
    expect((await store.listCalls({ operatorId: 'op1', before: 3000 })).map((c) => c.id)).toEqual(['a1']);
    expect(await store.listCalls({ limit: 1 })).toHaveLength(1);

    await store.saveSegment(segment('a1', 's2', 500, 'second', true));
    await store.saveSegment(segment('a1', 's1', 100, 'fir', false));
    await store.saveSegment(segment('a1', 's1', 100, 'first', true));
    const segments = await store.getSegments('a1');
    expect(segments.map((s) => [s.id, s.originalText, s.final])).toEqual([
      ['s1', 'first', true],
      ['s2', 'second', true],
    ]);
    expect(await store.getSegments('a2')).toEqual([]);

    const reopened = new FileTranscriptStore(dir);
    expect((await reopened.getCall('a2'))?.direction).toBe('outbound');
    expect(await reopened.getCall('zzz')).toBeNull();
  });

  it('refuses unsafe identifiers (path traversal) and deletes by retention', async () => {
    const store = new FileTranscriptStore(await tempDataDir());
    await expect(store.saveCall(record('../evil', 1))).rejects.toThrow('Identificador');
    await expect(store.getSegments('../../etc/passwd')).rejects.toThrow('Identificador');
    await store.saveCall(record('old', 1000));
    await store.saveCall(record('new', 9000));
    await store.saveSegment(segment('old', 's1', 1, 'x', true));
    expect(await store.deleteOlderThan(5000)).toBe(1);
    expect((await store.listCalls()).map((c) => c.id)).toEqual(['new']);
    expect(await store.getSegments('old')).toEqual([]);
  });
});

describe('FileRecordingStore', () => {
  it('stores each leg separately, serves WAV and a mixed leg, and applies retention', async () => {
    const store = new FileRecordingStore(await tempDataDir());
    const writer = await store.open('call1');
    const passenger = generateSinePcm16(300, 500);
    const operator = generateSinePcm16(600, 250);
    writer.write('passenger', passenger);
    writer.write('operator', operator);
    const info = await writer.close();
    expect(info.durationMs).toBe(500);
    expect(info.bytes).toBe(passenger.byteLength + operator.byteLength);
    expect((await store.get('call1'))?.durationMs).toBe(500);

    const passengerWav = parseWav((await store.read('call1', 'passenger'))!);
    expect(passengerWav.sampleRate).toBe(16000);
    expect(Buffer.from(passengerWav.pcm).equals(Buffer.from(passenger))).toBe(true);
    const operatorWav = parseWav((await store.read('call1', 'operator'))!);
    expect(Buffer.from(operatorWav.pcm).equals(Buffer.from(operator))).toBe(true);
    expect(parseWav((await store.read('call1', 'mixed'))!).pcm.byteLength).toBe(passenger.byteLength);
    expect(await store.read('nope', 'passenger')).toBeNull();

    await expect(store.open('../x')).rejects.toThrow('Identificador');
    expect(await store.deleteOlderThan(info.createdAt)).toBe(0);
    expect(await store.deleteOlderThan(info.createdAt + 1)).toBe(1);
    expect(await store.get('call1')).toBeNull();
  });

  it('streams every leg from disk byte-for-byte like the in-memory WAV, including odd ranges of the mixed leg', async () => {
    const store = new FileRecordingStore(await tempDataDir());
    const writer = await store.open('call2');
    const passenger = generateSinePcm16(300, 700);
    const operator = generateSinePcm16(600, 250);
    for (let offset = 0; offset < passenger.byteLength; offset += 640) writer.write('passenger', passenger.slice(offset, offset + 640));
    writer.write('operator', operator);
    await writer.close();
    const collect = async (iterable: AsyncIterable<Buffer>): Promise<Buffer> => {
      const chunks: Buffer[] = [];
      for await (const chunk of iterable) chunks.push(chunk);
      return Buffer.concat(chunks);
    };
    for (const leg of ['passenger', 'operator', 'mixed'] as RecordingLeg[]) {
      const expected = Buffer.from((await store.read('call2', leg))!);
      const source = (await store.openLeg('call2', leg))!;
      expect(source.byteLength).toBe(expected.byteLength);
      expect((await collect(source.stream(0, source.byteLength - 1))).equals(expected)).toBe(true);
      const ranges: [number, number][] = [[0, 0], [0, 43], [43, 43], [43, 44], [44, 44], [45, 46], [1, 2], [1001, 1002], [1000, 1003], [44, expected.byteLength - 1], [expected.byteLength - 3, expected.byteLength - 1], [expected.byteLength - 1, expected.byteLength - 1]];
      for (const [from, to] of ranges) {
        expect((await collect(source.stream(from, to))).equals(expected.subarray(from, to + 1)), `${leg} ${from}-${to}`).toBe(true);
      }
    }
    expect(await store.openLeg('nope', 'mixed')).toBeNull();
    // One leg only: the mixed leg is that leg.
    const single = await store.open('call3');
    single.write('operator', operator);
    await single.close();
    const mixed = (await store.openLeg('call3', 'mixed'))!;
    expect((await collect(mixed.stream(0, mixed.byteLength - 1))).equals(Buffer.from((await store.read('call3', 'mixed'))!))).toBe(true);
  });

  it('drops audio instead of queueing it without limit when the disk cannot keep up', async () => {
    const store = new FileRecordingStore(await tempDataDir(), { maxPendingBytes: 1000 });
    const writer = await store.open('call4');
    // Written synchronously before the file is even open: everything beyond the pending limit is dropped.
    for (let i = 0; i < 50; i++) writer.write('passenger', generateSinePcm16(300, 20));
    const info = await writer.close();
    expect(info.bytes).toBeGreaterThan(0);
    expect(info.bytes).toBeLessThan(50 * 640);
    expect(parseWav((await store.read('call4', 'passenger'))!).pcm.byteLength).toBe(info.bytes);
  });
});
