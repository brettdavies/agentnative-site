import { describe, expect, test } from 'bun:test';
import { findingRowsFromElements, selectAssemblePrompts } from '../src/client/assemble-prompt';
import type { FindingRow } from '../src/shared/web-audit-findings';

let order = 0;
function row(over: Partial<FindingRow>): FindingRow {
  order += 1;
  return {
    id: `check-${order}`,
    keyword: 'must',
    tier: 'required',
    status: 'absent',
    unprobed: false,
    prompt: 'fix it',
    order,
    ...over,
  };
}

const MUST_A = row({ keyword: 'must', status: 'absent', prompt: 'fix must a' });
const SHOULD = row({ keyword: 'should', status: 'absent', prompt: 'fix should' });
const PASS = row({ keyword: 'must', status: 'pass', prompt: 'should never copy' });
const NA = row({ keyword: 'must', status: 'n_a', prompt: 'also never' });
const MUST_B = row({ keyword: 'must', status: 'broken', prompt: 'fix must b' });
const MAY = row({ keyword: 'may', status: 'broken', prompt: 'fix may' });
const UNPROBED = row({ keyword: 'must', status: 'absent', unprobed: true, prompt: 'never observed' });

describe('selectAssemblePrompts', () => {
  const rows = [MUST_A, SHOULD, PASS, NA, MUST_B, MAY, UNPROBED];

  test('default assembly is MUST failures in display order', () => {
    expect(selectAssemblePrompts(rows, { includeShould: false, includeMay: false })).toBe('fix must a\n\nfix must b');
  });

  test('enabling SHOULD adds SHOULD failures; MAY likewise', () => {
    expect(selectAssemblePrompts(rows, { includeShould: true, includeMay: false })).toBe(
      'fix must a\n\nfix should\n\nfix must b',
    );
    expect(selectAssemblePrompts(rows, { includeShould: false, includeMay: true })).toBe(
      'fix must a\n\nfix must b\n\nfix may',
    );
  });

  test('no MUST failures stays empty and does not silently include SHOULD', () => {
    const onlyShould = [SHOULD, MAY, PASS];
    expect(selectAssemblePrompts(onlyShould, { includeShould: false, includeMay: false })).toBe('');
    expect(selectAssemblePrompts(onlyShould, { includeShould: true, includeMay: false })).toBe('fix should');
  });

  test('pass, n_a, and unprobed rows are never included', () => {
    expect(selectAssemblePrompts([PASS, NA, UNPROBED], { includeShould: true, includeMay: true })).toBe('');
  });
});

describe('findingRowsFromElements', () => {
  test('reads the canonical row root and its conditional prompt carrier', () => {
    const el = (attrs: Record<string, string>, child?: Record<string, string>): Element =>
      ({
        getAttribute: (name: string) => attrs[name] ?? null,
        querySelector: () => (child ? { getAttribute: (name: string) => child[name] ?? null } : null),
      }) as unknown as Element;
    expect(
      findingRowsFromElements([
        el(
          {
            'data-id': 'openapi',
            'data-keyword': 'must',
            'data-tier': 'required',
            'data-status': 'absent',
            'data-unprobed': 'false',
          },
          { 'data-copy-text': 'p1' },
        ),
        el({
          'data-id': 'llms-txt',
          'data-keyword': 'should',
          'data-tier': 'recommended',
          'data-status': 'pass',
          'data-unprobed': 'false',
        }),
        // A root without an id is not a finding.
        el({ 'data-keyword': 'may' }),
      ]),
    ).toEqual([
      { id: 'openapi', keyword: 'must', tier: 'required', status: 'absent', unprobed: false, prompt: 'p1', order: 0 },
      {
        id: 'llms-txt',
        keyword: 'should',
        tier: 'recommended',
        status: 'pass',
        unprobed: false,
        prompt: null,
        order: 1,
      },
    ]);
  });
});
