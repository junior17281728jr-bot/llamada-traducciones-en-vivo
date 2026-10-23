import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

import { api } from '../core/http';
import { resetCatalogCache } from '../core/catalog';
import { getSession, resetSessionForTests } from '../core/session';
import { AppShell } from './AppShell';
import { OPERATOR, fakeClient, loginAs, renderWithClient } from './test-utils';

const bridge = {
  getConfig: vi.fn(),
  simulateCall: vi.fn(),
};

beforeEach(() => {
  resetSessionForTests();
  resetCatalogCache();
  vi.clearAllMocks();
  (window as unknown as { telecomway?: unknown }).telecomway = bridge;
});
afterEach(() => {
  delete (window as unknown as { telecomway?: unknown }).telecomway;
});

describe('the app with its embedded server', () => {
  it('signs in by itself with the local login the app created', async () => {
    bridge.getConfig.mockResolvedValue({
      serverUrl: 'http://127.0.0.1:43123/',
      platform: 'darwin',
      version: '0.1.0',
      embedded: { username: 'admin', password: 'clave-generada' },
    });
    vi.mocked(api.login).mockResolvedValue({ token: 'tok', expiresAt: Date.now() + 1e6, operator: { ...OPERATOR, role: 'admin' } });
    renderWithClient(<AppShell />, fakeClient());
    await waitFor(() => expect(api.login).toHaveBeenCalledWith('http://127.0.0.1:43123', { username: 'admin', password: 'clave-generada' }));
    await waitFor(() => expect(getSession()?.serverUrl).toBe('http://127.0.0.1:43123'));
  });

  it('does not sign in by itself when the app talks to an external server', async () => {
    bridge.getConfig.mockResolvedValue({ serverUrl: 'http://10.0.0.5:8787', platform: 'win32', version: '0.1.0', embedded: null });
    renderWithClient(<AppShell />, fakeClient());
    await screen.findByTestId('login-screen');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(api.login).not.toHaveBeenCalled();
    expect(getSession()).toBeNull();
  });

  it('offers a simulated test call when the bridge has one, and reports its outcome', async () => {
    bridge.getConfig.mockResolvedValue({ serverUrl: 'http://127.0.0.1:43123', platform: 'darwin', version: '0.1.0', embedded: { username: 'admin', password: 'x' } });
    bridge.simulateCall.mockResolvedValue({ outcome: 'completed', callId: 'c1' });
    loginAs(OPERATOR);
    renderWithClient(<AppShell />, fakeClient({ server: { providers: 'mock', channel: 'mock', debug: true, maxCalls: 3 } }));
    const card = await screen.findByTestId('test-call-card');
    expect(card).toHaveTextContent('Simulado');
    fireEvent.click(screen.getByRole('button', { name: 'Recibir llamada de prueba' }));
    expect(bridge.simulateCall).toHaveBeenCalledTimes(1);
    await screen.findByText(/La llamada de prueba ha terminado/);
  });

  it('hides the test call in a plain browser', async () => {
    delete (window as unknown as { telecomway?: unknown }).telecomway;
    loginAs(OPERATOR);
    renderWithClient(<AppShell />, fakeClient());
    await screen.findByTestId('idle-panel');
    expect(screen.queryByTestId('test-call-card')).toBeNull();
  });
});
