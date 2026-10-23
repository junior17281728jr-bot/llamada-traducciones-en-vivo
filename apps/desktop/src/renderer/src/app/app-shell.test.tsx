import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_OPERATOR_PREFERENCES, documentationCatalog } from '@tw/shared';

vi.mock('../core/http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/http')>();
  return {
    ...actual,
    api: {
      login: vi.fn(),
      logout: vi.fn(async () => ({ ok: true })),
      getLanguages: vi.fn(async () => documentationCatalog()),
      refreshLanguages: vi.fn(),
      getPreferences: vi.fn(async () => DEFAULT_OPERATOR_PREFERENCES),
      putPreferences: vi.fn(),
      getKeys: vi.fn(),
      putKeys: vi.fn(),
      testService: vi.fn(),
      listCalls: vi.fn(async () => ({ calls: [] })),
      getCall: vi.fn(),
      getCallAudio: vi.fn(),
    },
  };
});

import { ApiError, api } from '../core/http';
import { resetCatalogCache } from '../core/catalog';
import { getSession, resetSessionForTests } from '../core/session';
import { AppShell } from './AppShell';
import { ringSecondsLeft } from './IncomingBanner';
import { OPERATOR, SERVER_URL, fakeClient, loginAs, makeActiveCall, renderWithClient } from './test-utils';

const login = vi.mocked(api.login);

beforeEach(() => {
  resetSessionForTests();
  resetCatalogCache();
  vi.clearAllMocks();
  HTMLCanvasElement.prototype.getContext = (() => null) as never;
});

function fillLogin(user = 'ana', password = 'secreta'): void {
  fireEvent.change(screen.getByLabelText('Usuario'), { target: { value: user } });
  fireEvent.change(screen.getByLabelText('Contraseña'), { target: { value: password } });
}

describe('login screen', () => {
  it('shows the login form without a session, with the default server URL', () => {
    renderWithClient(<AppShell />, fakeClient({ connection: 'disconnected' }));
    expect(screen.getByTestId('login-screen')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Telecomway' })).toBeInTheDocument();
    expect(screen.getByLabelText('Servidor')).toHaveValue(SERVER_URL);
  });

  it('logs in, stores the session and shows the shell with name, role and connection state', async () => {
    login.mockResolvedValueOnce({ token: 'tok', expiresAt: Date.now() + 60_000, operator: OPERATOR });
    renderWithClient(<AppShell />, fakeClient({ connection: 'connected', systemStatus: { elevenlabs: 'simulated', translator: 'simulated', channel: 'simulated', detail: {} } }));
    fillLogin();
    fireEvent.click(screen.getByRole('button', { name: 'Entrar' }));

    expect(await screen.findByTestId('topbar')).toBeInTheDocument();
    expect(login).toHaveBeenCalledWith(SERVER_URL, { username: 'ana', password: 'secreta' });
    expect(getSession()?.token).toBe('tok');
    expect(screen.getByTestId('topbar-name')).toHaveTextContent('Ana');
    expect(screen.getByTestId('topbar-role')).toHaveTextContent('Operador');
    expect(screen.getByTestId('connection-status')).toHaveTextContent('Conectado');
    expect(screen.getByTestId('service-elevenlabs')).toHaveTextContent('Voz (ElevenLabs): Simulado');
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Llamada', 'Marcador', 'Historial', 'Ajustes']);
  });

  it('explains wrong credentials, the lockout after too many attempts and an unreachable server', async () => {
    renderWithClient(<AppShell />, fakeClient({ connection: 'disconnected' }));

    login.mockRejectedValueOnce(new ApiError(401, 'invalid_credentials', 'Usuario o contraseña incorrectos'));
    fillLogin('ana', 'mala');
    fireEvent.click(screen.getByRole('button', { name: 'Entrar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Usuario o contraseña incorrectos');
    expect(screen.getByLabelText('Contraseña')).toHaveValue('');

    login.mockRejectedValueOnce(new ApiError(429, 'rate_limited', 'Demasiados intentos fallidos. Espera unos minutos.'));
    fillLogin('ana', 'otra');
    fireEvent.click(screen.getByRole('button', { name: 'Entrar' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/bloqueado unos minutos/));

    login.mockRejectedValueOnce(new ApiError(0, 'network', 'No se pudo conectar con el servidor'));
    fillLogin('ana', 'otra');
    fireEvent.click(screen.getByRole('button', { name: 'Entrar' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(`No se pudo conectar con el servidor en ${SERVER_URL}`));
    expect(getSession()).toBeNull();
  });

  it('warns when the server is on another machine over plain http (unencrypted), not for this machine or https', () => {
    renderWithClient(<AppShell />, fakeClient({ connection: 'disconnected' }));
    expect(screen.queryByTestId('login-insecure-warning')).toBeNull();
    fireEvent.change(screen.getByLabelText('Servidor'), { target: { value: 'http://192.168.1.10:8787' } });
    expect(screen.getByTestId('login-insecure-warning')).toHaveTextContent('sin cifrar');
    fireEvent.change(screen.getByLabelText('Servidor'), { target: { value: 'https://traductor.ejemplo.com' } });
    expect(screen.queryByTestId('login-insecure-warning')).toBeNull();
    fireEvent.change(screen.getByLabelText('Servidor'), { target: { value: 'http://localhost:8787' } });
    expect(screen.queryByTestId('login-insecure-warning')).toBeNull();
  });

  it('refuses an address that is not http(s) without calling the server', async () => {
    renderWithClient(<AppShell />, fakeClient({ connection: 'disconnected' }));
    fireEvent.change(screen.getByLabelText('Servidor'), { target: { value: 'servidor-sin-esquema' } });
    fillLogin();
    fireEvent.click(screen.getByRole('button', { name: 'Entrar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('http://');
    expect(login).not.toHaveBeenCalled();
  });
});

describe('incoming call alert', () => {
  it('shows caller, language hint, countdown and answers or rejects with the call id', async () => {
    loginAs();
    const fake = fakeClient({
      incoming: { callId: 'c9', from: '+33 1 23 45 67 89', langHint: 'fr', ringTimeoutSeconds: 30, autoAccept: false, receivedAt: Date.now() },
    });
    renderWithClient(<AppShell />, fake);

    const banner = screen.getByTestId('incoming-banner');
    expect(within(banner).getByTestId('incoming-from')).toHaveTextContent('+33 1 23 45 67 89');
    expect(banner).toHaveTextContent('Idioma: Francés');
    expect(within(banner).getByTestId('incoming-countdown')).toHaveTextContent(/Quedan (30|29) s/);
    expect(within(banner).queryByTestId('incoming-auto')).toBeNull();

    fireEvent.click(within(banner).getByRole('button', { name: 'Contestar' }));
    expect(fake.actions.accept).toHaveBeenCalledWith('c9');
    // One click only: both buttons are disabled until the server answers (a double click never answers twice).
    expect(within(banner).getByRole('button', { name: 'Contestando…' })).toBeDisabled();
    expect(within(banner).getByRole('button', { name: 'Rechazar' })).toBeDisabled();
    fireEvent.click(within(banner).getByRole('button', { name: 'Contestando…' }));
    expect(fake.actions.accept).toHaveBeenCalledTimes(1);

    // Another offer re-enables them; Rechazar works the same way.
    fake.set({ incoming: { callId: 'c10', from: '+1 555 0100', langHint: null, ringTimeoutSeconds: 30, autoAccept: false, receivedAt: Date.now() } });
    fireEvent.click(within(screen.getByTestId('incoming-banner')).getByRole('button', { name: 'Rechazar' }));
    expect(fake.actions.reject).toHaveBeenCalledWith('c10');
    expect(within(screen.getByTestId('incoming-banner')).getByRole('button', { name: 'Contestar' })).toBeDisabled();

    // Switching tabs keeps the alert on screen.
    fireEvent.click(screen.getByRole('tab', { name: 'Ajustes' }));
    expect(await screen.findByTestId('settings')).toBeInTheDocument();
    expect(screen.getByTestId('incoming-banner')).toBeInTheDocument();

    fake.set({ incoming: null });
    expect(screen.queryByTestId('incoming-banner')).toBeNull();
  });

  it('says the call will be answered automatically when autoAccept is on', () => {
    loginAs();
    renderWithClient(
      <AppShell />,
      fakeClient({ incoming: { callId: 'c1', from: '+1 555 0100', langHint: null, ringTimeoutSeconds: null, autoAccept: true, receivedAt: Date.now() } }),
    );
    const banner = screen.getByTestId('incoming-banner');
    expect(within(banner).getByTestId('incoming-auto')).toHaveTextContent('Se contestará automáticamente');
    expect(banner).toHaveTextContent('Sin límite de tiempo');
  });

  it('counts the ring timeout down from the moment the offer arrived', () => {
    const incoming = { callId: 'c1', from: 'x', langHint: null, ringTimeoutSeconds: 20, autoAccept: false, receivedAt: 1_000 };
    expect(ringSecondsLeft(incoming, 1_000)).toBe(20);
    expect(ringSecondsLeft(incoming, 13_400)).toBe(8);
    expect(ringSecondsLeft(incoming, 99_000)).toBe(0);
    expect(ringSecondsLeft({ ...incoming, ringTimeoutSeconds: null }, 5_000)).toBeNull();
  });
});

describe('shell navigation', () => {
  it('starts on the idle Llamada tab, switches tabs and jumps back to Llamada when a call starts', async () => {
    loginAs();
    const fake = fakeClient({
      presence: { operators: [{ ...OPERATOR, status: 'available' }], activeCalls: 0, maxCalls: 3 },
      server: { providers: 'mock', channel: 'mock', debug: true, maxCalls: 3, localAudio: true },
    });
    renderWithClient(<AppShell />, fake);

    expect(screen.getByRole('tab', { name: 'Llamada' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('idle-panel')).toHaveTextContent('Esperando llamadas');
    expect(screen.getByTestId('presence')).toHaveTextContent('0 de 3');
    expect(screen.getByText('Simulado')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Marcador' }));
    expect(screen.getByTestId('dialer')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Historial' }));
    expect(await screen.findByTestId('history')).toBeInTheDocument();
    expect(api.listCalls).toHaveBeenCalled();

    fake.set({ call: makeActiveCall() });
    expect(screen.getByRole('tab', { name: /Llamada/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('call-screen')).toBeInTheDocument();

    // Leaving the tab during the same call does not drag the operator back.
    fireEvent.click(screen.getByRole('tab', { name: 'Ajustes' }));
    expect(await screen.findByTestId('settings')).toBeInTheDocument();
    fake.set({ call: makeActiveCall({ muted: true }) });
    expect(screen.getByRole('tab', { name: 'Ajustes' })).toHaveAttribute('aria-selected', 'true');
  });

  it('shows the connection problem and the server error outside the call tabs', async () => {
    loginAs();
    const fake = fakeClient({ connection: 'reconnecting', connectionError: 'Se perdió la conexión' });
    renderWithClient(<AppShell />, fake);
    expect(screen.getByTestId('connection-status')).toHaveTextContent('Reconectando con el servidor…');
    expect(screen.getByTestId('connection-notice')).toHaveTextContent('Se perdió la conexión');

    fireEvent.click(screen.getByRole('tab', { name: 'Historial' }));
    await screen.findByTestId('history');
    fake.set({ lastError: { code: 'internal_error', message: 'Fallo interno', at: Date.now() } });
    expect(screen.getByTestId('global-error')).toHaveTextContent('Fallo interno');
    fireEvent.click(within(screen.getByTestId('global-error')).getByRole('button', { name: 'Entendido' }));
    expect(fake.actions.dismissError).toHaveBeenCalled();
  });

  it('logs out through the API and returns to the login screen', async () => {
    loginAs();
    renderWithClient(<AppShell />, fakeClient());
    fireEvent.click(screen.getByRole('button', { name: 'Salir' }));
    expect(await screen.findByTestId('login-screen')).toBeInTheDocument();
    expect(api.logout).toHaveBeenCalledTimes(1);
    expect(getSession()).toBeNull();
  });
});
