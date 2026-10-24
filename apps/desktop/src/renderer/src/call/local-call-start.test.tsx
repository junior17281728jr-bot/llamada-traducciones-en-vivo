import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { documentationCatalog, type OperatorInfo } from '@tw/shared';

vi.mock('../core/http', () => ({
  api: { getLanguages: vi.fn(async () => documentationCatalog()) },
}));

import { AUDIO_PREF_KEYS } from '../core/audio-prefs';
import { CallProvider } from '../core/CallContext';
import { resetCatalogCache } from '../core/catalog';
import { RingLevelSource } from '../core/levels';
import { resetSessionForTests, setSession } from '../core/session';
import { INITIAL_CALL_CLIENT_STATE, type ActiveCall, type CallActions, type CallClientApi, type CallClientState } from '../core/types';
import { LocalCallStart, describeDevice, localCallOptions } from './LocalCallStart';

const operator: OperatorInfo = { id: 'op1', name: 'Ana', role: 'operator', status: 'available', currentCallId: null, autoAccept: false };
const SERVER = { providers: 'mock' as const, channel: 'mock' as const, debug: true, maxCalls: 3, localAudio: true };
const DEVICES = [
  { deviceId: 'cable-a', kind: 'audioinput', label: 'CABLE Output (VB-Audio Virtual Cable)', groupId: 'g1', toJSON: () => ({}) },
  { deviceId: 'cable-b', kind: 'audiooutput', label: 'CABLE-B Input (VB-Audio Cable B)', groupId: 'g2', toJSON: () => ({}) },
  { deviceId: 'mic', kind: 'audioinput', label: 'Micrófono USB', groupId: 'g3', toJSON: () => ({}) },
] as MediaDeviceInfo[];

function fakeClient(partial: Partial<CallClientState>, withStartLocal = true) {
  let state: CallClientState = { ...INITIAL_CALL_CLIENT_STATE, connection: 'connected', operator, server: SERVER, ...partial };
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
    ...(withStartLocal ? { startLocal: vi.fn() } : {}),
  } satisfies CallActions;
  const client: CallClientApi = {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    levels: { passenger: new RingLevelSource(50), operator: new RingLevelSource(50) },
    actions,
  };
  return {
    client,
    actions,
    set(next: Partial<CallClientState>) {
      state = { ...state, ...next };
      act(() => listeners.forEach((listener) => listener()));
    },
  };
}

function renderCard(partial: Partial<CallClientState> = {}, withStartLocal = true) {
  const fake = fakeClient(partial, withStartLocal);
  setSession({ serverUrl: 'http://127.0.0.1:8787', token: 't', expiresAt: Date.now() + 1e6, operator });
  render(
    <CallProvider factory={() => fake.client}>
      <LocalCallStart />
    </CallProvider>,
  );
  return fake;
}

function setPrefs(input: string | null, output: string | null): void {
  for (const [key, value] of [
    [AUDIO_PREF_KEYS.passengerInput, input],
    [AUDIO_PREF_KEYS.passengerOutput, output],
  ] as const) {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  }
}

function mockDevices(list: MediaDeviceInfo[] | null): void {
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: list === null ? undefined : { enumerateDevices: vi.fn(async () => list), addEventListener: vi.fn(), removeEventListener: vi.fn() },
  });
}

const activeCall: ActiveCall = {
  callId: 'c1',
  state: 'active',
  direction: 'inbound',
  remoteNumber: '+34600',
  answeredAt: 1,
  muted: false,
  simulated: true,
  settings: null,
  mode: null,
  detected: { lang: null, status: 'unknown', source: null, probability: null, agreeingSegments: 0 },
  notice: null,
  lanes: {
    passenger: { stage: 'idle', stageDetail: null, speaking: false, levelsFlowing: true },
    operator: { stage: 'idle', stageDetail: null, speaking: false, levelsFlowing: true },
  },
  segments: [],
  mic: 'live',
  endedReason: null,
};

beforeEach(() => {
  resetSessionForTests();
  resetCatalogCache();
  setPrefs('cable-a', 'cable-b');
  mockDevices(DEVICES);
});
afterEach(() => {
  setPrefs(null, null);
  mockDevices(null);
});

describe('describeDevice / localCallOptions', () => {
  it('tells the truth about each saved device', () => {
    expect(describeDevice(null, 'audioinput', DEVICES)).toMatchObject({ state: 'missing' });
    expect(describeDevice('cable-a', 'audioinput', DEVICES)).toEqual({ state: 'found', text: 'CABLE Output (VB-Audio Virtual Cable)' });
    expect(describeDevice('cable-a', 'audiooutput', DEVICES)).toMatchObject({ state: 'absent' });
    expect(describeDevice('cable-a', 'audioinput', null)).toMatchObject({ state: 'unknown' });
    expect(describeDevice('x', 'audioinput', [{ ...DEVICES[0]!, deviceId: 'x', label: '' }] as MediaDeviceInfo[]).text).toContain('sin nombre');
  });

  it('sends detection or one fixed language for both senses', () => {
    expect(localCallOptions('auto')).toEqual({ languages: { passengerSpeaks: { mode: 'auto' }, passengerHears: { mode: 'follow' } } });
    expect(localCallOptions('fr')).toEqual({ langHint: 'fr', languages: { passengerSpeaks: { mode: 'fixed', lang: 'fr' }, passengerHears: { mode: 'fixed', lang: 'fr' } } });
  });
});

describe('<LocalCallStart>', () => {
  it('shows the devices chosen in Settings by name, the honest warning, and starts with the label and language', async () => {
    const { actions } = renderCard();
    expect(screen.getByRole('heading', { name: 'Modo audio del PC' })).toBeInTheDocument();
    expect(screen.getByTestId('local-unverified')).toHaveTextContent('Usa auriculares');
    expect(await screen.findByText('CABLE Output (VB-Audio Virtual Cable)')).toBeInTheDocument();
    expect(screen.getByText('CABLE-B Input (VB-Audio Cable B)')).toBeInTheDocument();
    expect(screen.queryByTestId('local-devices-missing')).toBeNull();
    expect(screen.queryByText('Simulado')).toBeNull();

    const button = screen.getByRole('button', { name: 'Empezar traducción' });
    expect(button).toBeEnabled();
    expect(screen.getByLabelText('Etiqueta (aparece en el historial)')).toHaveValue('WhatsApp');
    fireEvent.click(button);
    expect(actions.startLocal).toHaveBeenCalledWith('WhatsApp', { languages: { passengerSpeaks: { mode: 'auto' }, passengerHears: { mode: 'follow' } } });
    expect(actions.dismissError).toHaveBeenCalled();

    const select = screen.getByLabelText('Idioma del pasajero');
    await screen.findByRole('option', { name: 'Francés' });
    expect(screen.queryByRole('option', { name: 'Tailandés' })).toBeNull();
    fireEvent.change(select, { target: { value: 'fr' } });
    fireEvent.change(screen.getByLabelText('Etiqueta (aparece en el historial)'), { target: { value: '  Teams  ' } });
    fireEvent.click(button);
    expect(actions.startLocal).toHaveBeenLastCalledWith('Teams', {
      langHint: 'fr',
      languages: { passengerSpeaks: { mode: 'fixed', lang: 'fr' }, passengerHears: { mode: 'fixed', lang: 'fr' } },
    });
  });

  it('is disabled and says where to choose the devices when one is missing', () => {
    setPrefs('cable-a', null);
    const { actions } = renderCard();
    expect(screen.getByTestId('local-devices-missing')).toHaveTextContent('Elígelos en Ajustes > Audio');
    expect(screen.getByTestId('local-device-output')).toHaveTextContent('Sin elegir');
    expect(screen.getByRole('button', { name: 'Empezar traducción' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Empezar traducción' }));
    expect(actions.startLocal).not.toHaveBeenCalled();
  });

  it('warns when a saved device is not connected now, and still lets the real start report the problem', async () => {
    setPrefs('cable-a', 'desconectado');
    renderCard();
    expect(await screen.findByText('Dispositivo guardado no conectado ahora')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Empezar traducción' })).toBeEnabled();
  });

  it('cannot list devices: says so instead of inventing names', () => {
    mockDevices(null);
    renderCard();
    expect(screen.getAllByText(/no permite comprobar su nombre/)).toHaveLength(2);
  });

  it('is disabled without a connection, when the server lacks the mode, or during a call', () => {
    renderCard({ connection: 'reconnecting' });
    expect(screen.getByTestId('local-blocked')).toHaveTextContent('Sin conexión con el servidor');
    expect(screen.getByRole('button', { name: 'Empezar traducción' })).toBeDisabled();

    const { set } = renderCard({ server: { ...SERVER, localAudio: false } });
    expect(screen.getAllByTestId('local-blocked').at(-1)).toHaveTextContent('no admite el modo audio del PC');
    set({ server: SERVER, call: activeCall });
    expect(screen.getAllByTestId('local-blocked').at(-1)).toHaveTextContent('Ya tienes una llamada en curso');

    renderCard({}, false);
    expect(screen.getAllByRole('button', { name: 'Empezar traducción' }).at(-1)).toBeDisabled();
  });

  it('shows the last error with a dismiss button (the Llamada tab has no other place for it)', () => {
    const { actions } = renderCard({ lastError: { code: 'audio', message: 'No se encuentra la entrada con la voz del pasajero (cable A).', at: 1 } });
    expect(screen.getByRole('alert')).toHaveTextContent('cable A');
    fireEvent.click(screen.getByRole('button', { name: 'Entendido' }));
    expect(actions.dismissError).toHaveBeenCalled();
  });
});
