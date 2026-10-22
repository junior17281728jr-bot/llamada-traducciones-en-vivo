import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { join } from 'node:path';
import type { OperatorRole } from '@tw/shared';
import { readJsonFile, writePrivateFile } from './files.js';

const KEY_LENGTH = 32;
const SCRYPT: ScryptOptions = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LENGTH, SCRYPT, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

/** Format: scrypt$<salt base64>$<hash base64>. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await derive(password, salt);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await derive(password, Buffer.from(saltB64, 'base64'));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export interface OperatorAccount {
  id: string;
  username: string;
  name: string;
  role: OperatorRole;
  passwordHash: string;
  createdAt: number;
}

interface OperatorFile {
  operators: OperatorAccount[];
}

export class OperatorStore {
  private accounts: OperatorAccount[] = [];
  private loaded = false;
  private dummyHash: Promise<string> | null = null;

  constructor(private readonly path: string) {}

  static inDataDir(dataDir: string): OperatorStore {
    return new OperatorStore(join(dataDir, 'operators.json'));
  }

  async load(): Promise<void> {
    this.accounts = (await readJsonFile<OperatorFile>(this.path))?.operators ?? [];
    this.loaded = true;
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) await this.load();
  }

  async list(): Promise<OperatorAccount[]> {
    await this.ensureLoaded();
    return [...this.accounts];
  }

  async get(id: string): Promise<OperatorAccount | null> {
    await this.ensureLoaded();
    return this.accounts.find((account) => account.id === id) ?? null;
  }

  async create(input: { username: string; password: string; name?: string; role?: OperatorRole }): Promise<OperatorAccount> {
    await this.ensureLoaded();
    const username = input.username.trim();
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(username)) throw new Error('El usuario solo admite letras, números, punto, guion y guion bajo');
    if (input.password.length < 8) throw new Error('La contraseña debe tener al menos 8 caracteres');
    if (this.accounts.some((account) => account.username.toLowerCase() === username.toLowerCase())) {
      throw new Error('Ese usuario ya existe');
    }
    const account: OperatorAccount = {
      id: randomUUID(),
      username,
      name: input.name?.trim() || username,
      role: input.role ?? 'operator',
      passwordHash: await hashPassword(input.password),
      createdAt: Date.now(),
    };
    this.accounts.push(account);
    await this.save();
    return account;
  }

  /** Constant-ish time whether or not the user exists (a dummy hash is checked for unknown users). */
  async authenticate(username: string, password: string): Promise<OperatorAccount | null> {
    await this.ensureLoaded();
    const account = this.accounts.find((candidate) => candidate.username.toLowerCase() === username.trim().toLowerCase());
    this.dummyHash ??= hashPassword(randomBytes(8).toString('hex'));
    const ok = await verifyPassword(password, account?.passwordHash ?? (await this.dummyHash));
    return account && ok ? account : null;
  }

  private save(): Promise<void> {
    return writePrivateFile(this.path, JSON.stringify({ operators: this.accounts } satisfies OperatorFile, null, 2));
  }
}

export interface Session {
  operatorId: string;
  expiresAt: number;
}

/** In-memory session tokens. Only a SHA-256 of each token is kept, so a memory dump does not reveal live tokens. */
export class SessionStore {
  private readonly sessions = new Map<string, Session>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private static key(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  create(operatorId: string): { token: string; expiresAt: number } {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = this.now() + this.ttlMs;
    this.sessions.set(SessionStore.key(token), { operatorId, expiresAt });
    return { token, expiresAt };
  }

  /** `expired` lets the caller tell "token_expired" from "token_invalid". */
  resolve(token: string): { session: Session } | { error: 'invalid' | 'expired' } {
    const key = SessionStore.key(token);
    const session = this.sessions.get(key);
    if (!session) return { error: 'invalid' };
    if (session.expiresAt <= this.now()) {
      this.sessions.delete(key);
      return { error: 'expired' };
    }
    return { session };
  }

  revoke(token: string): void {
    this.sessions.delete(SessionStore.key(token));
  }

  revokeOperator(operatorId: string): void {
    for (const [key, session] of this.sessions) if (session.operatorId === operatorId) this.sessions.delete(key);
  }
}

/** Blocks a (client, user) pair after repeated failed logins. */
export class LoginRateLimiter {
  private readonly failures = new Map<string, number[]>();

  constructor(
    private readonly maxFailures = 5,
    private readonly windowMs = 5 * 60_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private recent(key: string): number[] {
    const cutoff = this.now() - this.windowMs;
    const list = (this.failures.get(key) ?? []).filter((at) => at > cutoff);
    if (list.length === 0) this.failures.delete(key);
    else this.failures.set(key, list);
    return list;
  }

  isBlocked(key: string): boolean {
    return this.recent(key).length >= this.maxFailures;
  }

  recordFailure(key: string): void {
    this.failures.set(key, [...this.recent(key), this.now()]);
  }

  recordSuccess(key: string): void {
    this.failures.delete(key);
  }
}
