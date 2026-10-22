import { describe, expect, it } from 'vitest';
import { LoginRateLimiter, OperatorStore, SessionStore, hashPassword, verifyPassword } from './auth.js';
import { tempDataDir } from './test-utils.js';

describe('passwords', () => {
  it('hashes with a random salt and verifies', async () => {
    const a = await hashPassword('correct horse battery');
    const b = await hashPassword('correct horse battery');
    expect(a).not.toEqual(b);
    expect(a).not.toContain('correct horse');
    expect(await verifyPassword('correct horse battery', a)).toBe(true);
    expect(await verifyPassword('wrong password', a)).toBe(false);
    expect(await verifyPassword('x', 'not-a-hash')).toBe(false);
  });
});

describe('OperatorStore', () => {
  it('creates and authenticates operators, persisting them without plaintext passwords', async () => {
    const dir = await tempDataDir();
    const store = OperatorStore.inDataDir(dir);
    const created = await store.create({ username: 'Marta', password: 'una-clave-larga', role: 'admin' });
    expect(created).toMatchObject({ username: 'Marta', role: 'admin', name: 'Marta' });

    const reloaded = OperatorStore.inDataDir(dir);
    expect((await reloaded.authenticate('marta', 'una-clave-larga'))?.id).toBe(created.id);
    expect(await reloaded.authenticate('marta', 'otra-clave-larga')).toBeNull();
    expect(await reloaded.authenticate('nadie', 'una-clave-larga')).toBeNull();
    const { readFile } = await import('node:fs/promises');
    expect(await readFile(`${dir}/operators.json`, 'utf8')).not.toContain('una-clave-larga');
  });

  it('rejects duplicates, bad usernames and short passwords', async () => {
    const store = OperatorStore.inDataDir(await tempDataDir());
    await store.create({ username: 'ana', password: 'contraseña-1' });
    await expect(store.create({ username: 'ANA', password: 'contraseña-2' })).rejects.toThrow('ya existe');
    await expect(store.create({ username: '../x', password: 'contraseña-3' })).rejects.toThrow('usuario');
    await expect(store.create({ username: 'pepe', password: 'corta' })).rejects.toThrow('8 caracteres');
  });
});

describe('SessionStore', () => {
  it('resolves live tokens, expires them and revokes them', () => {
    let now = 1000;
    const sessions = new SessionStore(500, () => now);
    const { token } = sessions.create('op1');
    expect(sessions.resolve(token)).toEqual({ session: { operatorId: 'op1', expiresAt: 1500 } });
    expect(sessions.resolve('nope')).toEqual({ error: 'invalid' });
    now = 1500;
    expect(sessions.resolve(token)).toEqual({ error: 'expired' });
    expect(sessions.resolve(token)).toEqual({ error: 'invalid' });
    const second = sessions.create('op1');
    sessions.revoke(second.token);
    expect(sessions.resolve(second.token)).toEqual({ error: 'invalid' });
  });
});

describe('LoginRateLimiter', () => {
  it('blocks after repeated failures and forgets them after the window or a success', () => {
    let now = 0;
    const limiter = new LoginRateLimiter(3, 1000, () => now);
    for (let i = 0; i < 3; i++) limiter.recordFailure('ip|ana');
    expect(limiter.isBlocked('ip|ana')).toBe(true);
    expect(limiter.isBlocked('ip|otro')).toBe(false);
    now = 1001;
    expect(limiter.isBlocked('ip|ana')).toBe(false);
    limiter.recordFailure('ip|ana');
    limiter.recordSuccess('ip|ana');
    expect(limiter.isBlocked('ip|ana')).toBe(false);
  });
});
