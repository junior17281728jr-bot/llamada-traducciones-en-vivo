/**
 * "Voz del ordenador": the plan B voice when ElevenLabs fails. It uses what every Mac and Windows computer
 * already has, so it needs no key and no internet:
 * - macOS: the `say` command, writing a 16 kHz WAV file.
 * - Windows: System.Speech (SAPI) through one PowerShell process that stays open for the whole session.
 *
 * Voices depend on the computer: Spanish is there on a Spanish system, other languages only if their voice
 * is installed. Without a voice for a language the engine says so (`no_voice`); it never reads French with
 * a Spanish voice.
 */
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INTERNAL_SAMPLE_RATE, normalizeLanguageCode, parseWav, resamplePcm16, type LanguageCode } from '@tw/shared';

export type SystemVoiceErrorKind = 'unsupported' | 'no_voice' | 'failed' | 'timeout';

export class SystemVoiceError extends Error {
  constructor(
    readonly kind: SystemVoiceErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'SystemVoiceError';
  }
}

export interface SystemVoiceInfo {
  name: string;
  /** BCP 47 style, e.g. `es-ES`. */
  locale: string;
}

export interface SystemVoiceEngine {
  /** `macos`, `windows` or `none` (no system voice on this platform). */
  readonly platform: 'macos' | 'windows' | 'none';
  /** Installed voices (asked once, then cached). */
  voices(): Promise<SystemVoiceInfo[]>;
  /** PCM16 16 kHz mono. Rejects with `SystemVoiceError`. */
  synthesize(text: string, lang: LanguageCode): Promise<Uint8Array>;
  close(): Promise<void>;
}

/** Locales tried first for each language (the rest of that language follows in the order the system lists them). */
const PREFERRED_LOCALES: Partial<Record<LanguageCode, readonly string[]>> = {
  es: ['es-ES', 'es-MX', 'es-US'],
  en: ['en-US', 'en-GB', 'en-AU', 'en-IE', 'en-CA'],
  fr: ['fr-FR', 'fr-CA', 'fr-BE', 'fr-CH'],
  it: ['it-IT'],
  pt: ['pt-PT', 'pt-BR'],
  de: ['de-DE', 'de-AT', 'de-CH'],
  nl: ['nl-NL', 'nl-BE'],
  zh: ['zh-CN', 'zh-TW', 'zh-HK'],
};

/** Natural-sounding voices preferred when several exist (first word of the name). */
const PREFERRED_NAMES = [
  'Mónica', 'Monica', 'Paulina', 'Helena', 'Laura', 'Sabina', 'Pablo',
  'Samantha', 'Daniel', 'Karen', 'Moira', 'Zira', 'David', 'Hazel',
  'Thomas', 'Amélie', 'Amelie', 'Hortense', 'Alice', 'Elsa', 'Joana', 'Luciana', 'Helia', 'Maria',
  'Anna', 'Hedda', 'Xander', 'Ellen',
];

/** macOS novelty voices: they exist in every language list and must never read a translation. */
const NOVELTY_VOICES = new Set([
  'Albert', 'Bad News', 'Bahh', 'Bells', 'Boing', 'Bubbles', 'Cellos', 'Deranged', 'Good News', 'Hysterical',
  'Jester', 'Organ', 'Pipe Organ', 'Superstar', 'Trinoids', 'Whisper', 'Wobble', 'Zarvox', 'Junior', 'Ralph', 'Fred', 'Kathy', 'Princess',
]);

function baseName(name: string): string {
  return name.replace(/\s*\(.*$/, '').replace(/^Microsoft\s+/i, '').replace(/\s+(Desktop|Mobile)$/i, '').trim();
}

/** The language of a locale (`nb-NO` is Norwegian, `cmn-CN` Chinese...), or null. */
export function languageOfLocale(locale: string): LanguageCode | null {
  return normalizeLanguageCode(locale.split(/[-_]/)[0] ?? '');
}

/** Best installed voice for `lang`, or null when the computer has none for that language. */
export function pickSystemVoice(voices: readonly SystemVoiceInfo[], lang: LanguageCode): SystemVoiceInfo | null {
  const candidates = voices.filter((voice) => languageOfLocale(voice.locale) === lang && !NOVELTY_VOICES.has(baseName(voice.name)));
  if (candidates.length === 0) return null;
  const locales = PREFERRED_LOCALES[lang] ?? [];
  const localeRank = (voice: SystemVoiceInfo): number => {
    const index = locales.findIndex((locale) => locale.toLowerCase() === voice.locale.toLowerCase());
    return index === -1 ? locales.length : index;
  };
  const nameRank = (voice: SystemVoiceInfo): number => {
    const index = PREFERRED_NAMES.indexOf(baseName(voice.name).split(' ')[0] ?? '');
    return index === -1 ? PREFERRED_NAMES.length : index;
  };
  return [...candidates].sort((a, b) => localeRank(a) - localeRank(b) || nameRank(a) - nameRank(b))[0] ?? null;
}

/** Converts any 16-bit WAV (mono or stereo, any rate) to the internal PCM16 16 kHz mono. */
export function wavToInternalPcm(wav: Uint8Array): Uint8Array {
  const parsed = parseWav(wav);
  if (parsed.bitsPerSample !== 16) throw new SystemVoiceError('failed', `La voz del ordenador devolvió audio de ${parsed.bitsPerSample} bits`);
  let pcm = parsed.pcm;
  if (parsed.channels === 2) {
    const input = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    const frames = Math.floor(pcm.byteLength / 4);
    const mono = new Uint8Array(frames * 2);
    const output = new DataView(mono.buffer);
    for (let i = 0; i < frames; i++) output.setInt16(i * 2, Math.round((input.getInt16(i * 4, true) + input.getInt16(i * 4 + 2, true)) / 2), true);
    pcm = mono;
  } else if (parsed.channels !== 1) {
    throw new SystemVoiceError('failed', `La voz del ordenador devolvió ${parsed.channels} canales`);
  }
  const even = pcm.byteLength & 1 ? pcm.subarray(0, pcm.byteLength - 1) : pcm;
  return parsed.sampleRate === INTERNAL_SAMPLE_RATE ? new Uint8Array(even) : resamplePcm16(even, parsed.sampleRate, INTERNAL_SAMPLE_RATE);
}

function noVoiceMessage(lang: LanguageCode, platform: 'macos' | 'windows'): string {
  const where =
    platform === 'macos'
      ? 'Añádela en Ajustes del Sistema > Accesibilidad > Contenido leído > Voz del sistema > Gestionar voces.'
      : 'Añádela en Configuración de Windows > Hora e idioma > Voz > Agregar voces.';
  return `Este ordenador no tiene voz para el idioma «${lang}». ${where}`;
}

// ---------------------------------------------------------------------------
// macOS: `say`
// ---------------------------------------------------------------------------

export type CommandRunner = (command: string, args: readonly string[], options: { timeoutMs: number }) => Promise<{ stdout: string }>;

const runCommand: CommandRunner = (command, args, { timeoutMs }) =>
  new Promise((resolve, reject) => {
    execFile(command, [...args], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true, encoding: 'utf8' }, (error, stdout) => {
      if (error) reject(error);
      else resolve({ stdout });
    });
  });

/** Parses `say -v ?` (one voice per line: name, locale, `#` sample sentence). */
export function parseSayVoices(output: string): SystemVoiceInfo[] {
  const voices: SystemVoiceInfo[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = /^(.+?)\s+([a-z]{2,3}[_-][A-Za-z0-9]{2,8})\s+#/.exec(line.trim());
    if (match) voices.push({ name: match[1]!.trim(), locale: match[2]!.replace('_', '-') });
  }
  return voices;
}

export interface MacSayEngineOptions {
  run?: CommandRunner;
  timeoutMs?: number;
  tempDir?: string;
}

export class MacSayEngine implements SystemVoiceEngine {
  readonly platform = 'macos' as const;
  private voiceList: Promise<SystemVoiceInfo[]> | null = null;
  private readonly run: CommandRunner;
  private readonly timeoutMs: number;
  private readonly tempDir: string;

  constructor(options: MacSayEngineOptions = {}) {
    this.run = options.run ?? runCommand;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.tempDir = options.tempDir ?? tmpdir();
  }

  voices(): Promise<SystemVoiceInfo[]> {
    this.voiceList ??= this.run('say', ['-v', '?'], { timeoutMs: this.timeoutMs }).then(
      ({ stdout }) => parseSayVoices(stdout),
      (error: unknown) => {
        this.voiceList = null;
        throw new SystemVoiceError('failed', `No se pudo consultar las voces del Mac (${error instanceof Error ? error.message : String(error)})`);
      },
    );
    return this.voiceList;
  }

  async synthesize(text: string, lang: LanguageCode): Promise<Uint8Array> {
    const voice = pickSystemVoice(await this.voices(), lang);
    if (!voice) throw new SystemVoiceError('no_voice', noVoiceMessage(lang, 'macos'));
    const base = join(this.tempDir, `tw-voz-${randomUUID()}`);
    try {
      // The text goes in a file: whatever it says (a leading "-", quotes...) can never be read as an option.
      await writeFile(`${base}.txt`, text, { encoding: 'utf8', mode: 0o600 });
      await this.run('say', ['-v', voice.name, '-o', `${base}.wav`, '--data-format=LEI16@16000', '-f', `${base}.txt`], { timeoutMs: this.timeoutMs }).catch(
        (error: unknown) => {
          const killed = (error as { killed?: boolean }).killed === true;
          throw new SystemVoiceError(killed ? 'timeout' : 'failed', `La voz del Mac falló (${error instanceof Error ? error.message : String(error)})`);
        },
      );
      return wavToInternalPcm(await readFile(`${base}.wav`));
    } finally {
      await Promise.all([rm(`${base}.txt`, { force: true }), rm(`${base}.wav`, { force: true })]);
    }
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// Windows: System.Speech through one PowerShell process
// ---------------------------------------------------------------------------

/**
 * Runs inside `powershell.exe`. First line: `READY culture|name;culture|name...`. Then, per request line
 * (base64 of JSON `{id, voice, text, out}`), it writes a 16 kHz mono WAV and answers `OK id` or `ERR id message`.
 */
export const WINDOWS_VOICE_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  'Add-Type -AssemblyName System.Speech',
  '$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer',
  '$all = @($synth.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo })',
  "$list = @($all | ForEach-Object { $_.Culture.Name + '|' + $_.Name }) -join ';'",
  "[Console]::Out.WriteLine('READY ' + $list)",
  '[Console]::Out.Flush()',
  'while ($true) {',
  '  $line = [Console]::In.ReadLine()',
  '  if ($line -eq $null) { break }',
  "  $id = ''",
  '  try {',
  '    $json = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line))',
  '    $req = ConvertFrom-Json $json',
  '    $id = [string]$req.id',
  '    $synth.SelectVoice([string]$req.voice)',
  '    $fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)',
  '    $synth.SetOutputToWaveFile([string]$req.out, $fmt)',
  '    $synth.Speak([string]$req.text)',
  '    $synth.SetOutputToNull()',
  "    [Console]::Out.WriteLine('OK ' + $id)",
  '  } catch {',
  '    try { $synth.SetOutputToNull() } catch {}',
  "    $msg = ($_.Exception.Message -replace '[\\r\\n]+', ' ')",
  "    [Console]::Out.WriteLine('ERR ' + $id + ' ' + $msg)",
  '  }',
  '  [Console]::Out.Flush()',
  '}',
].join('\n');

/** What the engine needs from a child process (Node's `ChildProcess` fits; tests pass a fake). */
export interface VoiceWorkerProcess {
  stdin: { write(data: string): unknown; end(): unknown };
  stdout: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown };
  on(event: 'exit' | 'error', listener: (arg: unknown) => void): unknown;
  kill(): unknown;
}

export type VoiceWorkerSpawner = () => VoiceWorkerProcess;

const spawnPowerShell: VoiceWorkerSpawner = () =>
  spawn(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(WINDOWS_VOICE_SCRIPT, 'utf16le').toString('base64')],
    { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true },
  );

/** Parses the `READY` line of the PowerShell worker. */
export function parseWindowsVoices(readyLine: string): SystemVoiceInfo[] {
  const list = readyLine.replace(/^READY\s?/, '');
  if (!list.trim()) return [];
  return list
    .split(';')
    .map((entry) => {
      const index = entry.indexOf('|');
      return index > 0 ? { locale: entry.slice(0, index).trim(), name: entry.slice(index + 1).trim() } : null;
    })
    .filter((voice): voice is SystemVoiceInfo => voice !== null && voice.name.length > 0);
}

export interface WindowsSapiEngineOptions {
  spawn?: VoiceWorkerSpawner;
  timeoutMs?: number;
  tempDir?: string;
  readFile?: (path: string) => Promise<Uint8Array>;
}

interface Worker {
  process: VoiceWorkerProcess;
  ready: Promise<SystemVoiceInfo[]>;
  /** Next stdout line, for the request in flight. */
  waiters: ((line: string | null) => void)[];
  dead: boolean;
}

export class WindowsSapiEngine implements SystemVoiceEngine {
  readonly platform = 'windows' as const;
  private worker: Worker | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly spawnWorker: VoiceWorkerSpawner;
  private readonly timeoutMs: number;
  private readonly tempDir: string;
  private readonly readWav: (path: string) => Promise<Uint8Array>;
  private closed = false;

  constructor(options: WindowsSapiEngineOptions = {}) {
    this.spawnWorker = options.spawn ?? spawnPowerShell;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.tempDir = options.tempDir ?? tmpdir();
    this.readWav = options.readFile ?? ((path) => readFile(path));
  }

  async voices(): Promise<SystemVoiceInfo[]> {
    return this.ensureWorker().ready;
  }

  synthesize(text: string, lang: LanguageCode): Promise<Uint8Array> {
    // One request at a time: the worker answers in order and SAPI is single-threaded anyway.
    const job = this.queue.then(() => this.synthesizeNow(text, lang));
    this.queue = job.catch(() => undefined);
    return job;
  }

  async close(): Promise<void> {
    this.closed = true;
    const worker = this.worker;
    this.worker = null;
    if (worker && !worker.dead) {
      worker.dead = true;
      try {
        worker.process.stdin.end();
      } catch {
        /* already gone */
      }
      worker.process.kill();
    }
  }

  private async synthesizeNow(text: string, lang: LanguageCode): Promise<Uint8Array> {
    const worker = this.ensureWorker();
    const voice = pickSystemVoice(await worker.ready, lang);
    if (!voice) throw new SystemVoiceError('no_voice', noVoiceMessage(lang, 'windows'));
    const id = randomUUID();
    const out = join(this.tempDir, `tw-voz-${id}.wav`);
    try {
      const request = Buffer.from(JSON.stringify({ id, voice: voice.name, text, out }), 'utf8').toString('base64');
      const answer = this.nextLine(worker);
      worker.process.stdin.write(`${request}\n`);
      const line = await answer;
      if (line === null) throw new SystemVoiceError('failed', 'La voz de Windows se cerró inesperadamente');
      if (line.startsWith('ERR')) throw new SystemVoiceError('failed', `La voz de Windows falló: ${line.replace(/^ERR\s+\S*\s?/, '')}`);
      return wavToInternalPcm(await this.readWav(out));
    } finally {
      await rm(out, { force: true }).catch(() => undefined);
    }
  }

  private nextLine(worker: Worker): Promise<string | null> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = worker.waiters.indexOf(settle);
        if (index >= 0) worker.waiters.splice(index, 1);
        // A stuck synthesis would answer the NEXT request with this one's line: start a fresh worker instead.
        this.discard(worker);
        reject(new SystemVoiceError('timeout', 'La voz de Windows tardó demasiado'));
      }, this.timeoutMs);
      const settle = (line: string | null): void => {
        clearTimeout(timer);
        resolve(line);
      };
      worker.waiters.push(settle);
    });
  }

  private discard(worker: Worker): void {
    if (this.worker === worker) this.worker = null;
    if (!worker.dead) {
      worker.dead = true;
      worker.process.kill();
    }
    for (const waiter of worker.waiters.splice(0)) waiter(null);
  }

  private ensureWorker(): Worker {
    if (this.closed) throw new SystemVoiceError('unsupported', 'La voz del ordenador está cerrada');
    if (this.worker && !this.worker.dead) return this.worker;
    let process: VoiceWorkerProcess;
    try {
      process = this.spawnWorker();
    } catch (error) {
      throw new SystemVoiceError('unsupported', `No se pudo abrir la voz de Windows (${error instanceof Error ? error.message : String(error)})`);
    }
    let buffer = '';
    let resolveReady!: (voices: SystemVoiceInfo[]) => void;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<SystemVoiceInfo[]>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    ready.catch(() => undefined);
    let isReady = false;
    const worker: Worker = { process, ready, waiters: [], dead: false };
    const readyTimer = setTimeout(() => {
      if (isReady) return;
      rejectReady(new SystemVoiceError('timeout', 'La voz de Windows no arrancó a tiempo'));
      this.discard(worker);
    }, this.timeoutMs);
    process.stdout.on('data', (chunk) => {
      buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      let index: number;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, '').replace(/^﻿/, '');
        buffer = buffer.slice(index + 1);
        if (!isReady) {
          if (line.startsWith('READY')) {
            isReady = true;
            clearTimeout(readyTimer);
            resolveReady(parseWindowsVoices(line));
          }
          continue;
        }
        worker.waiters.shift()?.(line);
      }
    });
    const onGone = (): void => {
      clearTimeout(readyTimer);
      if (!isReady) rejectReady(new SystemVoiceError('unsupported', 'La voz de Windows no está disponible en este equipo'));
      this.discard(worker);
    };
    process.on('exit', onGone);
    process.on('error', onGone);
    this.worker = worker;
    return worker;
  }
}

// ---------------------------------------------------------------------------

/** No system voice on this platform (Linux servers, tests). Every request fails with `unsupported`. */
export class NoSystemVoiceEngine implements SystemVoiceEngine {
  readonly platform = 'none' as const;
  voices(): Promise<SystemVoiceInfo[]> {
    return Promise.resolve([]);
  }
  synthesize(): Promise<Uint8Array> {
    return Promise.reject(new SystemVoiceError('unsupported', 'Este sistema no tiene voz del ordenador (solo Mac y Windows)'));
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

export function createSystemVoiceEngine(platform: string = process.platform): SystemVoiceEngine {
  if (platform === 'darwin') return new MacSayEngine();
  if (platform === 'win32') return new WindowsSapiEngine();
  return new NoSystemVoiceEngine();
}
