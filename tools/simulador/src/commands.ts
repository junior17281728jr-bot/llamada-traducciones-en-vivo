/**
 * The four commands of the CLI, written against injectable dependencies (connection factory, logger,
 * control directory, speed) so they run unchanged against the real server and against the fake one.
 */
import { join } from 'node:path';
import { languageNameEs, type CallEndReason, type LanguageCode } from '@tw/shared';
import { ControlServer, hangupPhones, type HangupPhonesOutcome } from './control.js';
import { endReasonEs, formatDuration, shortId, type Log } from './output.js';
import { BUNDLED_SCENARIOS_DIR, loadScript, type SimScript } from './script.js';
import { runScript, sleepUnless, stopSignal, type RunScriptResult } from './script-runner.js';
import { SimClient, type SimClientOptions, type SimState } from './sim-client.js';

export const EXIT = {
  OK: 0,
  /** Wrong arguments or an unreadable script. */
  USAGE: 1,
  /** The server was reached but the call was rejected, unanswered or the check failed. */
  CALL_FAILED: 2,
  /** The simulator socket of the server could not be reached. */
  CONNECTION: 3,
} as const;

export interface CommandContext {
  log: Log;
  connect?: (options: SimClientOptions) => Promise<SimClient>;
  /** Registry folder for `colgar`; null disables registering the phone. */
  controlDir?: string | null;
  signal?: AbortSignal;
  /** Divides every wait (tests against the fake server). Real server: keep 1. */
  speed?: number;
  burstGapMs?: number;
  now?: () => number;
}

export type AnswerOutcome = 'active' | 'ended' | 'timeout' | 'closed';

export interface PhoneSummary {
  numero: string;
  callId: string | null;
  answered: boolean;
  endReason: CallEndReason | null;
  linesSaid: number;
  repliesHeard: number;
  repliesMissed: number;
  heardMs: number;
  heardBursts: number;
  durationMs: number;
}

interface PhoneSessionOptions {
  ctx: CommandContext;
  servidor: string;
  numero: string;
  idioma: LanguageCode;
  comando: string;
}

type HangupSource = 'guion' | 'colgar' | 'usuario' | 'tiempo' | 'prueba';

const HANGUP_TEXT: Record<HangupSource, string> = {
  guion: 'Fin del guion: cuelga.',
  colgar: 'Orden «colgar» recibida: cuelga.',
  usuario: 'Interrumpido: cuelga.',
  tiempo: 'Nadie contestó a tiempo: cuelga.',
  prueba: 'Prueba terminada: cuelga.',
};

/** One simulated phone: connection, Spanish reporting of what happens, control registration and summary. */
export class PhoneSession {
  readonly log: Log;
  private control: ControlServer | null = null;
  private script: RunScriptResult | null = null;
  private since = 0;
  private heardMsAtStart = 0;
  private heardBurstsAtStart = 0;
  private startedAt: number;
  private answeredAt: number | null = null;
  private endedAt: number | null = null;
  private endReason: CallEndReason | null = null;
  private currentCallId: string | null = null;
  private hangupSent = false;
  private closing = false;
  private readonly now: () => number;

  private constructor(
    readonly client: SimClient,
    private readonly options: PhoneSessionOptions,
    log: Log,
  ) {
    this.log = log;
    this.now = options.ctx.now ?? Date.now;
    this.startedAt = this.now();
  }

  static async open(options: PhoneSessionOptions): Promise<PhoneSession | null> {
    const { ctx } = options;
    const log = ctx.log.forPhone(options.numero);
    const connect = ctx.connect ?? SimClient.connect;
    let client: SimClient;
    try {
      client = await connect({
        url: options.servidor,
        ...(ctx.burstGapMs !== undefined ? { burstGapMs: ctx.burstGapMs } : {}),
        ...(ctx.now ? { now: ctx.now } : {}),
      });
    } catch (error) {
      log.error(`No se pudo conectar con el simulador del servidor: ${(error as Error).message}`);
      log.error('¿Está el servidor arrancado en modo simulado (CHANNEL=mock)? Arráncalo con «npm run dev:server».');
      return null;
    }
    const session = new PhoneSession(client, options, log);
    session.wire();
    if (ctx.controlDir) {
      try {
        session.control = await ControlServer.start({
          dir: ctx.controlDir,
          numero: options.numero,
          idioma: options.idioma,
          comando: options.comando,
          onHangup: () => session.hangup('colgar'),
        });
      } catch (error) {
        log.warn(`No se pudo registrar el teléfono para el comando «colgar»: ${(error as Error).message}`);
      }
    }
    log.info(`Conectado al simulador del servidor (${client.url}). Todo lo que ocurre aquí es simulado.`);
    return session;
  }

  get ended(): boolean {
    return this.endedAt !== null;
  }

  get answered(): boolean {
    return this.answeredAt !== null;
  }

  get stateIndex(): number {
    return this.since;
  }

  /** Forgets the previous call of this phone (`escuchar --repetir`). */
  nextCall(): void {
    this.since = this.client.states.length;
    this.heardMsAtStart = this.client.heardMs;
    this.heardBurstsAtStart = this.client.heardBursts;
    this.startedAt = this.now();
    this.answeredAt = null;
    this.endedAt = null;
    this.endReason = null;
    this.currentCallId = null;
    this.script = null;
    this.hangupSent = false;
  }

  waitForAnswer(timeoutMs: number): Promise<AnswerOutcome> {
    return this.client
      .waitForState((state) => state.state === 'active' || state.state === 'ended', timeoutMs, this.since)
      .then((state) => {
        if (!state) return this.client.isClosed ? 'closed' : 'timeout';
        return state.state === 'active' ? 'active' : 'ended';
      });
  }

  waitForRinging(direction: 'inbound' | 'outbound', timeoutMs?: number): Promise<SimState | null> {
    return this.client.waitForState((state) => state.state === 'ringing' && state.direction === direction, timeoutMs, this.since);
  }

  /** Resolves when this call ends, the socket closes or the user interrupts. */
  waitUntilEnded(): Promise<void> {
    return stopSignal(this.client, this.options.ctx.signal, this.since);
  }

  async runScript(script: SimScript): Promise<RunScriptResult> {
    const { ctx } = this.options;
    this.script = await runScript({
      client: this.client,
      script,
      log: this.log,
      ...(ctx.speed !== undefined ? { speed: ctx.speed } : {}),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      since: this.since,
    });
    return this.script;
  }

  async hangup(source: HangupSource): Promise<void> {
    if (this.ended || this.client.isClosed) return;
    if (!this.hangupSent) {
      this.hangupSent = true;
      this.log.info(HANGUP_TEXT[source]);
      try {
        this.client.hangup();
      } catch (error) {
        this.log.warn(`No se pudo enviar el colgado: ${(error as Error).message}`);
        return;
      }
    }
    if (this.client.states.length <= this.since) return; // never rang: the server has nothing to end
    await this.client.waitForState((state) => state.state === 'ended', 2000, this.since);
  }

  summary(): PhoneSummary {
    const end = this.endedAt ?? this.now();
    return {
      numero: this.options.numero,
      callId: this.currentCallId,
      answered: this.answered,
      endReason: this.endReason,
      linesSaid: this.script?.linesSaid ?? 0,
      repliesHeard: this.script?.repliesHeard ?? 0,
      repliesMissed: this.script?.repliesMissed ?? 0,
      heardMs: this.client.heardMs - this.heardMsAtStart,
      heardBursts: this.client.heardBursts - this.heardBurstsAtStart,
      durationMs: Math.max(0, end - (this.answeredAt ?? this.startedAt)),
    };
  }

  logSummary(): PhoneSummary {
    this.client.flushHeard();
    const summary = this.summary();
    const outcome = summary.answered ? 'contestada' : 'no llegó a establecerse';
    const end = summary.endReason ? `terminó porque ${endReasonEs(summary.endReason)}` : 'sigue abierta';
    this.log.info(
      `Resumen: ${outcome}; dijo ${summary.linesSaid} líneas; oyó ${formatDuration(summary.heardMs)} de audio sintético en ${summary.heardBursts} ráfagas; ${end}.`,
    );
    return summary;
  }

  async close(): Promise<void> {
    this.closing = true;
    if (this.control) {
      await this.control.stop();
      this.control = null;
    }
    await this.client.close();
  }

  private wire(): void {
    this.client.on('state', (state) => this.onState(state));
    this.client.on('heard', (burst) => {
      if (this.closing) return;
      const frames = burst.chunks > 1 ? `, ${burst.chunks} tramas` : '';
      const text = burst.text ? `: «${burst.text}»` : '';
      this.log.info(`Oye audio de ${Math.round(burst.ms)} ms (voz traducida del operador, sintética${frames})${text}`);
    });
    this.client.on('protocolError', (detail) => this.log.warn(`Mensaje del servidor no reconocido: ${detail}`));
    this.client.on('error', (error) => this.log.warn(`Error de conexión: ${error.message}`));
    this.client.on('close', (info) => {
      if (this.closing || this.ended) return;
      this.log.warn(`Conexión cerrada por el servidor (código ${info.code}${info.reason ? `: ${info.reason}` : ''}).`);
    });
  }

  private onState(state: SimState): void {
    const lang = languageNameEs(this.options.idioma);
    switch (state.state) {
      case 'ringing':
        this.currentCallId = state.callId;
        if (state.direction === 'outbound') {
          if (state.remoteNumber) this.log.label = state.remoteNumber;
          this.log.info(`Suena: el operador llama al ${state.remoteNumber ?? 'número desconocido'} (este teléfono habla ${lang}).`);
        } else {
          this.log.info(`Suena en el servidor: llamada entrante desde ${state.remoteNumber ?? this.options.numero} (${lang}), esperando a un operador.`);
        }
        break;
      case 'queued':
        this.log.info('En cola: todos los operadores están ocupados.');
        break;
      case 'dialing':
        this.log.info('Marcando...');
        break;
      case 'active':
        this.answeredAt = this.now();
        this.currentCallId = state.callId ?? this.currentCallId;
        this.log.info(
          state.direction === 'outbound'
            ? `Contestada: hablando con el operador (llamada ${shortId(state.callId)}).`
            : `Contestada: un operador ha cogido la llamada ${shortId(state.callId)}.`,
        );
        break;
      case 'ended':
        this.client.flushHeard();
        this.endedAt = this.now();
        this.endReason = state.reason ?? null;
        if (this.answeredAt === null) this.log.warn(`No llegó a establecerse: ${endReasonEs(state.reason)}.`);
        else this.log.info(`Colgada: ${endReasonEs(state.reason)} (duró ${formatDuration(this.endedAt - this.answeredAt)}).`);
        break;
    }
  }
}

// ---------------------------------------------------------------------------
// llamar
// ---------------------------------------------------------------------------

export interface LlamarOptions {
  servidor: string;
  desde: string;
  idioma: LanguageCode;
  guion?: SimScript;
  /** How long to wait for an operator before giving up (real time). */
  esperaContestacionMs?: number;
}

export interface LlamarResult {
  exitCode: number;
  summary: PhoneSummary | null;
  script: RunScriptResult | null;
}

export async function llamar(options: LlamarOptions, ctx: CommandContext): Promise<LlamarResult> {
  const session = await PhoneSession.open({ ctx, servidor: options.servidor, numero: options.desde, idioma: options.idioma, comando: 'llamar' });
  if (!session) return { exitCode: EXIT.CONNECTION, summary: null, script: null };
  const speed = ctx.speed ?? 1;
  const waitMs = options.esperaContestacionMs ?? 60_000;
  try {
    const guion = options.guion ? ` con el guion «${options.guion.nombre}»` : ' sin guion';
    session.log.info(`Llama desde ${options.desde} hablando ${languageNameEs(options.idioma)}${guion}.`);
    try {
      session.client.incoming(options.desde, options.idioma);
    } catch (error) {
      session.log.error(`No se pudo anunciar la llamada: ${(error as Error).message}`);
      return { exitCode: EXIT.USAGE, summary: session.summary(), script: null };
    }
    const outcome = await session.waitForAnswer(waitMs / speed);
    if (outcome === 'timeout') {
      session.log.warn(`Nadie contestó en ${formatDuration(waitMs)}.`);
      await session.hangup('tiempo');
      return { exitCode: EXIT.CALL_FAILED, summary: session.logSummary(), script: null };
    }
    if (outcome === 'ended') return { exitCode: EXIT.CALL_FAILED, summary: session.logSummary(), script: null };
    if (outcome === 'closed') return { exitCode: EXIT.CONNECTION, summary: session.logSummary(), script: null };

    let script: RunScriptResult | null = null;
    if (options.guion) {
      script = await session.runScript(options.guion);
    } else {
      session.log.info('Sin guion: la llamada queda abierta hasta que el operador cuelgue, se ejecute «colgar» o se pulse Ctrl+C.');
      await session.waitUntilEnded();
    }
    if (!session.ended) await session.hangup(ctx.signal?.aborted ? 'usuario' : 'guion');
    const summary = session.logSummary();
    const failed = script?.stoppedBecause === 'send_failed';
    return { exitCode: failed ? EXIT.CALL_FAILED : EXIT.OK, summary, script };
  } finally {
    await session.close();
  }
}

// ---------------------------------------------------------------------------
// escuchar
// ---------------------------------------------------------------------------

export interface EscucharOptions {
  servidor: string;
  idioma: LanguageCode;
  guion?: SimScript;
  /** Hang up when the script ends instead of staying on the line until the operator hangs up. */
  colgarAlTerminar?: boolean;
  /** Go back to listening after each call. */
  repetir?: boolean;
  /** Ring time before picking up, so the operator app shows the outbound call ringing. */
  contestarTrasMs?: number;
  /** Give up when no outbound call arrives in this time; undefined waits indefinitely. */
  esperaLlamadaMs?: number;
}

export interface EscucharResult {
  exitCode: number;
  calls: PhoneSummary[];
}

export async function escuchar(options: EscucharOptions, ctx: CommandContext): Promise<EscucharResult> {
  const session = await PhoneSession.open({ ctx, servidor: options.servidor, numero: 'teléfono libre', idioma: options.idioma, comando: 'escuchar' });
  if (!session) return { exitCode: EXIT.CONNECTION, calls: [] };
  const speed = ctx.speed ?? 1;
  const calls: PhoneSummary[] = [];
  const aborted = (): boolean => ctx.signal?.aborted === true;
  try {
    session.client.listen(options.idioma);
    const wait = options.esperaLlamadaMs === undefined ? '' : ` Espera como mucho ${formatDuration(options.esperaLlamadaMs)}.`;
    session.log.info(`Teléfono libre (${languageNameEs(options.idioma)}): contestará la próxima llamada saliente que marque un operador.${wait}`);
    for (;;) {
      session.nextCall();
      const ringing = await Promise.race([
        session.waitForRinging('outbound', options.esperaLlamadaMs === undefined ? undefined : options.esperaLlamadaMs / speed),
        stopSignal(session.client, ctx.signal, session.stateIndex).then(() => null),
      ]);
      if (!ringing) {
        if (aborted()) session.log.info('Interrumpido mientras esperaba una llamada.');
        else if (session.client.isClosed) session.log.warn('La conexión con el servidor se cerró mientras esperaba una llamada.');
        else if (session.ended) session.log.warn('El servidor dio por terminada una llamada que este teléfono no llegó a ver sonar.');
        else session.log.warn(`No llegó ninguna llamada saliente en ${formatDuration(options.esperaLlamadaMs ?? 0)}.`);
        break;
      }
      const ringMs = options.contestarTrasMs ?? 1500;
      const stillRinging = await sleepUnless(ringMs / speed, stopSignal(session.client, ctx.signal, session.stateIndex));
      if (!stillRinging) {
        if (session.ended) session.log.warn('El operador colgó antes de que descolgara.');
        calls.push(session.logSummary());
        if (!options.repetir || aborted() || session.client.isClosed) break;
        continue;
      }
      session.log.info('Descuelga.');
      session.client.answer();
      const outcome = await session.waitForAnswer(5000 / speed);
      if (outcome !== 'active') {
        if (outcome === 'timeout') session.log.warn('El servidor no confirmó la llamada como activa.');
        calls.push(session.logSummary());
        if (!options.repetir || aborted() || session.client.isClosed) break;
        continue;
      }
      if (options.guion) await session.runScript(options.guion);
      if (!session.ended && !aborted()) {
        if (options.colgarAlTerminar) await session.hangup('guion');
        else {
          session.log.info('Sigue al teléfono hasta que el operador cuelgue (o hasta «colgar» / Ctrl+C).');
          await session.waitUntilEnded();
        }
      }
      if (!session.ended) await session.hangup('usuario');
      calls.push(session.logSummary());
      if (!options.repetir || aborted() || session.client.isClosed) break;
      session.log.label = 'teléfono libre';
      session.log.info('Vuelve a quedar libre para la próxima llamada saliente.');
      session.client.listen(options.idioma);
    }
  } finally {
    await session.close();
  }
  const ok = calls.length > 0 && calls.every((call) => call.answered);
  return { exitCode: ok ? EXIT.OK : EXIT.CALL_FAILED, calls };
}

// ---------------------------------------------------------------------------
// colgar
// ---------------------------------------------------------------------------

export interface ColgarOptions {
  dir: string;
  numero?: string;
}

export interface ColgarResult {
  exitCode: number;
  outcomes: HangupPhonesOutcome[];
}

export async function colgar(options: ColgarOptions, ctx: CommandContext): Promise<ColgarResult> {
  const outcomes = await hangupPhones({ dir: options.dir, ...(options.numero ? { numero: options.numero } : {}) });
  if (outcomes.length === 0) {
    ctx.log.info(
      options.numero
        ? `No hay ningún teléfono simulado en marcha en este equipo con el número ${options.numero}.`
        : 'No hay ningún teléfono simulado en marcha en este equipo.',
    );
    return { exitCode: EXIT.OK, outcomes };
  }
  let failed = 0;
  for (const { phone, result } of outcomes) {
    const r = phone.registration;
    const who = `${r.numero} (${r.comando}, proceso ${r.pid})`;
    switch (result) {
      case 'ok':
        ctx.log.info(`Colgado: ${who}.`);
        break;
      case 'no_disponible':
        ctx.log.info(`${who} ya no está en marcha; se olvida su registro.`);
        break;
      case 'sin_respuesta':
        failed += 1;
        ctx.log.warn(`${who} no respondió a la orden de colgar.`);
        break;
      case 'rechazado':
        failed += 1;
        ctx.log.warn(`${who} rechazó la orden de colgar.`);
        break;
    }
  }
  return { exitCode: failed > 0 ? EXIT.CALL_FAILED : EXIT.OK, outcomes };
}

// ---------------------------------------------------------------------------
// cargar-prueba
// ---------------------------------------------------------------------------

export interface LoadPhone {
  desde: string;
  idioma: LanguageCode;
  guion: SimScript;
}

export interface CargarPruebaOptions {
  servidor: string;
  /** Phones to call with; default: the three bundled scenarios in English, French and Italian. */
  telefonos?: LoadPhone[];
  /** After the calls are active, place one more and check that the server rejects it. */
  probarCuarta?: boolean;
  cuartaDesde?: string;
  cuartaIdioma?: LanguageCode;
  esperaContestacionMs?: number;
}

export type FourthCallOutcome = 'rechazada' | 'aceptada' | 'sin_respuesta' | 'no_probada' | 'sin_conexion';

export interface CargarPruebaResult {
  exitCode: number;
  activas: number;
  total: number;
  cuarta: FourthCallOutcome;
  resumenes: PhoneSummary[];
}

export const DEFAULT_LOAD_PHONES: readonly { escenario: string; desde: string; idioma: LanguageCode }[] = [
  { escenario: 'ingles-vuelo-cancelado', desde: '+447700900123', idioma: 'en' },
  { escenario: 'frances-traslado', desde: '+33612345678', idioma: 'fr' },
  { escenario: 'italiano-reclamacion', desde: '+393123456789', idioma: 'it' },
];

export async function defaultLoadPhones(dir: string = BUNDLED_SCENARIOS_DIR): Promise<LoadPhone[]> {
  return Promise.all(
    DEFAULT_LOAD_PHONES.map(async (entry) => {
      const guion = await loadScript(join(dir, `${entry.escenario}.json`));
      return { desde: guion.desde ?? entry.desde, idioma: guion.idioma ?? entry.idioma, guion };
    }),
  );
}

export async function cargarPrueba(options: CargarPruebaOptions, ctx: CommandContext): Promise<CargarPruebaResult> {
  const telefonos = options.telefonos ?? (await defaultLoadPhones());
  const total = telefonos.length;
  const speed = ctx.speed ?? 1;
  const waitMs = options.esperaContestacionMs ?? 60_000;
  const probarCuarta = options.probarCuarta ?? true;
  ctx.log.info(`Prueba de carga: ${total} llamadas simultáneas contra ${options.servidor} (todo simulado).`);

  const opened = await Promise.all(
    telefonos.map((phone) => PhoneSession.open({ ctx, servidor: options.servidor, numero: phone.desde, idioma: phone.idioma, comando: 'cargar-prueba' })),
  );
  const sessions = opened.filter((session): session is PhoneSession => session !== null);
  if (sessions.length !== total) {
    await Promise.all(sessions.map((session) => session.close()));
    ctx.log.error('No se pudo conectar con el servidor para todos los teléfonos; se cancela la prueba.');
    return { exitCode: EXIT.CONNECTION, activas: 0, total, cuarta: 'sin_conexion', resumenes: [] };
  }

  const resumenes: PhoneSummary[] = [];
  let cuarta: FourthCallOutcome = 'no_probada';
  try {
    sessions.forEach((session, index) => {
      const phone = telefonos[index]!;
      session.log.info(`Llama desde ${phone.desde} hablando ${languageNameEs(phone.idioma)} con el guion «${phone.guion.nombre}».`);
      session.client.incoming(phone.desde, phone.idioma);
    });
    const outcomes = await Promise.all(sessions.map((session) => session.waitForAnswer(waitMs / speed)));
    const active = sessions.filter((_session, index) => outcomes[index] === 'active');
    const activas = active.length;
    if (activas === total) ctx.log.info(`Las ${total} llamadas están activas a la vez.`);
    else {
      ctx.log.error(`Solo ${activas} de ${total} llamadas llegaron a activa.`);
      ctx.log.error('Hace falta un operador conectado y libre por cada llamada (por ejemplo 3 operadores con AUTO_ACCEPT=true o contestando a mano).');
    }

    if (probarCuarta && activas === total) {
      const extraNumber = options.cuartaDesde ?? '+4915123456789';
      const extraLang = options.cuartaIdioma ?? 'de';
      const extra = await PhoneSession.open({ ctx, servidor: options.servidor, numero: extraNumber, idioma: extraLang, comando: 'cargar-prueba' });
      if (!extra) cuarta = 'sin_conexion';
      else {
        try {
          extra.log.info(`Llamada ${total + 1}: comprueba que el servidor la rechaza con ${total} líneas ocupadas.`);
          extra.client.incoming(extraNumber, extraLang);
          const outcome = await extra.waitForAnswer(5000 / speed);
          if (outcome === 'ended') {
            cuarta = 'rechazada';
            ctx.log.info(`La llamada ${total + 1} fue rechazada por el servidor: el límite de ${total} llamadas simultáneas se cumple.`);
          } else if (outcome === 'active') {
            cuarta = 'aceptada';
            ctx.log.error(`La llamada ${total + 1} fue ACEPTADA: el servidor no está limitando a ${total} llamadas simultáneas.`);
            await extra.hangup('prueba');
          } else {
            cuarta = 'sin_respuesta';
            ctx.log.warn(`La llamada ${total + 1} siguió sonando sin ser rechazada ni contestada; se cuelga.`);
            await extra.hangup('prueba');
          }
        } finally {
          await extra.close();
        }
      }
    }

    await Promise.all(
      active.map(async (session) => {
        const phone = telefonos[sessions.indexOf(session)]!;
        await session.runScript(phone.guion);
        if (!session.ended) await session.hangup(ctx.signal?.aborted ? 'usuario' : 'guion');
      }),
    );
    for (const session of sessions) resumenes.push(session.logSummary());

    const fourthText: Record<FourthCallOutcome, string> = {
      rechazada: 'rechazada (correcto)',
      aceptada: 'ACEPTADA (el límite no se cumple)',
      sin_respuesta: 'sin respuesta',
      no_probada: 'no probada',
      sin_conexion: 'sin conexión',
    };
    ctx.log.info(`Resultado de la prueba de carga: ${activas} de ${total} llamadas activas a la vez; llamada ${total + 1}: ${fourthText[cuarta]}.`);
    const ok = activas === total && (cuarta === 'rechazada' || cuarta === 'no_probada');
    return { exitCode: ok ? EXIT.OK : EXIT.CALL_FAILED, activas, total, cuarta, resumenes };
  } finally {
    await Promise.all(sessions.map((session) => session.close()));
  }
}
