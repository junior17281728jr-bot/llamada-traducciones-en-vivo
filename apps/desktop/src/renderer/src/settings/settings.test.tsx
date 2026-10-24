import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_OPERATOR_PREFERENCES,
  documentationCatalog,
  type ConnectionTestResult,
  type KeysResponse,
  type TestService,
} from '@tw/shared';

vi.mock('../core/http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/http')>();
  return {
    ...actual,
    api: {
      logout: vi.fn(async () => ({ ok: true })),
      getLanguages: vi.fn(async () => documentationCatalog()),
      refreshLanguages: vi.fn(),
      getPreferences: vi.fn(async () => DEFAULT_OPERATOR_PREFERENCES),
      putPreferences: vi.fn(),
      getKeys: vi.fn(),
      putKeys: vi.fn(),
      testService: vi.fn(),
      getAppSettings: vi.fn(async () => ({ voiceId: null, fallbackSystemVoice: true, fallbackOriginalVoice: true })),
      putAppSettings: vi.fn(async (settings: unknown) => settings),
      listVoices: vi.fn(async () => ({ source: 'unavailable', voices: [], message: 'Primero guarda la clave de ElevenLabs.' })),
    },
  };
});

import { ApiError, api } from '../core/http';
import { resetCatalogCache } from '../core/catalog';
import { getSession, resetSessionForTests } from '../core/session';
import { ADMIN, OPERATOR, SERVER_URL, fakeClient, loginAs, renderWithClient } from '../app/test-utils';
import { maskedSecretText } from './KeysSection';
import { SettingsPage } from './SettingsPage';

const SECRET = 'sk-super-secret-value-9876';

function masks(overrides: Partial<KeysResponse['keys']> = {}): KeysResponse {
  const none = { configured: false, last4: null, savedAt: null, source: 'none' as const };
  return {
    keys: {
      ELEVENLABS_API_KEY: { configured: true, last4: '1234', savedAt: Date.UTC(2026, 9, 20, 9, 30), source: 'settings' },
      ANTHROPIC_API_KEY: { configured: true, last4: null, savedAt: null, source: 'env' },
      TWILIO_ACCOUNT_SID: none,
      TWILIO_AUTH_TOKEN: none,
      META_ACCESS_TOKEN: none,
      META_PHONE_NUMBER_ID: none,
      ...overrides,
    },
  };
}

function testResult(service: TestService, overrides: Partial<ConnectionTestResult>): ConnectionTestResult {
  return { service, status: 'ok', message: '', contactedRealService: true, latencyMs: null, testedAt: Date.now(), ...overrides };
}

beforeEach(() => {
  resetSessionForTests();
  resetCatalogCache();
  vi.clearAllMocks();
  vi.mocked(api.getKeys).mockResolvedValue(masks());
  vi.mocked(api.putKeys).mockImplementation(async (request) =>
    masks(
      Object.fromEntries(
        Object.entries(request.keys).map(([name, value]) => [
          name,
          value ? { configured: true, last4: value.slice(-4), savedAt: Date.now(), source: 'settings' } : { configured: false, last4: null, savedAt: null, source: 'none' },
        ]),
      ) as Partial<KeysResponse['keys']>,
    ),
  );
  try {
    window.localStorage.clear();
  } catch {
    /* ignore */
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('masked secrets', () => {
  it('describes a key without ever containing its value', () => {
    expect(maskedSecretText(undefined)).toBe('Sin configurar');
    expect(maskedSecretText({ configured: false, last4: null, savedAt: null, source: 'none' })).toBe('Sin configurar');
    expect(maskedSecretText({ configured: true, last4: 'ab12', savedAt: null, source: 'env' })).toBe('Desde variable de entorno (····ab12)');
    expect(maskedSecretText({ configured: true, last4: '1234', savedAt: Date.UTC(2026, 0, 1), source: 'settings' })).toMatch(/^Configurada ····1234, guardada el /);
  });
});

describe('keys (admin)', () => {
  it('shows masks only, sends just the filled fields and never paints the typed value again', async () => {
    loginAs(ADMIN);
    renderWithClient(<SettingsPage />, fakeClient({ operator: ADMIN }));

    expect(await screen.findByTestId('mask-ELEVENLABS_API_KEY')).toHaveTextContent(/Configurada ····1234, guardada el/);
    expect(screen.getByTestId('mask-ANTHROPIC_API_KEY')).toHaveTextContent('Desde variable de entorno');
    expect(screen.getByTestId('mask-TWILIO_AUTH_TOKEN')).toHaveTextContent('Sin configurar');

    const input = screen.getByLabelText(/Clave de API \(ELEVENLABS_API_KEY\)/);
    expect(input).toHaveAttribute('type', 'password');
    expect(input).toHaveValue('');
    fireEvent.change(input, { target: { value: SECRET } });
    fireEvent.click(screen.getByRole('button', { name: 'Guardar 1 clave(s)' }));

    await waitFor(() => expect(api.putKeys).toHaveBeenCalledWith({ keys: { ELEVENLABS_API_KEY: SECRET } }));
    expect(await screen.findByTestId('keys-message')).toHaveTextContent('Guardadas 1 clave(s)');
    expect(input).toHaveValue('');
    expect(screen.getByTestId('mask-ELEVENLABS_API_KEY')).toHaveTextContent('····9876');
    expect(document.body.textContent).not.toContain(SECRET);
    expect(document.body.innerHTML).not.toContain(SECRET);
  });

  it('deletes a saved key with an explicit null after confirmation', async () => {
    loginAs(ADMIN);
    renderWithClient(<SettingsPage />, fakeClient({ operator: ADMIN }));
    const group = await screen.findByTestId('keys-elevenlabs');
    fireEvent.click(within(group).getByRole('button', { name: 'Borrar' }));
    fireEvent.click(within(group).getByRole('button', { name: 'Sí, borrar' }));
    await waitFor(() => expect(api.putKeys).toHaveBeenCalledWith({ keys: { ELEVENLABS_API_KEY: null } }));
    expect(await screen.findByTestId('mask-ELEVENLABS_API_KEY')).toHaveTextContent('Sin configurar');
  });

  it('shows the four connection-test outcomes as the server reports them', async () => {
    loginAs(ADMIN);
    vi.mocked(api.testService).mockImplementation(async (service) => {
      switch (service) {
        case 'elevenlabs':
          return testResult(service, { status: 'ok', message: 'Cuenta válida', latencyMs: 123 });
        case 'anthropic':
          return testResult(service, { status: 'fail', message: 'La clave no es válida (401)', contactedRealService: true });
        case 'twilio':
          return testResult(service, { status: 'unconfigured', message: 'Faltan el SID y el token', contactedRealService: false });
        case 'whatsapp':
          return testResult(service, { status: 'simulated', message: 'Canal simulado: no se contactó ningún servicio real.', contactedRealService: false });
        case 'system-voice':
          return testResult(service, { status: 'ok', message: 'La voz del ordenador funciona', contactedRealService: false });
      }
    });
    renderWithClient(<SettingsPage />, fakeClient({ operator: ADMIN }));
    await screen.findByTestId('keys-section');

    for (const service of ['elevenlabs', 'anthropic', 'twilio', 'whatsapp'] as const) {
      fireEvent.click(screen.getByTestId(`test-${service}`));
    }
    const ok = await screen.findByTestId('test-result-elevenlabs');
    expect(ok).toHaveAttribute('data-status', 'ok');
    expect(ok).toHaveTextContent('Correcto');
    expect(ok).toHaveTextContent('123 ms');
    expect(ok).toHaveTextContent('Se contactó el servicio real.');

    const fail = await screen.findByTestId('test-result-anthropic');
    expect(fail).toHaveTextContent('Falló');
    expect(fail).toHaveTextContent('La clave no es válida (401)');

    const unconfigured = await screen.findByTestId('test-result-twilio');
    expect(unconfigured).toHaveTextContent('Sin configurar');
    expect(unconfigured).toHaveTextContent('Faltan el SID y el token');

    const simulated = await screen.findByTestId('test-result-whatsapp');
    expect(simulated).toHaveAttribute('data-status', 'simulated');
    expect(simulated).toHaveTextContent('SIMULADO');
    expect(simulated).toHaveTextContent('SIMULADO: no se contactó ningún servicio real.');
    expect(simulated).toHaveTextContent('Canal simulado: no se contactó ningún servicio real.');
    expect(simulated).toHaveTextContent('No se contactó ningún servicio real.');
    expect(api.testService).toHaveBeenCalledTimes(4);
  });

  it('hides the keys from a plain operator', async () => {
    loginAs(OPERATOR);
    renderWithClient(<SettingsPage />, fakeClient());
    expect(await screen.findByTestId('keys-admin-only')).toHaveTextContent('solo las puede ver y cambiar un administrador');
    expect(screen.queryByTestId('keys-section')).toBeNull();
    expect(api.getKeys).not.toHaveBeenCalled();
    expect(screen.queryByTestId('refresh-languages')).toBeNull();
  });
});

describe('languages and preferences', () => {
  it('shows the catalogue source and date and saves the preferences', async () => {
    loginAs(OPERATOR);
    vi.mocked(api.putPreferences).mockImplementation(async (preferences) => preferences);
    renderWithClient(<SettingsPage />, fakeClient());

    const info = await screen.findByTestId('catalog-info');
    expect(info).toHaveTextContent('Lista de la documentación (no verificada contra el servicio)');
    expect(info).toHaveTextContent('Sin verificar');

    const speaks = await screen.findByLabelText('Idioma del pasajero por defecto');
    await waitFor(() => expect(within(speaks).getAllByRole('option').length).toBeGreaterThan(2));
    fireEvent.click(screen.getByRole('radio', { name: 'Manual' }));
    fireEvent.change(speaks, { target: { value: 'fr' } });
    fireEvent.click(screen.getByLabelText('Contestar automáticamente las llamadas entrantes'));
    fireEvent.click(screen.getByRole('button', { name: 'Guardar preferencias' }));

    await waitFor(() =>
      expect(api.putPreferences).toHaveBeenCalledWith({
        operatorLang: 'es',
        defaultMode: 'manual',
        defaultPassengerSpeaks: 'fr',
        defaultPassengerHears: null,
        autoAccept: true,
      }),
    );
    expect(await screen.findByTestId('preferences-message')).toHaveTextContent('Preferencias guardadas');
  });

  it('shows the server message when a language is not supported', async () => {
    loginAs(OPERATOR);
    vi.mocked(api.putPreferences).mockRejectedValue(new ApiError(400, 'unsupported_language', 'El idioma "sw" no está disponible para el idioma del pasajero.'));
    renderWithClient(<SettingsPage />, fakeClient());
    fireEvent.click(await screen.findByRole('button', { name: 'Guardar preferencias' }));
    expect(await screen.findByTestId('preferences-message')).toHaveTextContent('El idioma "sw" no está disponible para el idioma del pasajero.');
  });

  it('lets an admin refresh the catalogue with a live query', async () => {
    loginAs(ADMIN);
    vi.mocked(api.refreshLanguages).mockResolvedValue({ ...documentationCatalog(), source: 'live', fetchedAt: Date.now() });
    renderWithClient(<SettingsPage />, fakeClient({ operator: ADMIN }));
    fireEvent.click(await screen.findByTestId('refresh-languages'));
    await waitFor(() => expect(api.refreshLanguages).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/Lista actualizada con una consulta en vivo/)).toBeInTheDocument();
    await waitFor(() => expect(api.getLanguages).toHaveBeenCalledTimes(2));
  });
});

describe('audio', () => {
  it('says so when the environment cannot list devices and still stores the volume', async () => {
    loginAs(OPERATOR);
    renderWithClient(<SettingsPage />, fakeClient());
    expect(await screen.findByTestId('audio-unsupported')).toBeInTheDocument();
    expect(screen.getByTestId('cable-guide')).toHaveTextContent('Altavoz');
    expect(screen.getAllByText(/Usa auriculares/).length).toBeGreaterThan(0);
    fireEvent.change(screen.getByLabelText(/Volumen de la voz traducida/), { target: { value: '0.5' } });
    expect(window.localStorage.getItem('tw.audio.volume')).toBe('0.5');
    expect(screen.getByLabelText(/Volumen de la voz traducida: 50%/)).toBeInTheDocument();
  });

  it('lists the devices and saves the chosen ones for both the operator and the PC-audio mode', async () => {
    loginAs(OPERATOR);
    const devices = [
      { deviceId: 'mic-1', kind: 'audioinput', label: 'Auriculares USB', groupId: 'g1', toJSON: () => ({}) },
      { deviceId: 'cable-in', kind: 'audioinput', label: 'CABLE Output', groupId: 'g2', toJSON: () => ({}) },
      { deviceId: 'spk-1', kind: 'audiooutput', label: 'Auriculares USB', groupId: 'g1', toJSON: () => ({}) },
      { deviceId: 'cable-out', kind: 'audiooutput', label: 'CABLE Input', groupId: 'g2', toJSON: () => ({}) },
    ] as MediaDeviceInfo[];
    vi.stubGlobal('navigator', { ...navigator, mediaDevices: { enumerateDevices: vi.fn(async () => devices) } });
    renderWithClient(<SettingsPage />, fakeClient());

    const mic = await screen.findByLabelText('Micrófono');
    await waitFor(() => expect(within(mic).getByRole('option', { name: 'Auriculares USB' })).toBeInTheDocument());
    fireEvent.change(mic, { target: { value: 'mic-1' } });
    fireEvent.change(screen.getByLabelText('Voz de WhatsApp (cable A)'), { target: { value: 'cable-in' } });
    fireEvent.change(screen.getByLabelText('Hacia el micrófono de WhatsApp (cable B)'), { target: { value: 'cable-out' } });
    expect(window.localStorage.getItem('tw.audio.input')).toBe('mic-1');
    expect(window.localStorage.getItem('tw.audio.passengerInput')).toBe('cable-in');
    expect(window.localStorage.getItem('tw.audio.passengerOutput')).toBe('cable-out');
    expect(screen.queryByTestId('audio-permission')).toBeNull();
  });

  it('offers to ask for the microphone permission when device names are hidden', async () => {
    loginAs(OPERATOR);
    const hidden = [{ deviceId: '', kind: 'audioinput', label: '', groupId: '', toJSON: () => ({}) }] as MediaDeviceInfo[];
    const named = [{ deviceId: 'mic-1', kind: 'audioinput', label: 'Micro interno', groupId: 'g', toJSON: () => ({}) }] as MediaDeviceInfo[];
    const enumerateDevices = vi.fn(async () => hidden);
    const stop = vi.fn();
    const getUserMedia = vi.fn(async () => {
      enumerateDevices.mockResolvedValue(named);
      return { getTracks: () => [{ stop }] };
    });
    vi.stubGlobal('navigator', { ...navigator, mediaDevices: { enumerateDevices, getUserMedia } });
    renderWithClient(<SettingsPage />, fakeClient());

    fireEvent.click(await screen.findByRole('button', { name: 'Permitir micrófono' }));
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledWith({ audio: true }));
    expect(stop).toHaveBeenCalled();
    await waitFor(() => expect(within(screen.getByLabelText('Micrófono')).getByRole('option', { name: 'Micro interno' })).toBeInTheDocument());
    expect(screen.queryByTestId('audio-permission')).toBeNull();
  });
});

describe('server', () => {
  it('shows the current URL and changing server logs out', async () => {
    loginAs(OPERATOR);
    renderWithClient(<SettingsPage />, fakeClient());
    expect(await screen.findByTestId('server-url')).toHaveTextContent(SERVER_URL);
    fireEvent.click(screen.getByTestId('change-server'));
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar sesión y cambiar' }));
    await waitFor(() => expect(api.logout).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(getSession()).toBeNull());
  });
});
