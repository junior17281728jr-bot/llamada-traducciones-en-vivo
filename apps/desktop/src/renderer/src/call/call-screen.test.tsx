import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  UNKNOWN_LANGUAGE_STATE,
  documentationCatalog,
  type EnvelopeWindow,
  type LanguageSettings,
  type OperatorInfo,
  type TranscriptSegment,
} from '@tw/shared';

vi.mock('../core/http', () => ({
  api: { getLanguages: vi.fn(async () => documentationCatalog()) },
}));

import { CallProvider } from '../core/CallContext';
import { resetCatalogCache } from '../core/catalog';
import { RingLevelSource } from '../core/levels';
import { resetSessionForTests, setSession } from '../core/session';
import {
  INITIAL_CALL_CLIENT_STATE,
  type ActiveCall,
  type CallActions,
  type CallClientApi,
  type CallClientState,
} from '../core/types';
import { CallScreen } from './CallScreen';
import { StageChips } from './StageChips';
import { Waveform } from './Waveform';
import type { WaveBar } from '../core/waveform';

const operator: OperatorInfo = { id: 'op1', name: 'Ana', role: 'operator', status: 'in_call', currentCallId: 'c1', autoAccept: false };
const settings: LanguageSettings = { operatorLang: 'es', passengerSpeaks: { mode: 'auto' }, passengerHears: { mode: 'follow' } };
const IDLE = { stage: 'idle' as const, stageDetail: null, speaking: false, levelsFlowing: true };

const makeCall = (overrides: Partial<ActiveCall> = {}): ActiveCall => ({
  callId: 'c1',
  state: 'active',
  direction: 'inbound',
  remoteNumber: '+441234567890',
  answeredAt: Date.now() - 65_000,
  muted: false,
  simulated: true,
  settings,
  mode: 'auto',
  detected: { lang: 'en', status: 'confirmed', source: 'stt+translator', probability: null, agreeingSegments: 2 },
  notice: null,
  lanes: { passenger: IDLE, operator: IDLE },
  segments: [],
  mic: 'live',
  endedReason: null,
  ...overrides,
});

const seg = (id: string, speaker: 'passenger' | 'operator', final: boolean, extra: Partial<TranscriptSegment> = {}): TranscriptSegment => ({
  id,
  callId: 'c1',
  speaker,
  originalLang: speaker === 'passenger' ? 'en' : 'es',
  originalText: speaker === 'passenger' ? 'my flight was cancelled' : 'voy a comprobarlo',
  translatedLang: final ? (speaker === 'passenger' ? 'es' : 'en') : null,
  translatedText: final ? (speaker === 'passenger' ? 'mi vuelo fue cancelado' : 'I will check it') : null,
  startMs: 0,
  endMs: 10,
  final,
  createdAt: 0,
  ...extra,
});

function fakeClient(partial: Partial<CallClientState>) {
  let state: CallClientState = { ...INITIAL_CALL_CLIENT_STATE, connection: 'connected', operator, ...partial };
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
  } satisfies CallActions;
  const levels = { passenger: new RingLevelSource(50), operator: new RingLevelSource(50) };
  const client: CallClientApi = {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    levels,
    actions,
  };
  return {
    client,
    actions,
    levels,
    set(next: Partial<CallClientState>) {
      state = { ...state, ...next };
      act(() => listeners.forEach((listener) => listener()));
    },
  };
}

function renderScreen(partial: Partial<CallClientState>) {
  const fake = fakeClient(partial);
  setSession({ serverUrl: 'http://127.0.0.1:8787', token: 't', expiresAt: Date.now() + 1e6, operator });
  const view = render(
    <CallProvider factory={() => fake.client}>
      <CallScreen />
    </CallProvider>,
  );
  return { ...fake, view };
}

beforeEach(() => {
  resetSessionForTests();
  resetCatalogCache();
  HTMLCanvasElement.prototype.getContext = (() => null) as never;
});

const win = (max: number): EnvelopeWindow => ({ min: -max, max, rms: max / 2 });
const SILENT: EnvelopeWindow = { min: 0, max: 0, rms: 0 };

describe('<Waveform>', () => {
  it('redraws only when its own source gets real windows: each lane follows its own person', async () => {
    const passenger = new RingLevelSource(20);
    const operatorSource = new RingLevelSource(20);
    const passengerFrames: (readonly WaveBar[])[] = [];
    const operatorFrames: (readonly WaveBar[])[] = [];
    render(
      <>
        <Waveform source={passenger} colorToken="--color-passenger" label="Onda de voz de Pasajero" onFrame={(bars) => passengerFrames.push(bars)} />
        <Waveform source={operatorSource} colorToken="--color-operator" label="Onda de voz de Operador" onFrame={(bars) => operatorFrames.push(bars)} />
      </>,
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    const initialPassenger = passengerFrames.length;
    const initialOperator = operatorFrames.length;

    await act(async () => {
      passenger.push([win(0.4), win(0.5)]);
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    expect(passengerFrames.length).toBeGreaterThan(initialPassenger);
    expect(operatorFrames.length).toBe(initialOperator);
    const drawn = passengerFrames.at(-1)!;
    expect(drawn).toHaveLength(2);
    expect(drawn.every((bar) => bar.bottom - bar.top > 1)).toBe(true);

    await act(async () => {
      operatorSource.push([SILENT, SILENT, SILENT]);
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    const flat = operatorFrames.at(-1)!;
    expect(flat).toHaveLength(3);
    expect(flat.every((bar) => bar.top === bar.bottom)).toBe(true);
  });

  it('does not redraw on a timer: with no new audio nothing changes', async () => {
    const source = new RingLevelSource(20);
    const frames: (readonly WaveBar[])[] = [];
    render(<Waveform source={source} colorToken="--color-passenger" label="Onda" onFrame={(bars) => frames.push(bars)} />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    const settled = frames.length;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    expect(frames.length).toBe(settled);
  });
});

describe('<StageChips>', () => {
  it.each([
    ['receiving', 'Recibiendo voz'],
    ['transcribing', 'Transcribiendo'],
    ['translating', 'Traduciendo'],
    ['speaking', 'Reproduciendo traducción'],
  ] as const)('lights only "%s"', (stage, label) => {
    render(<StageChips stage={stage} />);
    const current = screen.getAllByRole('listitem').filter((item) => item.getAttribute('aria-current') === 'true');
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveTextContent(label);
    expect(screen.getAllByRole('listitem')).toHaveLength(4);
  });

  it('shows Inactivo when idle and the detail when there is an error', () => {
    const { rerender } = render(<StageChips stage="idle" />);
    expect(screen.getByText('Inactivo')).toBeInTheDocument();
    rerender(<StageChips stage="error" detail="No se pudo traducir" />);
    expect(screen.getByRole('status')).toHaveTextContent('Error');
    expect(screen.getByRole('status')).toHaveTextContent('No se pudo traducir');
  });
});

describe('<CallScreen>', () => {
  it('says there is no call when there is none', () => {
    renderScreen({});
    expect(screen.getByTestId('call-screen-empty')).toBeInTheDocument();
  });

  it('shows both lanes at once with their names, language, simulated badges and the call data', async () => {
    renderScreen({ call: makeCall() });
    const passenger = screen.getByRole('region', { name: 'Pasajero' });
    const operatorLane = screen.getByRole('region', { name: 'Operador' });
    expect(within(passenger).getByTestId('passenger-language')).toHaveTextContent('Inglés (detectado)');
    expect(within(operatorLane).getByTestId('operator-language')).toHaveTextContent('Hablas en Español');
    expect(within(operatorLane).getByTestId('operator-language')).toHaveTextContent('el pasajero te oye en Inglés');
    expect(within(passenger).getByText('Simulado')).toBeInTheDocument();
    expect(within(operatorLane).getByText('Simulado')).toBeInTheDocument();
    expect(screen.getByText('+441234567890')).toBeInTheDocument();
    expect(screen.getByText('Llamada entrante')).toBeInTheDocument();
    expect(screen.getByText('En llamada')).toBeInTheDocument();
    expect(screen.getAllByTestId('waveform')).toHaveLength(2);
    expect(screen.getByLabelText('Onda de voz de Pasajero')).toBeInTheDocument();
    expect(screen.getByLabelText('Onda de voz de Operador')).toBeInTheDocument();
    expect(screen.getByTestId('language-summary')).toHaveTextContent('Tu voz se traduce a: Inglés');
    await screen.findAllByRole('option', { name: 'Francés' });
  });

  it('marks only the lane that is speaking and shows each lane its own stage', () => {
    renderScreen({
      call: makeCall({
        lanes: {
          passenger: { stage: 'receiving', stageDetail: null, speaking: true, levelsFlowing: true },
          operator: { stage: 'speaking', stageDetail: null, speaking: false, levelsFlowing: true },
        },
      }),
    });
    const passenger = screen.getByRole('region', { name: 'Pasajero' });
    const operatorLane = screen.getByRole('region', { name: 'Operador' });
    expect(passenger).toHaveAttribute('data-speaking', 'true');
    expect(operatorLane).toHaveAttribute('data-speaking', 'false');
    expect(within(passenger).getByText('Hablando')).toBeInTheDocument();
    expect(within(operatorLane).queryByText('Hablando')).toBeNull();
    expect(within(passenger).getByText('Recibiendo voz').closest('li')).toHaveAttribute('aria-current', 'true');
    expect(within(operatorLane).getByText('Reproduciendo traducción').closest('li')).toHaveAttribute('aria-current', 'true');
  });

  it('shows original and translation under each wave, partial text without translation, and the right speaker in each lane', () => {
    renderScreen({
      call: makeCall({
        segments: [
          seg('p1', 'passenger', true),
          seg('p2', 'passenger', false, { originalText: 'and I need a ho' }),
          seg('o1', 'operator', true),
          seg('o2', 'operator', true, { originalText: 'dime el nombre', translatedLang: null, translatedText: null }),
        ],
      }),
    });
    const passenger = screen.getByRole('list', { name: 'Transcripción de Pasajero' });
    const operatorList = screen.getByRole('list', { name: 'Transcripción de Operador' });
    expect(within(passenger).getByText('my flight was cancelled')).toBeInTheDocument();
    expect(within(passenger).getByText('mi vuelo fue cancelado')).toBeInTheDocument();
    expect(within(passenger).getByText('and I need a ho')).toBeInTheDocument();
    expect(within(passenger).queryByText('voy a comprobarlo')).toBeNull();
    expect(within(operatorList).getByText('voy a comprobarlo')).toBeInTheDocument();
    expect(within(operatorList).getByText('I will check it')).toBeInTheDocument();
    expect(within(operatorList).getByText(/No se pudo traducir/)).toBeInTheDocument();
    const partial = within(passenger).getByText('and I need a ho').closest('li')!;
    expect(partial).toHaveAttribute('data-final', 'false');
    expect(within(partial).queryByText(/→/)).toBeNull();
  });

  it('says which lanes carry the original voice when both sides share the language', () => {
    renderScreen({ call: makeCall({ directAudio: { passengerToOperator: true, operatorToPassenger: false } }) });
    expect(screen.getByTestId('direct-audio-passenger')).toHaveTextContent('Oyes su voz original');
    expect(screen.queryByTestId('direct-audio-operator')).toBeNull();
    renderScreen({ call: makeCall({ directAudio: { passengerToOperator: true, operatorToPassenger: true }, segments: [seg('s1', 'operator', true, { originalLang: 'es', translatedLang: 'es', translatedText: 'voy a comprobarlo' })] }) });
    expect(screen.getAllByTestId('direct-audio-operator').at(-1)).toHaveTextContent('El pasajero oye tu voz original');
    expect(screen.getByText(/Mismo idioma \(Español\): no hace falta traducir/)).toBeInTheDocument();
    const { view } = renderScreen({ call: makeCall({ directAudio: null }) });
    expect(within(view.container).queryByTestId('direct-audio-passenger')).toBeNull();
    expect(within(view.container).queryByTestId('direct-audio-operator')).toBeNull();
  });

  it('says when the audio of a lane stops arriving instead of drawing silence', () => {
    renderScreen({
      call: makeCall({ lanes: { passenger: { ...IDLE, levelsFlowing: false }, operator: IDLE } }),
    });
    expect(screen.getByText(/No llega el audio de pasajero/)).toBeInTheDocument();
    expect(screen.queryByText(/No llega el audio de operador/)).toBeNull();
  });

  it('warns about a muted or missing microphone on the operator lane', () => {
    renderScreen({ call: makeCall({ muted: true }) });
    expect(screen.getByText(/Micrófono silenciado/)).toBeInTheDocument();
    renderScreen({ call: makeCall({ mic: 'denied' }) });
    expect(screen.getByText(/No hay permiso para usar el micrófono/)).toBeInTheDocument();
  });

  it('mute and hang up go to the call client', () => {
    const { actions } = renderScreen({ call: makeCall() });
    fireEvent.click(screen.getByRole('button', { name: 'Silenciar micrófono' }));
    expect(actions.mute).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByRole('button', { name: 'Colgar' }));
    expect(actions.hangup).toHaveBeenCalled();
  });

  it('an ended call says why and can be closed', () => {
    const { actions } = renderScreen({ call: makeCall({ state: 'ended', endedReason: 'hangup_passenger' }) });
    expect(screen.getByText(/El pasajero ha colgado/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Colgar' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar' }));
    expect(actions.dismissEndedCall).toHaveBeenCalled();
  });

  it('shows the connection problem, the state of each service and a dismissible error', () => {
    const { actions } = renderScreen({
      connection: 'reconnecting',
      connectionError: 'Se perdió la conexión.',
      systemStatus: { elevenlabs: 'simulated', translator: 'unconfigured', channel: 'down', detail: {} },
      lastError: { code: 'dial_failed', message: 'No se pudo realizar la llamada', at: 1 },
      call: makeCall(),
    });
    expect(screen.getByText(/Reconectando con el servidor/)).toBeInTheDocument();
    expect(screen.getByText('Voz (ElevenLabs): Simulado')).toBeInTheDocument();
    expect(screen.getByText('Traductor: Sin configurar')).toBeInTheDocument();
    expect(screen.getByText('Llamadas: Sin conexión')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('No se pudo realizar la llamada');
    fireEvent.click(screen.getByRole('button', { name: 'Entendido' }));
    expect(actions.dismissError).toHaveBeenCalled();
  });

  it('shows a "modo audio del PC" session with its label, the headphones notice and "Terminar traducción"', () => {
    const { actions } = renderScreen({ call: makeCall({ direction: 'local', remoteNumber: 'WhatsApp', simulated: false }) });
    expect(screen.getByTestId('call-screen')).toHaveAttribute('data-direction', 'local');
    expect(screen.getByText('WhatsApp en este ordenador')).toBeInTheDocument();
    expect(screen.getByText('WhatsApp')).toBeInTheDocument();
    expect(screen.queryByText('Llamada entrante')).toBeNull();
    expect(screen.queryByText('Simulado')).toBeNull();
    const notice = screen.getByTestId('local-call-notice');
    expect(notice).toHaveTextContent('Usa auriculares');
    expect(notice).toHaveTextContent('la traducción se cierra sola');
    expect(screen.getByTestId('passenger-language')).toHaveTextContent('cable A');
    expect(screen.queryByRole('button', { name: 'Colgar' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Terminar traducción' }));
    expect(actions.hangup).toHaveBeenCalled();
  });

  it('an ended "modo audio del PC" session reminds the operator to hang up in the other program', () => {
    renderScreen({ call: makeCall({ direction: 'local', remoteNumber: 'WhatsApp', simulated: false, state: 'ended', endedReason: 'hangup_operator' }) });
    expect(screen.getByText(/Traducción terminada/)).toHaveTextContent('colgar también en el otro programa');
    expect(screen.queryByTestId('local-call-notice')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Terminar traducción' })).toBeNull();
  });

  it('offers the simulated voice box only when the server allows it', () => {
    const server = { providers: 'mock' as const, channel: 'mock' as const, debug: true, maxCalls: 3 };
    const { actions } = renderScreen({ call: makeCall(), server });
    const form = screen.getByRole('form', { name: 'Probar con voz simulada' });
    fireEvent.change(within(form).getByPlaceholderText('Escribe lo que se dirá…'), { target: { value: 'hello there' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Dice el pasajero' }));
    expect(actions.debugSay).toHaveBeenCalledWith('hello there', 'en', 'passenger');
    fireEvent.change(within(form).getByPlaceholderText('Escribe lo que se dirá…'), { target: { value: 'buenos días' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Dices tú (en español)' }));
    expect(actions.debugSay).toHaveBeenLastCalledWith('buenos días', 'es', 'operator');
    renderScreen({ call: makeCall(), server: { ...server, debug: false } });
    expect(screen.getAllByRole('form', { name: 'Probar con voz simulada' })).toHaveLength(1);
  });
});

describe('<LanguagePanel> inside the call screen', () => {
  it('offers only the languages the catalogue confirms', async () => {
    renderScreen({ call: makeCall() });
    const speaks = (await screen.findByLabelText('El pasajero habla')) as HTMLSelectElement;
    await within(speaks).findByRole('option', { name: 'Italiano' });
    const names = within(speaks).getAllByRole('option').map((option) => option.textContent);
    expect(names).toContain('Detección automática');
    expect(names).toContain('Inglés');
    expect(names).not.toContain('Tailandés');
    expect(names).not.toContain('Suajili');
  });

  it('shows a language that is chosen but not available as unavailable instead of hiding it', async () => {
    renderScreen({
      call: makeCall({ settings: { ...settings, passengerHears: { mode: 'fixed', lang: 'th' } }, mode: 'mixed' }),
    });
    const hears = (await screen.findByLabelText('El pasajero te oye en')) as HTMLSelectElement;
    await within(hears).findByRole('option', { name: 'Italiano' });
    const unavailable = within(hears).getByRole('option', { name: /no disponible/ });
    expect(unavailable).toBeDisabled();
  });

  it('switches mode with the three buttons and shows the one the server confirmed', () => {
    const { actions } = renderScreen({ call: makeCall({ mode: 'mixed', settings: { ...settings, passengerHears: { mode: 'fixed', lang: 'en' } } }) });
    expect(screen.getByRole('radio', { name: 'Mixto' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'Automático' })).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(screen.getByRole('radio', { name: 'Manual' }));
    expect(actions.setMode).toHaveBeenCalledWith('manual');
  });

  it('changing a selector sends that change only, during the call', async () => {
    const { actions } = renderScreen({ call: makeCall() });
    const hears = (await screen.findByLabelText('El pasajero te oye en')) as HTMLSelectElement;
    await within(hears).findByRole('option', { name: 'Italiano' });
    fireEvent.change(hears, { target: { value: 'fr' } });
    expect(actions.setLanguages).toHaveBeenLastCalledWith({ passengerHears: { mode: 'fixed', lang: 'fr' } });
    fireEvent.change(hears, { target: { value: 'follow' } });
    expect(actions.setLanguages).toHaveBeenLastCalledWith({ passengerHears: { mode: 'follow' } });
    const speaks = screen.getByLabelText('El pasajero habla');
    fireEvent.change(speaks, { target: { value: 'pt' } });
    expect(actions.setLanguages).toHaveBeenLastCalledWith({ passengerSpeaks: { mode: 'fixed', lang: 'pt' } });
    fireEvent.change(speaks, { target: { value: 'auto' } });
    expect(actions.setLanguages).toHaveBeenLastCalledWith({ passengerSpeaks: { mode: 'auto' } });
    fireEvent.change(screen.getByLabelText('Tu idioma'), { target: { value: 'en' } });
    expect(actions.setLanguages).toHaveBeenLastCalledWith({ operatorLang: 'en' });
  });

  it('warns when the language is uncertain and lets the operator pick one of the candidates', async () => {
    const { actions } = renderScreen({
      call: makeCall({
        detected: { lang: null, status: 'uncertain', source: null, probability: 0.4, agreeingSegments: 0 },
        notice: { kind: 'uncertain', lang: null, candidates: { stt: 'pt', translator: 'es' }, at: 1 },
      }),
    });
    const alert = await screen.findByTestId('uncertain-notice');
    expect(alert).toHaveTextContent('No estoy seguro del idioma del pasajero');
    expect(screen.getByTestId('passenger-language')).toHaveTextContent('Idioma incierto');
    fireEvent.click(within(alert).getByRole('button', { name: 'Es Portugués' }));
    expect(actions.setLanguages).toHaveBeenCalledWith({ passengerSpeaks: { mode: 'fixed', lang: 'pt' } });
  });

  it('tells the operator about a language change and about the fallback language', () => {
    renderScreen({ call: makeCall({ notice: { kind: 'changed', lang: 'pt', candidates: { stt: 'pt', translator: 'pt' }, at: 1 } }) });
    expect(screen.getByText(/ha cambiado a/)).toHaveTextContent('Portugués');
    renderScreen({ call: makeCall({ notice: { kind: 'fallback_used', lang: 'en', candidates: { stt: null, translator: null }, at: 1 } }) });
    expect(screen.getByText(/se ha usado/)).toHaveTextContent('Inglés');
  });

  it('labels the detected language by how sure the system is', () => {
    const state = (lang: string | null, status: ActiveCall['detected']['status']): ActiveCall => makeCall({ detected: { ...UNKNOWN_LANGUAGE_STATE, lang, status } });
    renderScreen({ call: state(null, 'unknown') });
    expect(screen.getByTestId('passenger-language')).toHaveTextContent('Detectando idioma…');
    renderScreen({ call: state('fr', 'tentative') });
    expect(screen.getAllByTestId('passenger-language').at(-1)).toHaveTextContent('Francés (probable)');
    renderScreen({ call: makeCall({ settings: { ...settings, passengerSpeaks: { mode: 'fixed', lang: 'it' } }, mode: 'manual' }) });
    expect(screen.getAllByTestId('passenger-language').at(-1)).toHaveTextContent('Italiano (elegido)');
  });
});
