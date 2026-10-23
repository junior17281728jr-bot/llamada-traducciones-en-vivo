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
import { BrowserAudioIO, MicError, type AudioIO, type MicHandle } from './audio-io';
import { RingLevelSource } from './levels';
import { reduce, type ClientEvent } from './reducer';
import { clearSession, websocketUrl, type Session } from './session';
import { INITIAL_CALL_CLIENT_STATE, type CallActions, type CallClientApi, type CallClientState, type LevelSource } from './types';
import { SpeakingDetector } from './waveform';

/** Windows kept per lane: 5 seconds of 20 ms windows. */
export const LEVEL_CAPACITY = 250;

const AUDIO_INPUT_KEY = 'tw.audio.input';
const AUDIO_OUTPUT_KEY = 'tw.audio.output';
const AUDIO_VOLUME_KEY = 'tw.audio.volume';
const SIGNAL_LOST_MS = 1500;
const RECONNECT_DELAYS_MS = [500, 1000, 2000, 4000, 8000];
const MIC_UNHEARD_MS = 2500;

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

function readPref(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

const OPEN = 1;

/**
 * The operator's connection to the server: WebSocket (with reconnection), microphone, translated voice
 * playback and the level buffers of both lanes. Levels only ever come from real audio:
 * - Pasajero lane: the server's levels frames (track 0), measured on the channel audio.
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
  let lastPassengerFrameAt: number | null = null;
  let serverHearsMicSince: number | null = null;
  let serverVoiceSeen = false;
  let localVoiceSinceMs: number | null = null;

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

  // ---------------------------------------------------------------------------
  // Call lifecycle: microphone and level state follow the call
  // ---------------------------------------------------------------------------

  const afterTransition = (before: CallClientState, after: CallClientState): void => {
    const wasActive = before.call?.state === 'active';
    const isActive = after.call?.state === 'active';
    if (isActive && (!wasActive || before.call?.callId !== after.call?.callId)) {
      resetLevels();
      void startMic(after.call!.callId);
    }
    if (!isActive && wasActive) stopMic();
    // The last waveform stays on screen after hang-up; it is cleared when the screen is dismissed.
    if (after.call === null && before.call !== null) resetLevels();
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
    stopMic();
    const token = ++micToken;
    dispatch({ type: 'mic', state: 'requesting' });
    try {
      const handle = await audio.startMic((pcm) => onMicPcm(pcm), readPref(AUDIO_INPUT_KEY) ?? undefined);
      if (token !== micToken || state.call?.callId !== callId) {
        handle.stop();
        return;
      }
      mic = handle;
      dispatch({ type: 'mic', state: 'live' });
    } catch (error) {
      if (token !== micToken) return;
      const reason = error instanceof MicError ? error.reason : 'unavailable';
      dispatch({ type: 'mic', state: reason });
      dispatch({
        type: 'server',
        message: { type: 'error', code: 'pipeline_error', message: error instanceof Error ? error.message : 'No se pudo usar el micrófono', callId },
      });
    }
  };

  const stopMic = (): void => {
    micToken += 1;
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
  // Server messages
  // ---------------------------------------------------------------------------

  const onBinary = (data: ArrayBuffer): void => {
    const decoded = decodeBinaryFrame(new Uint8Array(data), CLIENT_ACCEPTED_FRAME_TYPES);
    if (!decoded.ok) return;
    const frame = decoded.value;
    if (frame.kind === 'audio') {
      if (frame.type === AudioFrameType.TranslatedPassenger && state.call?.state === 'active') audio.playback.play(frame.pcm);
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
      if (wantConnected) scheduleReconnect('Se perdió la conexión con el servidor. Reconectando…');
    };
  };

  const scheduleReconnect = (reason: string): void => {
    dispatch({ type: 'connection', state: 'reconnecting', error: reason });
    const delay = delays[Math.min(attempt, delays.length - 1)] ?? 1000;
    attempt += 1;
    reconnectTimer = setTimeout(open, delay);
  };

  const runWatchdog = (): void => {
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
  };

  // Output device and volume preferences (Settings writes them; they apply from the next call).
  const volume = Number(readPref(AUDIO_VOLUME_KEY));
  if (Number.isFinite(volume) && readPref(AUDIO_VOLUME_KEY) !== null) audio.playback.setVolume(volume);
  const sink = readPref(AUDIO_OUTPUT_KEY);
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
