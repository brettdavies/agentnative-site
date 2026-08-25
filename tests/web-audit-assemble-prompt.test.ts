import { describe, expect, test } from 'bun:test';
import { carriersFromElements, selectAssemblePrompts } from '../src/client/assemble-prompt';

const MUST_A = { keyword: 'must', status: 'absent', prompt: 'fix must a' };
const MUST_B = { keyword: 'must', status: 'broken', prompt: 'fix must b' };
const SHOULD = { keyword: 'should', status: 'absent', prompt: 'fix should' };
const MAY = { keyword: 'may', status: 'broken', prompt: 'fix may' };
const PASS = { keyword: 'must', status: 'pass', prompt: 'should never copy' };
const NA = { keyword: 'must', status: 'n_a', prompt: 'also never' };

describe('selectAssemblePrompts', () => {
  const rows = [MUST_A, SHOULD, PASS, NA, MUST_B, MAY];

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

  test('pass and n_a rows are never included', () => {
    expect(selectAssemblePrompts([PASS, NA], { includeShould: true, includeMay: true })).toBe('');
  });
});

describe('carriersFromElements', () => {
  test('reads keyword, status, and prompt in node order', () => {
    const el = (attrs: Record<string, string>): Element =>
      ({ getAttribute: (name: string) => attrs[name] ?? null }) as unknown as Element;
    expect(
      carriersFromElements([
        el({ 'data-copy-text': 'p1', 'data-keyword': 'must', 'data-status': 'absent' }),
        el({ 'data-copy-text': 'p2', 'data-keyword': 'should', 'data-status': 'broken' }),
      ]),
    ).toEqual([
      { keyword: 'must', status: 'absent', prompt: 'p1' },
      { keyword: 'should', status: 'broken', prompt: 'p2' },
    ]);
  });
});
