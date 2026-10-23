/**
 * Interprets a script on an active call: pauses, says each line (the server synthesises the audio and
 * plays it in real time, so the runner waits the signal's duration) and, when asked, waits until the
 * translated reply of the operator has been heard.
 */
import { languageNameEs, speechSignalDurationMs } from '@tw/shared';
import { formatDuration, type Log } from './output.js';
import type { SimScript } from './script.js';
import type { SimClient, SimState } from './sim-client.js';

export interface RunScriptOptions {
  client: SimClient;
  script: SimScript;
  log: Log;
  /** Divides every wait: only meaningful against a fake server that also runs faster than real time. */
  speed?: number;
  signal?: AbortSignal;
  replyTimeoutMs?: number;
  /** Index in `client.states` where the current call starts (a phone that handled earlier calls). */
  since?: number;
}

export interface RunScriptResult {
  linesSaid: number;
  repliesHeard: number;
  repliesMissed: number;
  /** Why the script stopped before its last line, if it did. */
  stoppedBecause: 'call_ended' | 'aborted' | 'send_failed' | null;
}

const isEnded = (state: SimState): boolean => state.state === 'ended';

/** Resolves when the call (states from `since` on) ends, the socket closes or the signal aborts. */
export function stopSignal(client: SimClient, signal?: AbortSignal, since = 0): Promise<void> {
  if (client.isClosed || client.states.slice(since).some(isEnded) || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const offs: (() => void)[] = [];
    const done = (): void => {
      for (const off of offs) off();
      resolve();
    };
    offs.push(client.on('state', (state) => isEnded(state) && done()));
    offs.push(client.on('close', done));
    if (signal) {
      signal.addEventListener('abort', done, { once: true });
      offs.push(() => signal.removeEventListener('abort', done));
    }
  });
}

/** Sleeps `ms`; resolves false (early) when `stop` settles first. */
export function sleepUnless(ms: number, stop: Promise<void>): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(true), Math.max(0, ms));
    void stop.then(() => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

export async function runScript(options: RunScriptOptions): Promise<RunScriptResult> {
  const { client, script, log } = options;
  const speed = options.speed && options.speed > 0 ? options.speed : 1;
  const replyTimeoutMs = options.replyTimeoutMs ?? script.esperaRespuestaMs;
  const since = options.since ?? 0;
  const stop = stopSignal(client, options.signal, since);
  const result: RunScriptResult = { linesSaid: 0, repliesHeard: 0, repliesMissed: 0, stoppedBecause: null };
  const isOver = (): boolean => client.isClosed || client.states.slice(since).some(isEnded) || options.signal?.aborted === true;
  const whyStopped = (): RunScriptResult['stoppedBecause'] => (options.signal?.aborted ? 'aborted' : 'call_ended');

  log.info(`Guion «${script.nombre}»: ${script.lineas.length} líneas.`);
  for (const [index, line] of script.lineas.entries()) {
    if (isOver()) {
      result.stoppedBecause = whyStopped();
      break;
    }
    if (line.pausaMs > 0) {
      log.info(`Guarda silencio ${formatDuration(line.pausaMs)} antes de la línea ${index + 1} (ondas del pasajero planas).`);
      if (!(await sleepUnless(line.pausaMs / speed, stop))) {
        result.stoppedBecause = whyStopped();
        break;
      }
    }
    const heardMark = client.heardBursts;
    log.info(`Dice (${languageNameEs(line.idioma)}): «${line.texto}»`);
    try {
      client.say(line.texto, line.idioma);
    } catch (error) {
      log.error(`No se pudo enviar la línea ${index + 1}: ${(error as Error).message}`);
      result.stoppedBecause = isOver() ? whyStopped() : 'send_failed';
      break;
    }
    result.linesSaid += 1;
    // The server plays the synthetic phrase in real time; do not pile the next line on top of it.
    const speakMs = speechSignalDurationMs(line.texto);
    if (!(await sleepUnless(speakMs / speed, stop))) {
      result.stoppedBecause = whyStopped();
      break;
    }
    if (line.esperarRespuesta) {
      log.info('Espera a oír la respuesta traducida del operador...');
      const burst = await Promise.race([client.waitForHeard(replyTimeoutMs / speed, heardMark), stop.then(() => null)]);
      if (burst) result.repliesHeard += 1;
      else if (isOver()) {
        result.stoppedBecause = whyStopped();
        break;
      } else {
        result.repliesMissed += 1;
        log.warn(`No oyó ninguna respuesta en ${formatDuration(replyTimeoutMs)}; sigue con el guion.`);
      }
    }
  }
  if (result.stoppedBecause === null) log.info('Guion terminado.');
  else if (result.stoppedBecause === 'call_ended') log.warn(`Guion interrumpido: la llamada terminó tras ${result.linesSaid} líneas.`);
  else if (result.stoppedBecause === 'aborted') log.warn(`Guion interrumpido por el usuario tras ${result.linesSaid} líneas.`);
  return result;
}
