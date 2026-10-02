import { describe, expect, test } from 'bun:test';
import { WAVE1_CHECK_IDS } from '../src/worker/audit-web/antecedents';

describe('WAVE1_CHECK_IDS', () => {
  test('every wave-1 source check id exists in the shipped registry ordering contract', () => {
    for (const id of [
      'robots',
      'llms-txt',
      'llms-full-txt',
      'openapi',
      'oauth-discovery',
      'mcp-initialize',
      'sitemap',
      'accept-markdown',
    ]) {
      expect(WAVE1_CHECK_IDS.has(id)).toBe(true);
    }
  });

  test('api-catalog is not probed in wave 1: its anchors come from the catalog discovery already read', () => {
    expect(WAVE1_CHECK_IDS.has('api-catalog')).toBe(false);
  });
});
