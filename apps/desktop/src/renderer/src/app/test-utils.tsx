/** Test helpers for the app screens: a fake `CallClientApi` whose state the test drives, and a logged-in session. */
import { act, render, type RenderResult } from '@testing-library/react';
import type { ReactNode } from 'react';
import { vi } from 'vitest';
import type { CallRecord, LanguageSettings, OperatorInfo, TranscriptSegment } from '@tw/shared';
import { CallProvider } from '../core/CallContext';
import { setSession } from '../core/session';
import {
  INITIAL_CALL_CLIENT_STATE,
  type ActiveCall,
  type CallActions,
  type CallClientApi,
  type CallClientState,
  type LevelSource,
} from '../core/types';

export const OPERATOR: OperatorInfo = { id: 'op1', name: 'Ana', role: 'operator', status: 'available', currentCallId: null, autoAccept: false };
export const ADMIN: OperatorInfo = { id: 'adm1', name: 'Marta', role: 'admin', status: 'available', currentCallId: null, autoAccept: false };
export const SERVER_URL = 'http://127.0.0.1:8787';

const FLAT_LEVELS: LevelSource = { capacity: 0, snapshot: () => [], subscribe: () => () => undefined, lastWindowAt: () => null };

export interface FakeClient {
  client: CallClientApi;
  actions: { [K in keyof Required<CallActions>]: ReturnType<typeof vi.fn> };
  set(next: Partial<CallClientState>): void;
}

export function fakeClient(partial: Partial<CallClientState> = {}): FakeClient {
  let state: CallClientState = { ...INITIAL_CALL_CLIENT_STATE, connection: 'connected', operator: OPERATOR, ...partial };
  const listeners = new Set<() => void>();
  const actions = {
    connect: vi.fn(),
    disconnect: vi.fn(),
    accept: vi.fn(),
    reject: vi.fn(),
    hangup: vi.fn(),
    dial: vi.fn(),
    setLanguages: vi.fn(),
    setMode: vi.fn(),
    mute: vi.fn(),
    debugSay: vi.fn(),
    dismissEndedCall: vi.fn(),
    dismissError: vi.fn(),
    startLocal: vi.fn(),
    setAutoWhatsapp: vi.fn(),
    refreshAudioPrefs: vi.fn(),
    keepCall: vi.fn(),
  };
  const client: CallClientApi = {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    levels: { passenger: FLAT_LEVELS, operator: FLAT_LEVELS },
    actions: actions as unknown as CallActions,
  };
  return {
    client,
    actions,
    set(next) {
      state = { ...state, ...next };
      act(() => listeners.forEach((listener) => listener()));
    },
  };
}

export function loginAs(operator: OperatorInfo = OPERATOR): void {
  setSession({ serverUrl: SERVER_URL, token: 'token-1', expiresAt: Date.now() + 3_600_000, operator });
}

/** Renders `ui` inside a `CallProvider` backed by the fake client. */
export function renderWithClient(ui: ReactNode, fake: FakeClient): RenderResult {
  return render(<CallProvider factory={() => fake.client}>{ui}</CallProvider>);
}

const SETTINGS: LanguageSettings = { operatorLang: 'es', passengerSpeaks: { mode: 'auto' }, passengerHears: { mode: 'follow' } };
const IDLE_LANE = { stage: 'idle' as const, stageDetail: null, speaking: false, levelsFlowing: true };

export function makeActiveCall(overrides: Partial<ActiveCall> = {}): ActiveCall {
  return {
    callId: 'call-1',
    state: 'active',
    direction: 'inbound',
    remoteNumber: '+44 1234 567890',
    answeredAt: Date.now() - 5_000,
    muted: false,
    simulated: true,
    settings: SETTINGS,
    mode: 'auto',
    detected: { lang: 'en', status: 'confirmed', source: 'stt+translator', probability: null, agreeingSegments: 2 },
    notice: null,
    lanes: { passenger: IDLE_LANE, operator: IDLE_LANE },
    segments: [],
    mic: 'live',
    endedReason: null,
    ...overrides,
  };
}

export function makeCallRecord(overrides: Partial<CallRecord> = {}): CallRecord {
  const createdAt = Date.UTC(2026, 9, 20, 10, 0, 0);
  return {
    id: 'call-1',
    direction: 'inbound',
    remoteNumber: '+44 1234 567890',
    operatorId: OPERATOR.id,
    passengerLang: 'en',
    state: 'ended',
    createdAt,
    answeredAt: createdAt + 4_000,
    endedAt: createdAt + 4_000 + 125_000,
    endReason: 'hangup_passenger',
    recorded: true,
    ...overrides,
  };
}

export function makeSegment(overrides: Partial<TranscriptSegment> = {}): TranscriptSegment {
  return {
    id: 'seg-1',
    callId: 'call-1',
    speaker: 'passenger',
    originalLang: 'en',
    originalText: 'my flight was cancelled',
    translatedLang: 'es',
    translatedText: 'mi vuelo fue cancelado',
    startMs: 1_500,
    endMs: 4_000,
    final: true,
    createdAt: 0,
    ...overrides,
  };
}

/** Reads a Blob as text with FileReader (jsdom has no `Blob.text()` in every version). */
export function readBlobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(String(reader.result));
    reader.readAsText(blob);
  });
}
