import { describe, expect, test } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderMarkdown } from '../src/build/render.mjs';
import {
  computeLayerScore,
  computeLeaderboard,
  computePrincipleScore,
  computeScore,
  extractTopIssues,
  loadRegistry,
  loadScorecards,
} from '../src/build/scorecards.mjs';
import { escHtml, parseFilename, sortedGlob } from '../src/build/util.mjs';

describe('sortedGlob', () => {
  test('sorts principles by numeric prefix, not lexicographic', async () => {
    const dir = join(tmpdir(), `sortedGlob-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    try {
      for (const name of ['p10-tenth.md', 'p2-second.md', 'p1-first.md', 'p9-ninth.md', 'notes.md', 'p3-third.md']) {
        await writeFile(join(dir, name), '# stub\n');
      }
      const result = await sortedGlob(dir);
      const names = result.map((p) => p.slice(p.lastIndexOf('/') + 1));
      expect(names).toEqual(['p1-first.md', 'p2-second.md', 'p3-third.md', 'p9-ninth.md', 'p10-tenth.md']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('parseFilename', () => {
  test('extracts n and slug from bare filename', () => {
    expect(parseFilename('p3-progressive-help-discovery.md')).toEqual({
      n: 3,
      slug: 'progressive-help-discovery',
    });
  });

  test('extracts n and slug from absolute path', () => {
    expect(parseFilename('/some/abs/path/p7-bounded-high-signal-responses.md')).toEqual({
      n: 7,
      slug: 'bounded-high-signal-responses',
    });
  });

  test('throws on non-principle filename', () => {
    expect(() => parseFilename('notes.md')).toThrow();
  });

  test('throws on uppercase prefix', () => {
    expect(() => parseFilename('P1-foo.md')).toThrow();
  });
});

// RFC-keyword regex + plugin cases from docs/DESIGN.md §4.7 (A6/C2).
describe('rfc-keywords plugin', () => {
  async function render(md: string): Promise<string> {
    return renderMarkdown(md);
  }

  test('MUST becomes a single rfc-must strong', async () => {
    const html = await render('The agent MUST run.');
    expect(html).toContain('<strong class="rfc-must">MUST</strong>');
  });

  test('MUST NOT becomes a single rfc-must strong, not two', async () => {
    const html = await render('The agent MUST NOT prompt.');
    expect(html).toContain('<strong class="rfc-must">MUST NOT</strong>');
    expect(html).not.toContain('<strong class="rfc-must">MUST</strong> NOT');
    // Exactly one rfc-must span in this single-keyword sentence.
    const count = (html.match(/class="rfc-must"/g) ?? []).length;
    expect(count).toBe(1);
  });

  test('SHOULD NOT becomes a single rfc-should strong', async () => {
    const html = await render('The tool SHOULD NOT block on prompts.');
    expect(html).toContain('<strong class="rfc-should">SHOULD NOT</strong>');
  });

  test('MAY becomes rfc-may', async () => {
    const html = await render('Callers MAY pass --verbose.');
    expect(html).toContain('<strong class="rfc-may">MAY</strong>');
  });

  test('MUSTARD does not match (word boundary strict)', async () => {
    const html = await render('I like MUSTARD on my burger.');
    expect(html).not.toContain('class="rfc-must"');
    expect(html).toContain('MUSTARD');
  });

  test('lowercase must does not match', async () => {
    const html = await render('The agent must run.');
    expect(html).not.toContain('class="rfc-must"');
  });

  test('MUST inside inlineCode does not match', async () => {
    const html = await render('Use the `MUST` convention.');
    expect(html).not.toContain('class="rfc-must"');
    expect(html).toContain('MUST');
  });

  test('MUST inside fenced code block does not match', async () => {
    const html = await render('```\nMUST run\n```\n');
    expect(html).not.toContain('class="rfc-must"');
  });

  test('MUST inside link label does not match', async () => {
    const html = await render('[MUST see this](https://example.com)');
    expect(html).not.toContain('class="rfc-must"');
  });

  test('trailing comma after MUST still matches', async () => {
    const html = await render('The agent MUST, at minimum, support JSON.');
    expect(html).toContain('<strong class="rfc-must">MUST</strong>');
  });

  test('**MUST:** nested-strong annotates parent, no double strong', async () => {
    // **MUST:** — mdast `strong` with a single text child whose value is
    // `MUST:` (keyword + colon). The plugin should annotate the existing
    // strong rather than nesting a second one.
    const html = await render('**MUST:** this holds always.');
    // Should have a single <strong class="rfc-must"> element containing MUST:,
    // never nested.
    expect(html).not.toContain('<strong class="rfc-must"><strong>');
    expect(html).not.toContain('<strong><strong class="rfc-must">');
    // The annotation should appear (either via the nested-strong branch or
    // the split-children branch — accept both).
    expect(html).toContain('class="rfc-must"');
  });

  test('MUST inside a heading matches', async () => {
    const html = await render('## MUST behave correctly\n\nBody.');
    expect(html).toContain('class="rfc-must"');
  });
});

// -------------------------------------------------------------------
// escHtml
// -------------------------------------------------------------------

describe('escHtml', () => {
  test('escapes all HTML special characters', () => {
    expect(escHtml('<b>"Tom & Jerry\'s"</b>')).toBe('&lt;b&gt;&quot;Tom &amp; Jerry&#39;s&quot;&lt;/b&gt;');
  });

  test('passes through safe strings unchanged', () => {
    expect(escHtml('hello world')).toBe('hello world');
  });

  test('coerces non-strings', () => {
    expect(escHtml(42)).toBe('42');
  });
});

// -------------------------------------------------------------------
// Scorecards module
// -------------------------------------------------------------------

// Reusable scorecard fixture matching the anc check --output json schema.
function makeScorecard(overrides: Partial<{ results: any[]; summary: any }> = {}) {
  const results = overrides.results ?? [
    {
      id: 'p1-non-interactive',
      label: 'Non-interactive by default',
      group: 'P1',
      layer: 'behavioral',
      status: 'pass',
      evidence: null,
    },
    {
      id: 'p2-json-output',
      label: 'Structured output support',
      group: 'P2',
      layer: 'behavioral',
      status: 'fail',
      evidence: 'no --output flag',
    },
    {
      id: 'p3-help',
      label: 'Help flag produces useful output',
      group: 'P3',
      layer: 'behavioral',
      status: 'pass',
      evidence: null,
    },
    { id: 'p3-version', label: 'Version flag works', group: 'P3', layer: 'behavioral', status: 'pass', evidence: null },
    {
      id: 'p4-bad-args',
      label: 'Rejects invalid arguments',
      group: 'P4',
      layer: 'behavioral',
      status: 'pass',
      evidence: null,
    },
    {
      id: 'p6-sigpipe',
      label: 'Handles SIGPIPE gracefully',
      group: 'P6',
      layer: 'behavioral',
      status: 'pass',
      evidence: null,
    },
    {
      id: 'p6-no-color',
      label: 'Respects NO_COLOR',
      group: 'P6',
      layer: 'behavioral',
      status: 'warn',
      evidence: 'flag not detected',
    },
    { id: 'p7-quiet', label: 'Quiet mode available', group: 'P7', layer: 'behavioral', status: 'pass', evidence: null },
  ];
  const summary = overrides.summary ?? {
    total: results.length,
    pass: results.filter((r: any) => r.status === 'pass').length,
    warn: results.filter((r: any) => r.status === 'warn').length,
    fail: results.filter((r: any) => r.status === 'fail').length,
    skip: results.filter((r: any) => r.status === 'skip').length,
    error: results.filter((r: any) => r.status === 'error').length,
  };
  return { results, summary };
}

describe('loadRegistry', () => {
  test('parses valid YAML with all required fields', async () => {
    const dir = join(tmpdir(), `registry-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    const registryPath = join(dir, 'registry.yaml');
    await writeFile(
      registryPath,
      `tools:
  - name: gh
    repo: cli/cli
    binary: gh
    language: Go
    tier: workhorse
    creator: GitHub
    description: GitHub CLI
  - name: rg
    repo: BurntSushi/ripgrep
    binary: rg
    language: Rust
    tier: notable
    creator: Andrew Gallant
    description: Fast grep
`,
    );
    try {
      const tools = await loadRegistry(registryPath);
      expect(tools).toHaveLength(2);
      expect(tools[0].name).toBe('gh');
      expect(tools[1].tier).toBe('notable');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('throws on name with spaces or uppercase', async () => {
    const dir = join(tmpdir(), `registry-bad-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    const registryPath = join(dir, 'registry.yaml');
    await writeFile(
      registryPath,
      `tools:
  - name: Claude Code
    repo: anthropics/claude-code
    binary: claude
    language: TypeScript
    tier: agent
    creator: Anthropic
    description: AI coding tool
`,
    );
    try {
      await expect(loadRegistry(registryPath)).rejects.toThrow(/must match/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('throws on duplicate names', async () => {
    const dir = join(tmpdir(), `registry-dup-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    const registryPath = join(dir, 'registry.yaml');
    await writeFile(
      registryPath,
      `tools:
  - name: gh
    repo: cli/cli
    binary: gh
    language: Go
    tier: workhorse
    creator: GitHub
    description: GitHub CLI
  - name: gh
    repo: cli/cli
    binary: gh
    language: Go
    tier: workhorse
    creator: GitHub
    description: Duplicate
`,
    );
    try {
      await expect(loadRegistry(registryPath)).rejects.toThrow(/duplicate/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('loadScorecards', () => {
  test('reads JSON files and matches to registry entries', async () => {
    const dir = join(tmpdir(), `scorecards-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    const sc = makeScorecard();
    await writeFile(join(dir, 'gh.json'), JSON.stringify(sc));
    try {
      const registry = [
        {
          name: 'gh',
          repo: 'cli/cli',
          binary: 'gh',
          language: 'Go',
          tier: 'workhorse',
          creator: 'GitHub',
          description: 'GitHub CLI',
        },
        {
          name: 'rg',
          repo: 'BurntSushi/ripgrep',
          binary: 'rg',
          language: 'Rust',
          tier: 'notable',
          creator: 'AG',
          description: 'grep',
        },
      ];
      const result = await loadScorecards(dir, registry);
      expect(result).toHaveLength(2);
      expect(result[0].scorecard).not.toBeNull();
      expect(result[1].scorecard).toBeNull(); // rg has no JSON file
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('computeScore', () => {
  test('computes pass / (pass + warn + fail), excluding skip/error', () => {
    const sc = makeScorecard();
    const score = computeScore(sc);
    // 6 pass, 1 warn, 1 fail → 6/8 = 0.75
    expect(score).toBe(0.75);
  });

  test('returns 0 for null scorecard', () => {
    expect(computeScore(null)).toBe(0);
  });

  test('returns 0 when denominator is 0 (all skip)', () => {
    const sc = makeScorecard({
      results: [{ id: 'x', label: 'x', group: 'P1', layer: 'behavioral', status: 'skip', evidence: null }],
      summary: { total: 1, pass: 0, warn: 0, fail: 0, skip: 1, error: 0 },
    });
    expect(computeScore(sc)).toBe(0);
  });
});

describe('computePrincipleScore', () => {
  test('maps P1-P7 groups correctly, excludes CodeQuality/ProjectStructure', () => {
    const sc = makeScorecard();
    const ps = computePrincipleScore(sc);
    expect(ps.total).toBe(7);
    // P1=pass, P2=fail, P3=pass, P4=pass, P5=skip(no checks), P6=partial(has warn), P7=pass
    expect(ps.met).toBe(4); // P1, P3, P4, P7
    expect(ps.details.find((d: any) => d.group === 'P2')?.status).toBe('fail');
    expect(ps.details.find((d: any) => d.group === 'P6')?.status).toBe('partial');
  });

  test('returns 0/7 for null scorecard', () => {
    const ps = computePrincipleScore(null);
    expect(ps.met).toBe(0);
    expect(ps.total).toBe(7);
  });
});

describe('computeLayerScore', () => {
  test('separates behavioral+project from source checks', () => {
    const sc = makeScorecard();
    const ls = computeLayerScore(sc);
    expect(ls.primary).toBeGreaterThan(0);
    expect(ls.source).toBeNull(); // fixture has no source-layer checks
  });
});

describe('extractTopIssues', () => {
  test('returns FAIL checks before WARN checks, limited to N', () => {
    const sc = makeScorecard();
    const issues = extractTopIssues(sc, 3);
    expect(issues.length).toBeLessThanOrEqual(3);
    // First issue should be the fail (P2)
    expect(issues[0].status).toBe('fail');
    // Second should be the warn (P6)
    expect(issues[1].status).toBe('warn');
  });

  test('returns empty array for null scorecard', () => {
    expect(extractTopIssues(null)).toEqual([]);
  });
});

describe('computeLeaderboard', () => {
  test('sorts tools by descending pass rate, unscored at bottom', () => {
    const tools = [
      { tool: { name: 'unscored', tier: 'notable' }, scorecard: null },
      {
        tool: { name: 'low', tier: 'workhorse' },
        scorecard: makeScorecard({
          summary: { total: 4, pass: 1, warn: 1, fail: 2, skip: 0, error: 0 },
        }),
      },
      {
        tool: { name: 'high', tier: 'agent' },
        scorecard: makeScorecard({
          summary: { total: 4, pass: 4, warn: 0, fail: 0, skip: 0, error: 0 },
        }),
      },
    ];
    const lb = computeLeaderboard(tools as any);
    expect(lb[0].tool.name).toBe('high');
    expect(lb[0].rank).toBe(1);
    expect(lb[1].tool.name).toBe('low');
    expect(lb[2].tool.name).toBe('unscored');
    expect(lb[2].rank).toBe(3);
  });

  test('empty registry returns empty leaderboard', () => {
    expect(computeLeaderboard([])).toEqual([]);
  });
});
