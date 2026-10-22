import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OperatorInfo } from '@tw/shared';
import { ApiError, api } from './http';
import { resetSessionForTests, setSession } from './session';

const operator: OperatorInfo = {
  id: 'op1',
  name: 'Ana',
  role: 'admin',
  status: 'available',
  currentCallId: null,
  autoAccept: false,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('api', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    resetSessionForTests();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  function login(): void {
    setSession({ serverUrl: 'http://srv:8787', token: 'abc', expiresAt: Date.now() + 60_000, operator });
  }

  it('logs in without a token against the given server', async () => {
    fetchMock.mockResolvedValue(json({ token: 'abc', expiresAt: 1, operator }));
    const result = await api.login('http://srv:8787/', { username: 'ana', password: 'x' });
    expect(result.token).toBe('abc');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://srv:8787/api/login');
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>)['Authorization']).toBeUndefined();
    expect(init?.body).toBe(JSON.stringify({ username: 'ana', password: 'x' }));
  });

  it('sends the bearer token and builds query strings', async () => {
    login();
    fetchMock.mockResolvedValue(json({ calls: [] }));
    await api.listCalls({ limit: 20, direction: 'inbound', operatorId: undefined });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://srv:8787/api/calls?limit=20&direction=inbound');
    expect((init?.headers as Record<string, string>)['Authorization']).toBe('Bearer abc');
  });

  it('refuses authenticated calls without a session', async () => {
    await expect(api.getLanguages()).rejects.toMatchObject({ code: 'no_server' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('turns server errors and network failures into ApiError', async () => {
    login();
    fetchMock.mockResolvedValueOnce(json({ error: { code: 'forbidden', message: 'Solo administradores' } }, 403));
    await expect(api.getKeys()).rejects.toMatchObject({ status: 403, code: 'forbidden', message: 'Solo administradores' });
    fetchMock.mockResolvedValueOnce(new Response('oops', { status: 500 }));
    await expect(api.getKeys()).rejects.toBeInstanceOf(ApiError);
    fetchMock.mockRejectedValueOnce(new TypeError('failed'));
    await expect(api.getKeys()).rejects.toMatchObject({ code: 'network' });
  });

  it('uses the typed paths for settings and tests', async () => {
    login();
    fetchMock.mockResolvedValue(json({ keys: {} }));
    await api.putKeys({ keys: { ELEVENLABS_API_KEY: 'sk-test' } });
    expect(fetchMock.mock.calls[0]![0]).toBe('http://srv:8787/api/settings/keys');
    expect(fetchMock.mock.calls[0]![1]?.method).toBe('PUT');
    fetchMock.mockResolvedValue(json({ service: 'elevenlabs', status: 'simulated' }));
    await api.testService('elevenlabs');
    expect(fetchMock.mock.calls[1]![0]).toBe('http://srv:8787/api/settings/test/elevenlabs');
    expect(fetchMock.mock.calls[1]![1]?.method).toBe('POST');
  });
});
