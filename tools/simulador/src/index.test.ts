import { SIM_WS_PATH } from '@tw/shared';
import { describe, expect, it } from 'vitest';
import * as simulador from './index.js';

describe('@tw/simulador public surface', () => {
  it('exposes the client, the script tools, the commands and the fake server', () => {
    expect(simulador.SIMULADOR_PACKAGE).toBe('@tw/simulador');
    expect(SIM_WS_PATH).toBe('/sim');
    expect(typeof simulador.SimClient.connect).toBe('function');
    expect(typeof simulador.parseScript).toBe('function');
    expect(typeof simulador.runScript).toBe('function');
    expect(typeof simulador.llamar).toBe('function');
    expect(typeof simulador.escuchar).toBe('function');
    expect(typeof simulador.colgar).toBe('function');
    expect(typeof simulador.cargarPrueba).toBe('function');
    expect(typeof simulador.runCli).toBe('function');
    expect(typeof simulador.FakeSimServer.start).toBe('function');
    expect(simulador.EXIT).toEqual({ OK: 0, USAGE: 1, CALL_FAILED: 2, CONNECTION: 3 });
  });
});
