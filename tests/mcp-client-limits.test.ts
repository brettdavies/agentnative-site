// Client limits on MCP server metadata: the records in
// src/worker/mcp/client-limits.ts, and a guard that reads the strings the
// server sends and fails when one breaks a recorded limit.

import { describe, expect, test } from 'bun:test';
import { compareVersions } from '../src/build/scorecards.mjs';
import {
  budgetLimits,
  CLIENT_LIMITS,
  type ClientLimit,
  criticalLimits,
  leadLimits,
  type MetadataSurface,
  measure,
} from '../src/worker/mcp/client-limits';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const ids = (limits: readonly ClientLimit[]): string[] => limits.map((limit) => limit.id);

describe('client limit records', () => {
  test('every record has a unique id, a source with a quote and a read date, and a url or description', () => {
    expect(new Set(ids(CLIENT_LIMITS)).size).toBe(CLIENT_LIMITS.length);
    for (const limit of CLIENT_LIMITS) {
      expect(limit.sources.length).toBeGreaterThan(0);
      for (const source of limit.sources) {
        expect(Boolean(source.url) || Boolean(source.described)).toBe(true);
        expect(source.quote.trim().length).toBeGreaterThan(0);
        expect(source.readOn).toMatch(ISO_DATE);
        expect(Number.isNaN(Date.parse(source.readOn))).toBe(false);
      }
    }
  });

  test('every record applies to at least one surface and carries a positive value', () => {
    for (const limit of CLIENT_LIMITS) {
      expect(limit.appliesTo.length).toBeGreaterThan(0);
      expect(limit.value).toBeGreaterThan(0);
    }
  });

  test('fromVersion sorts before untilVersion on every record that has both', () => {
    for (const limit of CLIENT_LIMITS) {
      if (limit.fromVersion !== null && limit.untilVersion !== null) {
        expect(compareVersions(limit.fromVersion, limit.untilVersion)).toBeLessThan(0);
      }
    }
  });

  test('a replaced limit keeps its record: the 2048 cut ends where the 4096 cut starts', () => {
    const replaced = CLIENT_LIMITS.find((limit) => limit.id === 'claude-code-upfront-2048');
    const current = CLIENT_LIMITS.find((limit) => limit.id === 'claude-code-upfront-4096');
    expect(replaced?.untilVersion).toBe(current?.fromVersion);
  });
});

describe('measure', () => {
  test('counts an em-dash as 1 character and 3 bytes', () => {
    const text = 'a—b';
    expect(measure(text, 'characters')).toBe(3);
    expect(measure(text, 'utf8-bytes')).toBe(5);
  });

  test('counts an astral character as 2 characters and 4 bytes', () => {
    const text = '\u{1F600}';
    expect(measure(text, 'characters')).toBe(2);
    expect(measure(text, 'utf8-bytes')).toBe(4);
  });

  test('counts ASCII as one of each', () => {
    expect(measure('abc', 'characters')).toBe(3);
    expect(measure('abc', 'utf8-bytes')).toBe(3);
  });
});

describe('limit selectors', () => {
  test('the instructions budget is the current cut and nothing that has ended or only warns', () => {
    const budget = ids(budgetLimits('server-instructions'));
    expect(budget).toContain('claude-code-upfront-4096');
    for (const excluded of ['claude-code-all-2048', 'claude-code-upfront-2048', 'tool-registry-check-2048']) {
      expect(budget).not.toContain(excluded);
    }
  });

  test('the instructions critical window is the ended cuts and the warning', () => {
    const critical = ids(criticalLimits('server-instructions'));
    for (const included of ['claude-code-all-2048', 'claude-code-upfront-2048', 'tool-registry-check-2048']) {
      expect(critical).toContain(included);
    }
    expect(critical).not.toContain('claude-code-upfront-4096');
  });

  test('the instructions lead is the ChatGPT and Codex request', () => {
    expect(ids(leadLimits('server-instructions'))).toContain('chatgpt-codex-lead-512');
  });

  test('a tool description is budgeted per surface: upfront at the current cut, tool search at its own', () => {
    expect(ids(budgetLimits('tool-description-upfront'))).toEqual(['claude-code-upfront-4096']);
    expect(ids(budgetLimits('tool-description-tool-search'))).toEqual(['claude-code-tool-search-16384']);
  });

  test('every surface has a budget and a critical window', () => {
    const surfaces: MetadataSurface[] = [
      'server-instructions',
      'tool-description-upfront',
      'tool-description-tool-search',
    ];
    for (const surface of surfaces) {
      expect(budgetLimits(surface).length).toBeGreaterThan(0);
      expect(criticalLimits(surface).length).toBeGreaterThan(0);
    }
  });

  test('no selector returns a record for a surface it does not apply to', () => {
    for (const limit of budgetLimits('tool-description-tool-search')) {
      expect(limit.appliesTo).toContain('tool-description-tool-search');
    }
    expect(leadLimits('tool-description-upfront')).toEqual([]);
  });
});
