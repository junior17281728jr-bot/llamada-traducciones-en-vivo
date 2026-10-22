import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OperatorInfo } from '@tw/shared';
import {
  clearSession,
  defaultServerUrl,
  getSession,
  normalizeServerUrl,
  resetSessionForTests,
  setSession,
  subscribeSession,
  websocketUrl,
  type Session,
} from './session';

const operator: OperatorInfo = {
  id: 'op1',
  name: 'Ana',
  role: 'operator',
  status: 'available',
  currentCallId: null,
  autoAccept: false,
};

function session(overrides: Partial<Session> = {}): Session {
  return { serverUrl: 'http://127.0.0.1:8787/', token: 't0ken', expiresAt: Date.now() + 60_000, operator, ...overrides };
}

describe('session store', () => {
  beforeEach(() => resetSessionForTests());
  afterEach(() => vi.useRealTimers());

  it('starts empty, stores the session and notifies subscribers', () => {
    const listener = vi.fn();
    subscribeSession(listener);
    expect(getSession()).toBeNull();
    setSession(session());
    expect(getSession()?.token).toBe('t0ken');
    expect(getSession()?.serverUrl).toBe('http://127.0.0.1:8787');
    expect(listener).toHaveBeenCalledTimes(1);
    clearSession();
    expect(getSession()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('survives a reload through sessionStorage and remembers the server URL', () => {
    setSession(session());
    // Simulate a reload: forget memory only.
    const stored = window.sessionStorage.getItem('tw.session');
    resetSessionForTests();
    window.sessionStorage.setItem('tw.session', stored!);
    expect(getSession()?.operator.name).toBe('Ana');
    expect(defaultServerUrl()).toBe('http://127.0.0.1:8787');
  });

  it('forgets an expired token', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    setSession(session({ expiresAt: 1_000_500 }));
    expect(getSession()).not.toBeNull();
    vi.setSystemTime(1_001_000);
    expect(getSession()).toBeNull();
  });

  it('ignores corrupt stored data', () => {
    resetSessionForTests();
    window.sessionStorage.setItem('tw.session', '{not json');
    expect(getSession()).toBeNull();
  });

  it('falls back to the local default server URL', () => {
    expect(defaultServerUrl()).toBe('http://127.0.0.1:8787');
  });
});

describe('URL helpers', () => {
  it('normalises the server URL and builds WebSocket URLs', () => {
    expect(normalizeServerUrl(' http://host:1/// ')).toBe('http://host:1');
    expect(websocketUrl('http://host:8787/', '/operator')).toBe('ws://host:8787/operator');
    expect(websocketUrl('https://tw.example.com', 'operator')).toBe('wss://tw.example.com/operator');
  });
});
