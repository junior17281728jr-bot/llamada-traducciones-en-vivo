import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CONTROL_DIR_ENV, ControlServer, defaultControlDir, hangupPhones, listRegisteredPhones, requestHangup } from './control.js';

const running: ControlServer[] = [];
afterEach(async () => {
  for (const server of running.splice(0)) await server.stop();
});

async function freshDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'tw-sim-control-'));
}

describe('control channel', () => {
  it('uses the env override or the temp folder', () => {
    expect(defaultControlDir({ [CONTROL_DIR_ENV]: '/x/y' })).toBe('/x/y');
    expect(defaultControlDir({ [CONTROL_DIR_ENV]: '  ' })).toBe(join(tmpdir(), 'telecomway-simulador'));
    expect(defaultControlDir({})).toBe(join(tmpdir(), 'telecomway-simulador'));
  });

  it('registers a phone, hangs it up through the socket and forgets it on stop', async () => {
    const dir = await freshDir();
    let hangups = 0;
    const server = await ControlServer.start({ dir, numero: '+447700900123', idioma: 'en', comando: 'llamar', onHangup: () => void (hangups += 1) });
    running.push(server);
    const phones = await listRegisteredPhones(dir);
    expect(phones).toHaveLength(1);
    expect(phones[0]!.registration).toMatchObject({ pid: process.pid, numero: '+447700900123', idioma: 'en', comando: 'llamar' });
    expect(phones[0]!.registration.port).toBe(server.registration.port);

    expect(await requestHangup(phones[0]!.registration)).toBe('ok');
    expect(hangups).toBe(1);
    expect(await requestHangup({ ...phones[0]!.registration, token: 'incorrecto' })).toBe('rechazado');
    expect(hangups).toBe(1);

    await server.stop();
    running.splice(running.indexOf(server), 1);
    expect(await listRegisteredPhones(dir)).toEqual([]);
    expect(await requestHangup(phones[0]!.registration)).toBe('no_disponible');
  });

  it('hangupPhones filters by number and removes stale registrations', async () => {
    const dir = await freshDir();
    const calls: string[] = [];
    const a = await ControlServer.start({ dir, numero: '+44 7700 900123', idioma: 'en', comando: 'llamar', onHangup: () => void calls.push('a') });
    const b = await ControlServer.start({ dir, numero: '+33612345678', idioma: 'fr', comando: 'escuchar', onHangup: () => void calls.push('b') });
    running.push(a, b);
    await writeFile(join(dir, '99999-1.json'), JSON.stringify({ pid: 99999, port: 1, token: 't', numero: '+1', idioma: 'en', comando: 'llamar', iniciado: 0 }));
    await writeFile(join(dir, 'basura.json'), '{ roto');
    await writeFile(join(dir, 'incompleto.json'), JSON.stringify({ pid: 1 }));

    const onlyA = await hangupPhones({ dir, numero: '+447700900123' });
    expect(onlyA.map((o) => [o.phone.registration.numero, o.result])).toEqual([['+44 7700 900123', 'ok']]);
    expect(calls).toEqual(['a']);

    const all = await hangupPhones({ dir, timeoutMs: 500 });
    expect(all.map((o) => o.result).sort()).toEqual(['no_disponible', 'ok', 'ok']);
    expect([...calls].sort()).toEqual(['a', 'a', 'b']);
    const files = await readdir(dir);
    expect(files).not.toContain('99999-1.json');
    expect(files).toContain('basura.json');
  });

  it('lists nothing for a missing folder', async () => {
    expect(await listRegisteredPhones(join(tmpdir(), 'tw-sim-no-existe-' + Date.now()))).toEqual([]);
    expect(await hangupPhones({ dir: join(tmpdir(), 'tw-sim-no-existe-' + Date.now()) })).toEqual([]);
  });
});
