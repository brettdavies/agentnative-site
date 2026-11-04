import { describe, expect, test } from 'bun:test';
import { SOURCE_CHECKS } from '../src/worker/audit-web/antecedents';

describe('SOURCE_CHECKS', () => {
  test('every source check id exists in the shipped registry ordering contract', () => {
    for (const id of [
      'robots',
      'llms-txt',
      'llms-full-txt',
      'openapi',
      'oauth-discovery',
      'mcp-initialize',
      'mcp-server-discover',
      'sitemap',
      'accept-markdown',
    ]) {
      expect(SOURCE_CHECKS.has(id)).toBe(true);
    }
  });

  test('api-catalog is not a source check: its anchors come from the catalog discovery already read', () => {
    expect(SOURCE_CHECKS.has('api-catalog')).toBe(false);
  });
});
