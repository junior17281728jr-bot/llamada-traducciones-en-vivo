import { resolve } from 'node:path';
import {
  CHANNEL_KINDS,
  LANGUAGE_MODES,
  PROVIDER_MODES,
  normalizeLanguageCode,
  type ChannelKind,
  type LanguageCode,
  type LanguageMode,
  type ProviderMode,
} from '@tw/shared';

export interface ServerConfig {
  host: string;
  port: number;
  providers: ProviderMode;
  channel: ChannelKind;
  dataDir: string;
  secretsKey: string | null;
  /** Sessions live in memory: a restart logs every operator out. */
  sessionTtlHours: number;
  /** Seconds a call survives a dropped operator connection while the app reconnects (0 = hang up at once). */
  reconnectGraceSeconds: number;
  maxConcurrentCalls: number;
  autoAccept: boolean;
  ringTimeoutSeconds: number;
  recordCalls: boolean;
  /** 0 = keep forever. */
  retentionDays: number;
  callNoticeText: string;
  defaultOperatorLang: LanguageCode;
  defaultLanguageMode: LanguageMode;
  fallbackLang: LanguageCode;
  langHoldSeconds: number;
  langConfirmSegments: number;
  langMinWords: number;
  langMinProbability: number;
  langChangeSegments: number;
  languageCatalogLive: boolean;
  allowedOrigins: string[];
  adminUsername: string;
  adminPassword: string | null;
  initialOperators: { username: string; password: string }[];
}

export class ConfigError extends Error {}

type Env = Record<string, string | undefined>;

function text(env: Env, name: string, fallback: string): string {
  const value = env[name]?.trim();
  return value ? value : fallback;
}

function integer(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(`${name} debe ser un número entero entre ${min} y ${max} (valor: "${raw}")`);
  }
  return value;
}

function decimal(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new ConfigError(`${name} debe ser un número entre ${min} y ${max} (valor: "${raw}")`);
  }
  return value;
}

function flag(env: Env, name: string, fallback: boolean): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes', 'si', 'sí'].includes(raw)) return true;
  if (['0', 'false', 'no'].includes(raw)) return false;
  throw new ConfigError(`${name} debe ser true o false (valor: "${raw}")`);
}

function oneOf<T extends string>(env: Env, name: string, allowed: readonly T[], fallback: T): T {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  if ((allowed as readonly string[]).includes(raw)) return raw as T;
  throw new ConfigError(`${name} debe ser uno de: ${allowed.join(', ')} (valor: "${raw}")`);
}

function language(env: Env, name: string, fallback: LanguageCode): LanguageCode {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const code = normalizeLanguageCode(raw);
  if (!code) throw new ConfigError(`${name} no es un idioma conocido (valor: "${raw}")`);
  return code;
}

/** Reads and validates the environment. Throws `ConfigError` (message in Spanish) on the first problem. */
export function loadConfig(env: Env = process.env): ServerConfig {
  const channel = oneOf(env, 'CHANNEL', CHANNEL_KINDS, 'mock');
  const initialOperators = (env.OPERATORS ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const index = entry.indexOf(':');
      if (index <= 0 || index === entry.length - 1) {
        throw new ConfigError('OPERATORS debe tener el formato usuario:contraseña,usuario2:contraseña2');
      }
      return { username: entry.slice(0, index), password: entry.slice(index + 1) };
    });

  return {
    host: text(env, 'HOST', '127.0.0.1'),
    port: integer(env, 'PORT', 8787, 0, 65535),
    providers: oneOf(env, 'PROVIDERS', PROVIDER_MODES, 'mock'),
    channel,
    dataDir: resolve(text(env, 'DATA_DIR', './data')),
    secretsKey: env.SECRETS_KEY?.trim() || null,
    sessionTtlHours: integer(env, 'SESSION_TTL_HOURS', 12, 1, 24 * 30),
    reconnectGraceSeconds: integer(env, 'RECONNECT_GRACE_SECONDS', 10, 0, 300),
    maxConcurrentCalls: integer(env, 'MAX_CONCURRENT_CALLS', 3, 1, 100),
    autoAccept: flag(env, 'AUTO_ACCEPT', false),
    ringTimeoutSeconds: integer(env, 'RING_TIMEOUT_SECONDS', 30, 1, 600),
    recordCalls: flag(env, 'RECORD_CALLS', false),
    retentionDays: integer(env, 'RETENTION_DAYS', 90, 0, 36500),
    callNoticeText: text(env, 'CALL_NOTICE_TEXT', ''),
    defaultOperatorLang: language(env, 'DEFAULT_OPERATOR_LANG', 'es'),
    defaultLanguageMode: oneOf(env, 'DEFAULT_LANGUAGE_MODE', LANGUAGE_MODES, 'auto'),
    fallbackLang: language(env, 'FALLBACK_LANG', 'en'),
    langHoldSeconds: decimal(env, 'LANG_HOLD_SECONDS', 4, 0, 60),
    langConfirmSegments: integer(env, 'LANG_CONFIRM_SEGMENTS', 2, 1, 10),
    langMinWords: integer(env, 'LANG_MIN_WORDS', 3, 1, 20),
    langMinProbability: decimal(env, 'LANG_MIN_PROBABILITY', 0.6, 0, 1),
    langChangeSegments: integer(env, 'LANG_CHANGE_SEGMENTS', 3, 1, 20),
    languageCatalogLive: flag(env, 'LANGUAGE_CATALOG_LIVE', false),
    allowedOrigins: (env.ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
    adminUsername: text(env, 'ADMIN_USERNAME', 'admin'),
    adminPassword: env.ADMIN_PASSWORD?.trim() || null,
    initialOperators,
  };
}
