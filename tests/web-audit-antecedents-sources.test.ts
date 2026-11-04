import { describe, expect, test } from 'bun:test';
import { loadRegistry } from '../scripts/web-audit/conformance-corpus';
import { SOURCE_CHECKS } from '../src/worker/audit-web/antecedents';

describe('SOURCE_CHECKS', () => {
  test('every source check id is a check in the shipped registry', () => {
    const shipped = new Set(loadRegistry().checks.map((check) => check.id));
    expect([...SOURCE_CHECKS].filter((id) => !shipped.has(id))).toEqual([]);
  });

  test('api-catalog is not a source check: its anchors come from the catalog discovery already read', () => {
    expect(SOURCE_CHECKS.has('api-catalog')).toBe(false);
  });
});
