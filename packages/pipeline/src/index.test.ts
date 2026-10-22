import { INTERNAL_SAMPLE_RATE } from '@tw/shared';
import { describe, expect, it } from 'vitest';
import { PIPELINE_PACKAGE } from './index.js';

describe('@tw/pipeline skeleton', () => {
  it('loads and resolves @tw/shared from source', () => {
    expect(PIPELINE_PACKAGE).toBe('@tw/pipeline');
    expect(INTERNAL_SAMPLE_RATE).toBe(16_000);
  });
});
