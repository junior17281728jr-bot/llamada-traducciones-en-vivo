/**
 * Server URL and login session of this window.
 *
 * Owner: whoever owns src/core/** (connection, audio, call screen). The login screen
 * (src/app) calls `setSession` after `POST /api/login` and `clearSession` on logout.
 *
 * The token lives in memory and in sessionStorage (so a reload keeps the login, but closing
 * the window forgets it). The server URL is remembered in localStorage. Both storages can be
 * missing or throw (private windows, blocked storage): everything still works without them.
 */
import { useSyncExternalStore } from 'react';
import type { OperatorInfo } from '@tw/shared';

export interface Session {
  /** Base URL of the server, e.g. `http://127.0.0.1:8787` (no trailing slash). */
  serverUrl: string;
  /** Bearer token for the HTTP API and `auth.resume` on the operator WebSocket. */
  token: string;
  /** Epoch ms when the token stops being valid. */
  expiresAt: number;
  operator: OperatorInfo;
}

/** What the Electron preload reports (`window.telecomway.getConfig()`). */
export interface DesktopConfig {
  serverUrl: string;
  platform: string;
  version: string;
  /** Present when the app runs its own embedded (simulated) server: the local login it created. */
  embedded?: { username: string; password: string } | null;
}

/** What `window.telecomway.simulateCall()` reports. */
export interface SimulatedCallResult {
  outcome: 'completed' | 'not_answered' | 'rejected' | 'ended_early' | 'unsupported';
  callId?: string | null;
  reason?: string;
  message?: string;
}

/** Embedded server only. Null in a browser or when the app talks to an external server. */
export async function requestSimulatedCall(): Promise<SimulatedCallResult | null> {
  try {
    const bridge = window.telecomway;
    if (!bridge?.simulateCall) return null;
    return await bridge.simulateCall();
  } catch {
    return { outcome: 'unsupported', message: 'No se pudo lanzar la llamada de prueba.' };
  }
}

export function canSimulateCall(): boolean {
  return typeof window !== 'undefined' && typeof window.telecomway?.simulateCall === 'function';
}

export const FALLBACK_SERVER_URL = 'http://127.0.0.1:8787';
const SESSION_KEY = 'tw.session';
const SERVER_URL_KEY = 'tw.serverUrl';

let current: Session | null = null;
let loaded = false;
const listeners = new Set<() => void>();

function readStorage(kind: 'session' | 'local', key: string): string | null {
  try {
    return (kind === 'session' ? window.sessionStorage : window.localStorage).getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(kind: 'session' | 'local', key: string, value: string | null): void {
  try {
    const storage = kind === 'session' ? window.sessionStorage : window.localStorage;
    if (value === null) storage.removeItem(key);
    else storage.setItem(key, value);
  } catch {
    /* storage unavailable: keep working in memory */
  }
}

export function normalizeServerUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

function isSession(value: unknown): value is Session {
  const candidate = value as Partial<Session> | null;
  return (
    typeof candidate === 'object' &&
    candidate !== null &&
    typeof candidate.serverUrl === 'string' &&
    typeof candidate.token === 'string' &&
    typeof candidate.expiresAt === 'number' &&
    typeof candidate.operator === 'object'
  );
}

function load(): void {
  if (loaded) return;
  loaded = true;
  const raw = readStorage('session', SESSION_KEY);
  if (!raw) return;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isSession(parsed) && parsed.expiresAt > Date.now()) current = parsed;
    else writeStorage('session', SESSION_KEY, null);
  } catch {
    writeStorage('session', SESSION_KEY, null);
  }
}

function emit(): void {
  for (const listener of [...listeners]) listener();
}

/** Current session, or null when nobody is logged in (or the token expired). */
export function getSession(): Session | null {
  load();
  if (current && current.expiresAt <= Date.now()) {
    current = null;
    writeStorage('session', SESSION_KEY, null);
  }
  return current;
}

export function setSession(session: Session): void {
  load();
  current = { ...session, serverUrl: normalizeServerUrl(session.serverUrl) };
  writeStorage('session', SESSION_KEY, JSON.stringify(current));
  writeStorage('local', SERVER_URL_KEY, current.serverUrl);
  emit();
}

export function clearSession(): void {
  load();
  current = null;
  writeStorage('session', SESSION_KEY, null);
  emit();
}

export function subscribeSession(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** React hook: re-renders when the session changes. */
export function useSession(): Session | null {
  return useSyncExternalStore(subscribeSession, getSession, getSession);
}

/** Server URL to offer on the login form: last used, else `VITE_SERVER_URL`, else the local default. */
export function defaultServerUrl(): string {
  const remembered = readStorage('local', SERVER_URL_KEY);
  const fromBuild = (import.meta.env?.['VITE_SERVER_URL'] as string | undefined) ?? '';
  return normalizeServerUrl(remembered || fromBuild || FALLBACK_SERVER_URL);
}

/** Config from the Electron preload; null in a plain browser or when the bridge fails. */
export async function readDesktopConfig(): Promise<DesktopConfig | null> {
  try {
    return (await window.telecomway?.getConfig()) ?? null;
  } catch {
    return null;
  }
}

/** `http(s)://host` to `ws(s)://host/path`. */
export function websocketUrl(serverUrl: string, path: string): string {
  const base = normalizeServerUrl(serverUrl).replace(/^http/i, 'ws');
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

/** Test helper: forget everything held in memory and in the storages. */
export function resetSessionForTests(): void {
  current = null;
  loaded = false;
  writeStorage('session', SESSION_KEY, null);
  writeStorage('local', SERVER_URL_KEY, null);
  listeners.clear();
}
