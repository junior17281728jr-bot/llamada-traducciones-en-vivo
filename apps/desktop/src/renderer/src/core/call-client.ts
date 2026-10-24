import {
  AudioFrameType,
  CLIENT_ACCEPTED_FRAME_TYPES,
  DEFAULT_FALLBACK_LANGUAGE,
  EnvelopeMeter,
  LEVEL_WINDOW_MS,
  LevelTrack,
  OPERATOR_WS_PATH,
  decodeBinaryFrame,
  encodeAudioFrame,
  encodeMessage,
  normalizeLanguageCode,
  parseServerMessage,
  settingsForMode,
  type ClientMessage,
  type EnvelopeWindow,
  type LanguageMode,
  type PartialLanguageSettings,
  type Speaker,
} from '@tw/shared';
import { BrowserAudioIO, MicError, PlaybackError, type AudioIO, type MicHandle, type Playback } from './audio-io';
import { readAudioPref, writeAudioPref } from './audio-prefs';
import { RingLevelSource } from './levels';
import { reduce, type ClientEvent } from './reducer';
import { clearSession, websocketUrl, type Session } from './session';
import { INITIAL_CALL_CLIENT_STATE, type CallActions, type CallClientApi, type CallClientState, type LevelSource, type WatchStatus } from './types';
import { SpeakingDetector } from './waveform';
import { AUTO_END_COUNTDOWN_MS, DEFAULT_AUTO_END_SECONDS, PreRoll, SilenceMeter, VoiceTrigger } from './whatsapp-watch';

/** Label of the calls that enter on their own from WhatsApp on this computer. */
export const AUTO_LOCAL_LABEL = 'WhatsApp';
const WATCH_RETRY_MS = 10_000;

/** Windows kept per lane: 5 seconds of 20 ms windows. */
export const LEVEL_CAPACITY = 250;

const SIGNAL_LOST_MS = 1500;
const RECONNECT_DELAYS_MS = [500, 1000, 2000, 4000, 8000];
const MIC_UNHEARD_MS = 2500;

export const LOCAL_DEVICES_MISSING_MESSAGE =
  'Faltan los dispositivos del modo audio del PC (la entrada con la voz del pasajero y la salida hacia el otro programa). Elígelos en Ajustes > Audio.';

export interface WebSocketLike {
  binaryType: string;
  readyState: number;
  onopen: ((event: unknown) => void) | null;
  onclose: ((event: { code?: number }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  send(data: string | ArrayBufferLike | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
}

export interface CallClientDeps {
  createSocket?: (url: string) => WebSocketLike;
  audio?: AudioIO;
  /** Epoch ms. */
  now?: () => number;
  /** Monotonic ms, for the "levels stopped arriving" watchdog. */
  perfNow?: () => number;
  reconnectDelaysMs?: readonly number[];
  watchdogMs?: number;
}

/** The two virtual-cable ends of a "modo audio del PC" call. */
interface CableIo {
  /** Cable A: the other program's output, captured as the passenger's voice. */
  capture: MicHandle;
  /** Cable B: the other program's microphone, where the translated operator voice is played. */
  playback: Playback;
}

const OPEN = 1;
const MIC_RETRIES = 3;
const MIC_RETRY_DELAY_MS = 1500;

/** Spanish explanation for a failure while preparing the cable devices. */
function describeLocalAudioError(error: unknown): string {
  if (error instanceof PlaybackError) {
    if (error.reason === 'unsupported') return `${error.message} El modo audio del PC no puede funcionar en este equipo.`;
    return 'No se encuentra la salida hacia el micrófono del otro programa (cable B). Vuelve a elegirla en Ajustes > Audio.';
  }
  if (error instanceof MicError) {
    if (error.reason === 'denied') return 'No hay permiso para capturar audio en este equipo. Permítelo en los ajustes del sistema y vuelve a intentarlo.';
    return 'No se encuentra la entrada con la voz del pasajero (cable A). Vuelve a elegirla en Ajustes > Audio.';
  }
  return 'No se pudieron preparar los dispositivos del modo audio del PC.';
}

/**
 * The operator's connection to the server: WebSocket (with reconnection), microphone, translated voice
 * playback and the level buffers of both lanes. Levels only ever come from real audio:
 * - Pasajero lane: the server's levels frames (track 0), measured on the channel audio. In "modo audio del
 *   PC" that audio is what this client captured from cable A and sent as `PassengerLocal` frames, but the
 *   lane still follows the server's measurement, like in every other mode.
 * - Operador lane: the local microphone samples that are sent (an EnvelopeMeter on the same PCM). While
 *   there is no microphone (muted, denied, no call) the lane receives exact digital silence, which is what
 *   it really is, so the line stays flat. Server track 1 only confirms that the microphone arrives.
 */
export function createCallClient(session: Session, deps: CallClientDeps = {}): CallClientApi {
  const now = deps.now ?? (() => Date.now());
  const perfNow = deps.perfNow ?? (() => performance.now());
  const audio: AudioIO = deps.audio ?? new BrowserAudioIO();
  const createSocket = deps.createSocket ?? ((url: string) => new WebSocket(url) as unknown as WebSocketLike);
  const delays = deps.reconnectDelaysMs ?? RECONNECT_DELAYS_MS;
  const watchdogMs = deps.watchdogMs ?? 500;

  let state: CallClientState = INITIAL_CALL_CLIENT_STATE;
  const listeners = new Set<() => void>();
  const passengerLevels = new RingLevelSource(LEVEL_CAPACITY);
  const operatorLevels = new RingLevelSource(LEVEL_CAPACITY);
  const levels: Record<Speaker, LevelSource> = { passenger: passengerLevels, operator: operatorLevels };
  const detectors: Record<Speaker, SpeakingDetector> = { passenger: new SpeakingDetector(), operator: new SpeakingDetector() };
  const operatorMeter = new EnvelopeMeter();

  let socket: WebSocketLike | null = null;
  let wantConnected = false;
  let attempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let watchdog: ReturnType<typeof setInterval> | null = null;
  let mic: MicHandle | null = null;
  let micToken = 0;
  let micRetries = 0;
  let micRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let lastPassengerFrameAt: number | null = null;
  let serverHearsMicSince: number | null = null;
  let serverVoiceSeen = false;
  let localVoiceSinceMs: number | null = null;
  /** Cable devices prepared for a `call.startLocal` the server has not confirmed yet. */
  let pendingCable: CableIo | null = null;
  /** Cable devices of the active local call. */
  let cable: CableIo | null = null;
  let cableToken = 0;

  // "Entrada automática de WhatsApp": cable A is listened to while there is no call; sound there starts one.
  const trigger = new VoiceTrigger();
  const preRoll = new PreRoll(2000);
  const cableSilence = new SilenceMeter();
  let watchCapture: MicHandle | null = null;
  let watchOpening = false;
  let watchToken = 0;
  /** `starting`: a local call was asked for (by the watcher or by hand). `call`: the watcher's capture feeds the call. */
  let watchMode: 'off' | 'listening' | 'starting' | 'call' = 'off';
  let watchLevelAt = 0;
  let watchRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let evaluating = false;

  const notify = (): void => {
    for (const listener of [...listeners]) listener();
  };

  const dispatch = (event: ClientEvent): void => {
    const before = state;
    state = reduce(state, event, now());
    if (state === before) return;
    afterTransition(before, state);
    notify();
  };

  const patchLane = (speaker: Speaker, patch: Partial<{ speaking: boolean; levelsFlowing: boolean }>): void => {
    const lane = state.call?.lanes[speaker];
    if (!lane) return;
    if ((patch.speaking === undefined || lane.speaking === patch.speaking) && (patch.levelsFlowing === undefined || lane.levelsFlowing === patch.levelsFlowing)) return;
    dispatch({ type: 'lane', speaker, patch });
  };

  const pushLevels = (speaker: Speaker, windows: readonly EnvelopeWindow[]): void => {
    if (windows.length === 0) return;
    (speaker === 'passenger' ? passengerLevels : operatorLevels).push(windows, perfNow());
    if (detectors[speaker].push(windows)) patchLane(speaker, { speaking: detectors[speaker].speaking });
  };

  const sendMessage = (message: ClientMessage): void => {
    if (socket && socket.readyState === OPEN) socket.send(encodeMessage(message));
  };

  const localError = (message: string): void => dispatch({ type: 'error', code: 'audio', message });

  // ---------------------------------------------------------------------------
  // Call lifecycle: microphone, cable devices and level state follow the call
  // ---------------------------------------------------------------------------

  const afterTransition = (before: CallClientState, after: CallClientState): void => {
    const wasActive = before.call?.state === 'active';
    const isActive = after.call?.state === 'active';
    if (isActive && (!wasActive || before.call?.callId !== after.call?.callId)) {
      resetLevels();
      void startMic(after.call!.callId);
      if (after.call!.direction === 'local') attachCable();
      else releasePendingCable();
    }
    if (!isActive && wasActive) {
      // The call is over: whatever translated voice was still queued must not keep playing.
      audio.playback.stop();
      stopMic();
      releaseCable();
    }
    // The last waveform stays on screen after hang-up; it is cleared when the screen is dismissed.
    if (after.call === null && before.call !== null) resetLevels();
    const wasOn = before.call !== null && before.call.state !== 'ended';
    const callOver = after.call === null || after.call.state === 'ended';
    if (wasOn && callOver && (watchMode === 'call' || watchMode === 'starting')) {
      // The call that was on may still be going on in WhatsApp: listen again only after the cable has been quiet.
      watchMode = 'off';
      trigger.requireQuiet();
    }
    const onlyWatch =
      before.call === after.call && before.connection === after.connection && before.server === after.server && before.lastError === after.lastError;
    if (!onlyWatch) evaluateWatch();
  };

  const resetLevels = (): void => {
    passengerLevels.clear();
    operatorLevels.clear();
    operatorMeter.reset();
    for (const speaker of ['passenger', 'operator'] as const) detectors[speaker].reset();
    lastPassengerFrameAt = null;
    serverHearsMicSince = null;
    serverVoiceSeen = false;
    localVoiceSinceMs = null;
    audio.playback.stop();
  };

  const startMic = async (callId: string): Promise<void> => {
    const retrying = micRetries;
    stopMic();
    micRetries = retrying;
    const token = ++micToken;
    dispatch({ type: 'mic', state: 'requesting' });
    try {
      const handle = await audio.startMic((pcm) => onMicPcm(pcm), readAudioPref('input') ?? undefined, () => onMicLost(token, callId));
      if (token !== micToken || state.call?.callId !== callId) {
        handle.stop();
        return;
      }
      mic = handle;
      micRetries = 0;
      dispatch({ type: 'mic', state: 'live' });
    } catch (error) {
      if (token !== micToken) return;
      const reason = error instanceof MicError ? error.reason : 'unavailable';
      dispatch({ type: 'mic', state: reason });
      // A failed recovery attempt keeps retrying until the attempts run out.
      if (micRetries > 0 && reason !== 'denied') {
        scheduleMicRetry(callId);
        return;
      }
      dispatch({
        type: 'server',
        message: { type: 'error', code: 'pipeline_error', message: error instanceof Error ? error.message : 'No se pudo usar el micrófono', callId },
      });
    }
  };

  const scheduleMicRetry = (callId: string): void => {
    if (micRetries >= MIC_RETRIES) {
      localError('Se ha desconectado el micrófono y no se ha podido recuperar. Conéctalo y vuelve a empezar la llamada.');
      return;
    }
    micRetries += 1;
    localError(`Se ha desconectado el micrófono. Intentando recuperarlo (${micRetries} de ${MIC_RETRIES})…`);
    micRetryTimer = setTimeout(() => {
      micRetryTimer = null;
      if (state.call?.callId === callId && state.call.state === 'active') void startMic(callId);
    }, MIC_RETRY_DELAY_MS);
  };

  /** The microphone stopped on its own mid-call: warn, then try to get it back a few times. */
  const onMicLost = (token: number, callId: string): void => {
    if (token !== micToken || !state.call || state.call.callId !== callId || state.call.state !== 'active') return;
    micToken += 1;
    mic = null;
    dispatch({ type: 'mic', state: 'unavailable' });
    scheduleMicRetry(callId);
  };

  const stopMic = (): void => {
    micToken += 1;
    if (micRetryTimer) clearTimeout(micRetryTimer);
    micRetryTimer = null;
    micRetries = 0;
    mic?.stop();
    mic = null;
    if (state.call && state.call.mic !== 'off' && state.call.state !== 'ended') dispatch({ type: 'mic', state: 'off' });
  };

  const onMicPcm = (pcm: Uint8Array): void => {
    const call = state.call;
    if (!call || call.state !== 'active' || call.muted) return;
    pushLevels('operator', operatorMeter.push(pcm));
    if (socket && socket.readyState === OPEN) socket.send(encodeAudioFrame(AudioFrameType.OperatorMic, pcm));
  };

  // ---------------------------------------------------------------------------
  // "Modo audio del PC": cable A in (PassengerLocal), cable B out (TranslatedToPassenger)
  // ---------------------------------------------------------------------------

  const stopCable = (io: CableIo | null): void => {
    io?.capture.stop();
    io?.playback.stop();
  };

  const releasePendingCable = (): void => {
    stopCable(pendingCable);
    pendingCable = null;
  };

  const releaseCable = (): void => {
    cableToken += 1;
    releasePendingCable();
    stopCable(cable);
    cable = null;
  };

  /** The server confirmed the local call: the prepared cable devices now belong to it. */
  const attachCable = (): void => {
    stopCable(cable);
    cable = pendingCable;
    pendingCable = null;
    cableSilence.reset();
    if (!cable) {
      localError('Esta sesión de audio del PC no tiene preparados los dispositivos de los cables. Termínala y vuelve a empezar desde la pestaña Llamada.');
      return;
    }
    if (watchMode === 'starting') {
      watchMode = 'call';
      // The first words, said while the call was entering, are not lost.
      for (const chunk of preRoll.drain()) sendCablePcm(chunk);
    }
  };

  /** Cable A audio of the local call: sent as the passenger's voice, and measured to notice that WhatsApp hung up. */
  const sendCablePcm = (pcm: Uint8Array): void => {
    const call = state.call;
    if (!call || call.state !== 'active' || call.direction !== 'local') return;
    cableSilence.push(pcm);
    if (socket && socket.readyState === OPEN) socket.send(encodeAudioFrame(AudioFrameType.PassengerLocal, pcm));
  };

  /** Audio captured from cable A: sent as the passenger's voice. The lane follows the server's measurement, never these samples. */
  const onCablePcm = (pcm: Uint8Array, token: number): void => {
    if (token !== cableToken || !cable) return;
    sendCablePcm(pcm);
  };

  const prepareAndStartLocal = async (
    label: string,
    input: string,
    output: string,
    options: { langHint?: string; languages?: PartialLanguageSettings } | undefined,
  ): Promise<void> => {
    releaseCable();
    // Started by hand: the automatic entry stops listening so it cannot start a second call meanwhile.
    stopWatchCapture();
    watchMode = 'starting';
    const token = cableToken;
    let playback: Playback | null = null;
    let capture: MicHandle | null = null;
    try {
      playback = audio.createPlayback();
      await playback.setSink(output);
      capture = await audio.startCapture((pcm) => onCablePcm(pcm, token), { deviceId: input, processing: false });
    } catch (error) {
      capture?.stop();
      playback?.stop();
      if (token === cableToken) {
        watchMode = 'off';
        localError(describeLocalAudioError(error));
      }
      return;
    }
    if (token !== cableToken || !wantConnected || (state.call && state.call.state !== 'ended')) {
      capture.stop();
      playback.stop();
      if (token === cableToken) {
        watchMode = 'off';
        evaluateWatch();
      }
      return;
    }
    pendingCable = { capture, playback };
    const langHint = normalizeLanguageCode(options?.langHint);
    sendMessage({
      type: 'call.startLocal',
      label,
      ...(langHint ? { langHint } : {}),
      ...(options?.languages ? { languages: options.languages } : {}),
    });
  };

  // ---------------------------------------------------------------------------
  // "Entrada automática de WhatsApp"
  // ---------------------------------------------------------------------------

  const autoWhatsappEnabled = (): boolean => readAudioPref('autoWhatsapp') !== '0';
  const autoEndMs = (): number => {
    const raw = Number(readAudioPref('autoEndSeconds') ?? DEFAULT_AUTO_END_SECONDS);
    return Number.isFinite(raw) && raw > 0 ? raw * 1000 : 0;
  };

  const stopWatchCapture = (): void => {
    watchToken += 1;
    watchCapture?.stop();
    watchCapture = null;
    watchOpening = false;
    if (watchMode === 'listening' || watchMode === 'call') watchMode = 'off';
    preRoll.drain();
  };

  const watchFailed = (message: string): void => {
    if (watchRetryTimer) clearTimeout(watchRetryTimer);
    dispatch({ type: 'watch', patch: { status: 'error', level: 0, message } });
    watchRetryTimer = setTimeout(() => {
      watchRetryTimer = null;
      evaluateWatch();
    }, WATCH_RETRY_MS);
  };

  /** Decides whether cable A must be listened to right now, opens or closes it, and tells the screen. */
  const evaluateWatch = (): void => {
    if (evaluating) return;
    evaluating = true;
    try {
      const enabled = autoWhatsappEnabled();
      const input = readAudioPref('passengerInput');
      const output = readAudioPref('passengerOutput');
      const busy = state.call !== null && state.call.state !== 'ended';
      let status: WatchStatus;
      if (!enabled) status = 'off';
      else if (!input || !output) status = 'needs_setup';
      else if (!wantConnected || state.connection !== 'connected') status = 'waiting_connection';
      else if (!state.server?.localAudio) status = 'unsupported';
      else if (busy || watchMode === 'call') status = 'in_call';
      else if (watchMode === 'starting') status = 'starting';
      else if (watchRetryTimer) status = 'error';
      else status = trigger.armed ? 'listening' : 'arming';
      const listen = status === 'listening' || status === 'arming';
      if (listen && !watchCapture && !watchOpening && input) void openWatchCapture(input);
      if (!listen && watchMode === 'listening') stopWatchCapture();
      dispatch({ type: 'watch', patch: { enabled, status, ...(status === 'error' ? {} : { message: null }), ...(listen ? {} : { level: 0 }) } });
    } finally {
      evaluating = false;
    }
  };

  const openWatchCapture = async (input: string): Promise<void> => {
    watchOpening = true;
    const token = ++watchToken;
    try {
      const handle = await audio.startCapture((pcm) => onWatchPcm(pcm, token), {
        deviceId: input,
        processing: false,
        onEnded: () => {
          if (token !== watchToken) return;
          stopWatchCapture();
          watchFailed('Se ha desconectado la entrada con la voz del pasajero (cable A). Se volverá a intentar en unos segundos.');
        },
      });
      if (token !== watchToken) {
        handle.stop();
        return;
      }
      watchCapture = handle;
      watchOpening = false;
      watchMode = 'listening';
      evaluateWatch();
    } catch (error) {
      if (token !== watchToken) return;
      watchOpening = false;
      watchFailed(describeLocalAudioError(error));
    }
  };

  const onWatchPcm = (pcm: Uint8Array, token: number): void => {
    if (token !== watchToken) return;
    if (watchMode === 'call') {
      sendCablePcm(pcm);
      return;
    }
    preRoll.push(pcm);
    if (watchMode !== 'listening') return;
    const wasArmed = trigger.armed;
    const triggered = trigger.push(pcm);
    const t = perfNow();
    if (t - watchLevelAt > 200) {
      watchLevelAt = t;
      dispatch({ type: 'watch', patch: { level: Math.round(trigger.level * 1000) / 1000 } });
    }
    if (!wasArmed && trigger.armed) evaluateWatch();
    if (triggered) void startFromWatch(token);
  };

  /** Sound on cable A: the WhatsApp call enters the app, using the capture that is already open. */
  const startFromWatch = async (token: number): Promise<void> => {
    const output = readAudioPref('passengerOutput');
    if (!output || state.connection !== 'connected' || (state.call && state.call.state !== 'ended') || pendingCable) return;
    releaseCable();
    watchMode = 'starting';
    evaluateWatch();
    let playback: Playback | null = null;
    try {
      playback = audio.createPlayback();
      await playback.setSink(output);
    } catch (error) {
      playback?.stop();
      if (token !== watchToken) return;
      stopWatchCapture();
      watchMode = 'off';
      trigger.requireQuiet();
      watchFailed(describeLocalAudioError(error));
      return;
    }
    if (token !== watchToken || watchMode !== 'starting') {
      playback.stop();
      return;
    }
    // From now on the listening capture belongs to the call: ending the call (or a refused start) stops it.
    pendingCable = {
      capture: {
        stop: () => {
          if (token !== watchToken) return;
          stopWatchCapture();
          trigger.requireQuiet();
        },
      },
      playback,
    };
    sendMessage({ type: 'call.startLocal', label: AUTO_LOCAL_LABEL });
  };

  // ---------------------------------------------------------------------------
  // Server messages
  // ---------------------------------------------------------------------------

  const onBinary = (data: ArrayBuffer): void => {
    const decoded = decodeBinaryFrame(new Uint8Array(data), CLIENT_ACCEPTED_FRAME_TYPES);
    if (!decoded.ok) return;
    const frame = decoded.value;
    if (frame.kind === 'audio') {
      const call = state.call;
      if (!call || call.state !== 'active') return;
      // The passenger's translated voice, or the passenger's own voice when both share the language (0x03), goes to
      // the operator's headphones; the operator's translated voice (local calls) goes to cable B only, never there.
      if (frame.type === AudioFrameType.TranslatedPassenger || frame.type === AudioFrameType.OriginalPassenger) audio.playback.play(frame.pcm);
      else if (frame.type === AudioFrameType.TranslatedToPassenger && call.direction === 'local') cable?.playback.play(frame.pcm);
      return;
    }
    const { track, windows } = frame.levels;
    if (track === LevelTrack.PassengerIn) {
      lastPassengerFrameAt = perfNow();
      patchLane('passenger', { levelsFlowing: true });
      pushLevels('passenger', windows);
    } else if (track === LevelTrack.OperatorIn) {
      // Confirmation only: the lane itself shows the local microphone.
      if (windows.some((window) => window.rms > 0.015)) serverVoiceSeen = true;
    }
  };

  const onMessage = (event: { data: unknown }): void => {
    if (typeof event.data !== 'string') {
      onBinary(event.data as ArrayBuffer);
      return;
    }
    const parsed = parseServerMessage(event.data);
    if (!parsed.ok) return;
    const message = parsed.value;
    if (message.type === 'auth.error') {
      wantConnected = message.code === 'rate_limited';
      if (message.code === 'token_expired' || message.code === 'token_invalid') clearSession();
      dispatch({ type: 'server', message });
      socket?.close(1000, 'auth failed');
      return;
    }
    if (message.type === 'auth.ok') attempt = 0;
    // The server refused `call.startLocal` (busy, no line...): the cable devices prepared for it are released.
    if (message.type === 'error' && pendingCable && state.call?.state !== 'active') {
      releasePendingCable();
      if (watchMode === 'starting') {
        watchMode = 'off';
        trigger.requireQuiet();
      }
    }
    dispatch({ type: 'server', message });
  };

  // ---------------------------------------------------------------------------
  // Connection
  // ---------------------------------------------------------------------------

  const open = (): void => {
    if (!wantConnected) return;
    dispatch({ type: 'connection', state: attempt === 0 ? 'connecting' : 'reconnecting' });
    let ws: WebSocketLike;
    try {
      ws = createSocket(websocketUrl(session.serverUrl, OPERATOR_WS_PATH));
    } catch {
      scheduleReconnect('No se pudo abrir la conexión con el servidor');
      return;
    }
    ws.binaryType = 'arraybuffer';
    socket = ws;
    ws.onopen = () => {
      ws.send(encodeMessage({ type: 'auth.resume', token: session.token }));
    };
    ws.onmessage = onMessage;
    ws.onerror = () => undefined;
    ws.onclose = () => {
      if (socket !== ws) return;
      socket = null;
      releasePendingCable();
      if (watchMode === 'starting') watchMode = 'off';
      if (wantConnected) scheduleReconnect('Se perdió la conexión con el servidor. Reconectando…');
    };
  };

  const scheduleReconnect = (reason: string): void => {
    dispatch({ type: 'connection', state: 'reconnecting', error: reason });
    const delay = delays[Math.min(attempt, delays.length - 1)] ?? 1000;
    attempt += 1;
    reconnectTimer = setTimeout(open, delay);
  };

  /** A local call whose cable A has been silent too long: count down, then close it (WhatsApp most likely hung up). */
  const checkAutoEnd = (): void => {
    const call = state.call;
    if (!call || call.state !== 'active' || call.direction !== 'local') return;
    const limit = autoEndMs();
    const t = now();
    if (limit > 0 && cableSilence.silentMs >= limit) {
      if (!call.autoEndAt) dispatch({ type: 'autoEnd', at: t + AUTO_END_COUNTDOWN_MS });
      else if (t >= call.autoEndAt) {
        dispatch({ type: 'autoEnd', at: null });
        cableSilence.reset();
        sendMessage({ type: 'call.hangup', callId: call.callId });
      }
    } else if (call.autoEndAt) {
      dispatch({ type: 'autoEnd', at: null });
    }
  };

  const runWatchdog = (): void => {
    checkAutoEnd();
    const call = state.call;
    if (!call || call.state !== 'active') return;
    const t = perfNow();
    const flowing = lastPassengerFrameAt !== null && t - lastPassengerFrameAt < SIGNAL_LOST_MS;
    patchLane('passenger', { levelsFlowing: flowing });
    // Operator lane: with no microphone feeding it, the real signal is digital silence.
    if (mic === null || call.muted || call.mic !== 'live') {
      const windows = Math.max(1, Math.round(watchdogMs / LEVEL_WINDOW_MS));
      operatorLevels.push(Array.from({ length: windows }, () => ({ min: 0, max: 0, rms: 0 })), t);
      localVoiceSinceMs = null;
      serverVoiceSeen = false;
      detectors.operator.reset();
      patchLane('operator', { speaking: false });
    } else if (state.call?.lanes.operator.speaking) {
      localVoiceSinceMs ??= t;
      if (!serverVoiceSeen && t - localVoiceSinceMs > MIC_UNHEARD_MS && serverHearsMicSince === null) {
        serverHearsMicSince = t;
        dispatch({ type: 'server', message: { type: 'error', code: 'pipeline_error', message: 'El servidor no recibe tu micrófono. Comprueba la conexión.', callId: call.callId } });
      }
    } else {
      localVoiceSinceMs = null;
    }
  };

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  const requireCall = (): string | null => (state.call && state.call.state !== 'ended' ? state.call.callId : null);

  const actions: CallActions = {
    connect() {
      if (wantConnected) return;
      wantConnected = true;
      attempt = 0;
      watchdog ??= setInterval(runWatchdog, watchdogMs);
      open();
    },
    disconnect() {
      wantConnected = false;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      if (watchdog) clearInterval(watchdog);
      watchdog = null;
      stopMic();
      releaseCable();
      stopWatchCapture();
      watchMode = 'off';
      if (watchRetryTimer) clearTimeout(watchRetryTimer);
      watchRetryTimer = null;
      audio.playback.stop();
      const ws = socket;
      socket = null;
      ws?.close(1000, 'client closed');
      dispatch({ type: 'connection', state: 'disconnected' });
    },
    accept: (callId) => sendMessage({ type: 'call.accept', callId }),
    reject: (callId) => sendMessage({ type: 'call.reject', callId }),
    hangup() {
      const callId = requireCall();
      if (callId) sendMessage({ type: 'call.hangup', callId });
    },
    dial: (number, languages) => sendMessage({ type: 'call.dial', number, ...(languages ? { languages } : {}) }),
    startLocal(label, options) {
      const trimmed = label.trim();
      if (!trimmed) return localError('Escribe una etiqueta para la sesión (por ejemplo «WhatsApp»).');
      if (state.connection !== 'connected') return localError('Sin conexión con el servidor: no se puede empezar la traducción.');
      if (!state.server?.localAudio) return localError('Este servidor no admite el modo audio del PC.');
      if (state.call && state.call.state !== 'ended') return localError('Ya tienes una llamada en curso. Termínala antes de empezar otra.');
      const input = readAudioPref('passengerInput');
      const output = readAudioPref('passengerOutput');
      if (!input || !output) return localError(LOCAL_DEVICES_MISSING_MESSAGE);
      void prepareAndStartLocal(trimmed, input, output, options);
    },
    setLanguages(settings: PartialLanguageSettings) {
      const callId = requireCall();
      if (callId) sendMessage({ type: 'call.setLanguages', callId, settings });
    },
    setMode(mode: LanguageMode) {
      const call = state.call;
      if (!call?.settings || call.state === 'ended') return;
      const next = settingsForMode(call.settings, mode, { passengerLang: call.detected.lang, fallbackLang: DEFAULT_FALLBACK_LANGUAGE });
      sendMessage({ type: 'call.setLanguages', callId: call.callId, settings: next });
    },
    mute(muted) {
      const callId = requireCall();
      if (!callId) return;
      sendMessage({ type: 'call.mute', callId, muted });
    },
    debugSay(text, lang, as) {
      const code = normalizeLanguageCode(lang);
      if (!state.server?.debug || !code) return;
      sendMessage({ type: 'debug.say', text, lang: code, ...(as ? { as } : {}) });
    },
    dismissEndedCall: () => dispatch({ type: 'dismissEnded' }),
    dismissError: () => dispatch({ type: 'clearError' }),
    setAutoWhatsapp(enabled) {
      writeAudioPref('autoWhatsapp', enabled ? '1' : '0');
      if (!enabled && watchMode === 'listening') stopWatchCapture();
      evaluateWatch();
    },
    refreshAudioPrefs() {
      // The cable A device may have changed: listen to the one saved now.
      if (watchMode === 'listening') stopWatchCapture();
      if (watchRetryTimer) clearTimeout(watchRetryTimer);
      watchRetryTimer = null;
      evaluateWatch();
    },
    keepCall() {
      cableSilence.reset();
      dispatch({ type: 'autoEnd', at: null });
    },
  };

  // Output device and volume preferences (Settings writes them; they apply from the next call).
  const volumePref = readAudioPref('volume');
  const volume = Number(volumePref);
  if (volumePref !== null && Number.isFinite(volume)) audio.playback.setVolume(volume);
  const sink = readAudioPref('output');
  if (sink) void audio.playback.setSink(sink).catch(() => undefined);

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    levels,
    actions,
  };
}
