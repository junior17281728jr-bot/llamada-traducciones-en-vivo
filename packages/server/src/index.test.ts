import { OPERATOR_WS_PATH } from '@tw/shared';
import { describe, expect, it } from 'vitest';
import { SERVER_PACKAGE } from './index.js';

describe('@tw/server skeleton', () => {
  it('loads and resolves @tw/shared from source', () => {
    expect(SERVER_PACKAGE).toBe('@tw/server');
    expect(OPERATOR_WS_PATH).toBe('/operator');
  });
});
