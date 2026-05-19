// Unit tests for src/shared/scorecard-format.mjs — the Worker-safe primitives
// shared by build-time markdown rendering (scorecards-render.mjs) and the
// Worker's /score/live/<binary>.md route (summary-render.ts).
//
// The row formatter is the load-bearing primitive: every check-table row in
// both `dist/score/<tool>.md` and `/score/live/<binary>.md` flows through
// it. Pipe-escape behavior and principle-link shape live here.

import { describe, expect, test } from 'bun:test';
import {
  BONUS_GROUPS,
  escHtml,
  extractTopIssues,
  formatCheckRowMarkdown,
  formatCheckTableMarkdownLines,
  groupToPrincipleNum,
  PRINCIPLE_GROUPS,
  PRINCIPLE_NAMES,
} from '../src/shared/scorecard-format.mjs';

describe('escHtml', () => {
  test('escapes & < > " \'', () => {
    expect(escHtml(`<img src="x" onerror='alert(1)'>&`)).toBe(
      '&lt;img src=&quot;x&quot; onerror=&#39;alert(1)&#39;&gt;&amp;',
    );
  });
  test('passes through plain text', () => {
    expect(escHtml('ripgrep — fast search')).toBe('ripgrep — fast search');
  });
});

describe('PRINCIPLE_GROUPS + PRINCIPLE_NAMES', () => {
  test('covers P1..P7', () => {
    expect(PRINCIPLE_GROUPS).toEqual(['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7']);
    for (const g of PRINCIPLE_GROUPS) {
      expect(PRINCIPLE_NAMES[g]).toBeTruthy();
    }
  });
  test('BONUS_GROUPS is closed set', () => {
    expect(BONUS_GROUPS).toEqual(['CodeQuality', 'ProjectStructure']);
  });
});

describe('groupToPrincipleNum', () => {
  test('P1..P7 → 1..7', () => {
    expect(groupToPrincipleNum('P1')).toBe(1);
    expect(groupToPrincipleNum('P7')).toBe(7);
  });
  test('bonus groups → null', () => {
    expect(groupToPrincipleNum('CodeQuality')).toBeNull();
    expect(groupToPrincipleNum('ProjectStructure')).toBeNull();
  });
  test('garbage → null', () => {
    expect(groupToPrincipleNum('P')).toBeNull();
    expect(groupToPrincipleNum('p3')).toBeNull(); // lowercase rejected
    expect(groupToPrincipleNum('Pasta')).toBeNull();
  });
});

describe('extractTopIssues', () => {
  const SC = {
    results: [
      { status: 'pass', label: 'ok', group: 'P1', evidence: null },
      { status: 'warn', label: 'iffy', group: 'P2', evidence: 'something' },
      { status: 'fail', label: 'broken', group: 'P3', evidence: 'bad' },
      { status: 'fail', label: 'broken2', group: 'P4', evidence: 'bad2' },
    ],
  };
  test('sorts FAIL before WARN, drops pass', () => {
    const top = extractTopIssues(SC, 4);
    expect(top.map((i: { label: string }) => i.label)).toEqual(['broken', 'broken2', 'iffy']);
  });
  test('respects limit', () => {
    const top = extractTopIssues(SC, 2);
    expect(top.map((i: { label: string }) => i.label)).toEqual(['broken', 'broken2']);
  });
  test('handles null/undefined safely', () => {
    expect(extractTopIssues(null)).toEqual([]);
    expect(extractTopIssues(undefined)).toEqual([]);
    expect(extractTopIssues({})).toEqual([]);
    expect(extractTopIssues({ results: undefined })).toEqual([]);
  });
});

describe('formatCheckRowMarkdown', () => {
  test('emits canonical row shape with site-relative link', () => {
    const row = formatCheckRowMarkdown({
      status: 'fail',
      label: 'exits 0 on missing flag',
      group: 'P4',
      evidence: 'expected non-zero exit, got 0',
    });
    expect(row).toBe('| FAIL | exits 0 on missing flag | [P4](/p4) | expected non-zero exit, got 0 |');
  });
  test('absolute baseUrl produces absolute principle link', () => {
    const row = formatCheckRowMarkdown(
      { status: 'warn', label: 'noisy', group: 'P2', evidence: 'extra logging' },
      { baseUrl: 'https://anc.dev' },
    );
    expect(row).toBe('| WARN | noisy | [P2](https://anc.dev/p2) | extra logging |');
  });
  test('bonus groups stay plain text (no link)', () => {
    const row = formatCheckRowMarkdown({
      status: 'fail',
      label: 'low test coverage',
      group: 'CodeQuality',
      evidence: '40%',
    });
    expect(row).toBe('| FAIL | low test coverage | CodeQuality | 40% |');
  });
  test('escapes pipe characters in label + evidence to preserve table shape', () => {
    const row = formatCheckRowMarkdown({
      status: 'fail',
      label: 'pipe | trouble',
      group: 'P3',
      evidence: 'cmd | grep foo | head -1',
    });
    expect(row).toContain('pipe \\| trouble');
    expect(row).toContain('cmd \\| grep foo \\| head -1');
    // The row still has exactly 5 unescaped pipes (the table delimiters).
    const unescapedPipes = row.match(/(?<!\\)\|/g)?.length ?? 0;
    expect(unescapedPipes).toBe(5);
  });
  test('handles null evidence', () => {
    const row = formatCheckRowMarkdown({
      status: 'pass',
      label: 'ok',
      group: 'P1',
      evidence: null,
    });
    expect(row).toBe('| PASS | ok | [P1](/p1) |  |');
  });
});

describe('formatCheckTableMarkdownLines', () => {
  test('emits header + delimiter + rows', () => {
    const lines = formatCheckTableMarkdownLines([
      { status: 'fail', label: 'a', group: 'P1', evidence: 'x' },
      { status: 'warn', label: 'b', group: 'P2', evidence: null },
    ]);
    expect(lines).toEqual([
      '| Status | Check | Principle | Evidence |',
      '|--------|-------|-----------|----------|',
      '| FAIL | a | [P1](/p1) | x |',
      '| WARN | b | [P2](/p2) |  |',
    ]);
  });
  test('returns [] for empty input (caller decides fallback copy)', () => {
    expect(formatCheckTableMarkdownLines([])).toEqual([]);
  });
});
