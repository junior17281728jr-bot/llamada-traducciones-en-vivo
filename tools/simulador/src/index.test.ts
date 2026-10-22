import { SIM_WS_PATH } from '@tw/shared';
import { describe, expect, it } from 'vitest';
import { SIMULADOR_PACKAGE } from './index.js';

describe('@tw/simulador skeleton', () => {
  it('loads and resolves @tw/shared from source', () => {
    expect(SIMULADOR_PACKAGE).toBe('@tw/simulador');
    expect(SIM_WS_PATH).toBe('/sim');
  });
});
