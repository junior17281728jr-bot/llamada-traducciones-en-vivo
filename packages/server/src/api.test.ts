import { describe, expect, it } from 'vitest';
import { matchesCallQuery } from './api.js';

const call = { id: 'a1b2c3d4-9990-4e5f-8a6b-7c8d9e0f1a2b', remoteNumber: '+44 1234 567890' };

describe('matchesCallQuery', () => {
  it('matches the number ignoring spaces, case-insensitively', () => {
    expect(matchesCallQuery(call, undefined)).toBe(true);
    expect(matchesCallQuery(call, '')).toBe(true);
    expect(matchesCallQuery(call, '441234')).toBe(true);
    expect(matchesCallQuery(call, '+44 1234')).toBe(true);
    expect(matchesCallQuery(call, '999')).toBe(false);
  });

  it('matches the id only whole or by a prefix of at least 8 characters', () => {
    expect(matchesCallQuery(call, call.id)).toBe(true);
    expect(matchesCallQuery(call, 'a1b2c3d4')).toBe(true);
    expect(matchesCallQuery(call, 'a1b2c3')).toBe(false);
    expect(matchesCallQuery(call, '9990-4e5f')).toBe(false);
  });
});
