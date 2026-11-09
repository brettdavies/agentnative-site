// Unit tests for src/shared/scorecard-format.mjs — the Worker-safe primitives
// shared by build-time markdown rendering (scorecards-render.mjs) and the
// Worker's /score/live/<binary>.md route (summary-render.ts).
//
// The row formatter is the load-bearing primitive: every audit-table row in
// both `dist/score/<tool>.md` and `/score/live/<binary>.md` flows through
// it. Pipe-escape behavior and principle-link shape live here.

import { describe, expect, test } from 'bun:test';
import {
  BONUS_GROUPS,
  buildScorecardBody,
  buildScorecardMarkdown,
  escHtml,
  extractTopIssues,
  formatAuditRowMarkdown,
  formatAuditTableMarkdownLines,
  groupToPrincipleNum,
  PRINCIPLE_GROUPS,
  PRINCIPLE_NAMES,
  packagePageUrl,
  statusLabel,
} from '../src/shared/scorecard-format.mjs';
import { SPEC_VERSION } from '../src/worker/spec-version.gen';
import { parseHtml } from './helpers/html-elements';

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
  test('covers P1..P8', () => {
    expect(PRINCIPLE_GROUPS).toEqual(['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8']);
    for (const g of PRINCIPLE_GROUPS) {
      expect((PRINCIPLE_NAMES as Record<string, string>)[g]).toBeTruthy();
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
    type Scorecard = Parameters<typeof extractTopIssues>[0];
    expect(extractTopIssues(null as unknown as Scorecard)).toEqual([]);
    expect(extractTopIssues(undefined as unknown as Scorecard)).toEqual([]);
    expect(extractTopIssues({})).toEqual([]);
    expect(extractTopIssues({ results: undefined })).toEqual([]);
  });
});

describe('statusLabel (7-status taxonomy, schema 0.6)', () => {
  test('maps the five historic statuses to their uppercase label', () => {
    expect(statusLabel('pass')).toBe('PASS');
    expect(statusLabel('warn')).toBe('WARN');
    expect(statusLabel('fail')).toBe('FAIL');
    expect(statusLabel('skip')).toBe('SKIP');
    expect(statusLabel('error')).toBe('ERROR');
  });
  test('maps the two new statuses to punctuated labels a bare uppercase cannot produce', () => {
    expect(statusLabel('opt_out')).toBe('OPT-OUT');
    expect(statusLabel('n_a')).toBe('N/A');
  });
  test('unknown status falls back to uppercase so a future CLI status still renders', () => {
    expect(statusLabel('quarantined')).toBe('QUARANTINED');
  });
});

describe('formatAuditRowMarkdown', () => {
  test('emits canonical row shape with site-relative link', () => {
    const row = formatAuditRowMarkdown({
      status: 'fail',
      label: 'exits 0 on missing flag',
      group: 'P4',
      evidence: 'expected non-zero exit, got 0',
    });
    expect(row).toBe('| FAIL | exits 0 on missing flag | [P4](/p4) | expected non-zero exit, got 0 |');
  });
  test('absolute baseUrl produces absolute principle link', () => {
    const row = formatAuditRowMarkdown(
      { status: 'warn', label: 'noisy', group: 'P2', evidence: 'extra logging' },
      { baseUrl: 'https://anc.dev' },
    );
    expect(row).toBe('| WARN | noisy | [P2](https://anc.dev/p2) | extra logging |');
  });
  test('bonus groups stay plain text (no link)', () => {
    const row = formatAuditRowMarkdown({
      status: 'fail',
      label: 'low test coverage',
      group: 'CodeQuality',
      evidence: '40%',
    });
    expect(row).toBe('| FAIL | low test coverage | CodeQuality | 40% |');
  });
  test('escapes pipe characters in label + evidence to preserve table shape', () => {
    const row = formatAuditRowMarkdown({
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
    const row = formatAuditRowMarkdown({
      status: 'pass',
      label: 'ok',
      group: 'P1',
      evidence: null,
    });
    expect(row).toBe('| PASS | ok | [P1](/p1) |  |');
  });
  test('renders 0.6 opt_out / n_a statuses with their display labels', () => {
    const optOut = formatAuditRowMarkdown({
      status: 'opt_out',
      label: 'Structured output support',
      group: 'P2',
      evidence: 'no --output flag detected',
    });
    expect(optOut).toBe('| OPT-OUT | Structured output support | [P2](/p2) | no --output flag detected |');
    const na = formatAuditRowMarkdown({
      status: 'n_a',
      label: 'JSON Schema when --output json is supported',
      group: 'P2',
      evidence: 'antecedent unmet',
    });
    expect(na).toBe('| N/A | JSON Schema when --output json is supported | [P2](/p2) | antecedent unmet |');
  });
});

describe('formatAuditTableMarkdownLines', () => {
  test('emits header + delimiter + rows', () => {
    const lines = formatAuditTableMarkdownLines([
      { status: 'fail', label: 'a', group: 'P1', evidence: 'x' },
      { status: 'warn', label: 'b', group: 'P2', evidence: null },
    ]);
    expect(lines).toEqual([
      '| Status | Audit | Principle | Evidence |',
      '|--------|-------|-----------|----------|',
      '| FAIL | a | [P1](/p1) | x |',
      '| WARN | b | [P2](/p2) |  |',
    ]);
  });
  test('returns [] for empty input (caller decides fallback copy)', () => {
    expect(formatAuditTableMarkdownLines([])).toEqual([]);
  });
});

describe('buildScorecardBody escapes the audit profile in the reproduce command', () => {
  test('a profile carrying markup renders escaped', () => {
    const html = buildScorecardBody(
      { name: 'tool', binary: 'tool' },
      {
        spec_version: SPEC_VERSION,
        audit_profile: 'x"><img src=x onerror=1>',
        badge: { score_pct: 10, eligible: false },
        results: [],
      },
    );
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('--audit-profile x&quot;&gt;&lt;img');
  });
});

describe('buildScorecardBody sends the audited tool the scorecard URL', () => {
  test("the tool's homepage link carries the no-referrer-when-downgrade policy", async () => {
    const html = buildScorecardBody(
      { name: 'curl', binary: 'curl', url: 'https://curl.se' },
      { spec_version: SPEC_VERSION, badge: { score_pct: 10, eligible: false }, results: [] },
    );
    const link = (await parseHtml(html)).querySelector('a[href="https://curl.se"]');
    expect(link).not.toBeNull();
    expect(link?.getAttribute('referrerpolicy')).toBe('no-referrer-when-downgrade');
  });
});

describe('buildScorecardBody escapes every scorecard field it renders', () => {
  const MARKUP = '"><img src=x onerror=1>';
  const render = (fields: Record<string, unknown>) =>
    buildScorecardBody(
      { name: 'tool', binary: 'tool' },
      { spec_version: SPEC_VERSION, badge: { score_pct: 10, eligible: false }, results: [], ...fields },
    );
  const coverage = (band: 'must' | 'should', count: 'verified' | 'total') => ({
    coverage_summary: { [band]: { verified: 1, total: 2, [count]: MARKUP } },
  });
  const statusRow = { id: 'a', group: 'P1', status: MARKUP, label: 'label', evidence: null };

  test.each([
    ['badge.score_pct on an eligible card', { badge: { score_pct: MARKUP, eligible: true, embed_markdown: 'md' } }],
    ['badge.score_pct below the floor', { badge: { score_pct: MARKUP, eligible: false } }],
    ['results[].status', { results: [statusRow] }],
    ['coverage_summary.must.verified', coverage('must', 'verified')],
    ['coverage_summary.must.total', coverage('must', 'total')],
    ['coverage_summary.should.verified', coverage('should', 'verified')],
    ['coverage_summary.should.total', coverage('should', 'total')],
  ])('%s', (_field, fields) => {
    const html = render(fields);
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x');
  });

  test('valid numbers render unchanged', () => {
    const html = render({
      badge: { score_pct: 74, eligible: true, embed_markdown: 'md' },
      coverage_summary: { must: { verified: 3, total: 4 }, should: { verified: 5, total: 5 } },
    });
    expect(html).toContain('This score (74%)');
    expect(html).toContain('MUST 3 / 4');
    expect(html).toContain('SHOULD 5 / 5');
  });
});

describe('packagePageUrl', () => {
  const linked: Array<[string, string, string]> = [
    ['cargo-binstall', 'ouch', 'https://crates.io/crates/ouch'],
    ['cargo-binstall', 'cargo-deny', 'https://crates.io/crates/cargo-deny'],
    ['npm', 'cowsay', 'https://www.npmjs.com/package/cowsay'],
    ['npm', '@anthropic-ai/claude-code', 'https://www.npmjs.com/package/@anthropic-ai/claude-code'],
    ['bun', 'cowsay', 'https://www.npmjs.com/package/cowsay'],
    ['pip', 'httpie', 'https://pypi.org/project/httpie/'],
    ['uv', 'ruff', 'https://pypi.org/project/ruff/'],
    ['brew', 'ripgrep', 'https://formulae.brew.sh/formula/ripgrep'],
    ['brew', 'python@3.12', 'https://formulae.brew.sh/formula/python@3.12'],
    ['go', 'github.com/charmbracelet/glow', 'https://pkg.go.dev/github.com/charmbracelet/glow'],
    ['go', 'golang.org/x/tools/cmd/goimports', 'https://pkg.go.dev/golang.org/x/tools/cmd/goimports'],
  ];
  for (const [pm, pkg, url] of linked) {
    test(`${pm} ${pkg} links ${url}`, () => {
      expect(packagePageUrl({ pm, package: pkg })).toBe(url);
    });
  }

  const unlinked: Array<[string, unknown, string]> = [
    ['direct', 'cowsay', 'a manager with no registry page'],
    ['git-clone', 'cowsay', 'a manager with no registry page'],
    ['gem', 'cowsay', 'an unknown manager'],
    ['__proto__', 'cowsay', 'an inherited key, not a manager'],
    ['constructor', 'cowsay', 'an inherited key, not a manager'],
    ['npm', 'cowsay@1.5.0', 'a version pin'],
    ['npm', '@scope/pkg@2', 'a version pin on a scoped name'],
    ['npm', '--global', 'a flag'],
    ['npm', '../etc', 'a path traversal'],
    ['pip', 'httpie==3.2', 'a version pin'],
    ['pip', 'httpie[extras]', 'extras'],
    ['uv', 'ruff>=0.5', 'a version range'],
    ['cargo-binstall', 'ouch --locked', 'a flag in the name'],
    ['cargo-binstall', '1pkg', 'a name that starts with a digit'],
    ['brew', '--cask', 'a flag'],
    ['brew', 'user/tap/formula', 'a tap-qualified name'],
    ['go', 'ouch', 'a module path with no host'],
    ['go', 'github.com/a/../b', 'a dot-dot segment'],
    ['go', 'github.com', 'a bare host'],
    ['npm', '', 'an empty name'],
    ['npm', 'a?b#c', 'URL metacharacters'],
    ['npm', 42, 'a non-string name'],
  ];
  for (const [pm, pkg, why] of unlinked) {
    test(`${pm} ${JSON.stringify(pkg)} links nothing: ${why}`, () => {
      expect(packagePageUrl({ pm, package: pkg })).toBeNull();
    });
  }

  test('a missing or non-object identity links nothing', () => {
    expect(packagePageUrl(undefined)).toBeNull();
    expect(packagePageUrl(null)).toBeNull();
    expect(packagePageUrl({ pm: 'npm' })).toBeNull();
    expect(packagePageUrl('npm i cowsay' as unknown as { pm: string })).toBeNull();
  });
});

describe('the meta line links the repo, then the homepage, then the package page', () => {
  const scorecard = { spec_version: SPEC_VERSION, badge: { score_pct: 10, eligible: false }, results: [] };
  const packageRef = { pm: 'npm', package: 'cowsay' };
  const PKG = 'https://www.npmjs.com/package/cowsay';
  const base = { name: 'cowsay', binary: 'cowsay', packageRef };

  test('a repo wins over a homepage and a package page', () => {
    const tool = { ...base, repo: 'o/r', url: 'https://cow.example' };
    const html = buildScorecardBody(tool, scorecard);
    expect(html).toContain('href="https://github.com/o/r"');
    expect(html).not.toContain(PKG);
    expect(buildScorecardMarkdown(tool, scorecard)).not.toContain(PKG);
  });

  test('a homepage wins over a package page', () => {
    const tool = { ...base, url: 'https://cow.example' };
    const html = buildScorecardBody(tool, scorecard);
    expect(html).toContain('href="https://cow.example"');
    expect(html).not.toContain(PKG);
    expect(buildScorecardMarkdown(tool, scorecard)).not.toContain(PKG);
  });

  test('with neither, the package page is linked in the page and the twin, without a referrer policy', async () => {
    const doc = await parseHtml(buildScorecardBody(base, scorecard));
    const link = doc.querySelector(`a[href="${PKG}"]`);
    expect(link?.textContent).toBe(PKG);
    expect(link?.getAttribute('referrerpolicy')).toBeNull();
    expect(buildScorecardMarkdown(base, scorecard)).toContain(`**Package:** [${PKG}](${PKG})`);
  });

  test('the package reference never reaches the Install detail row, which holds an install command', () => {
    const html = buildScorecardBody(base, scorecard);
    const md = buildScorecardMarkdown(base, scorecard);
    expect(html).not.toContain('[object Object]');
    expect(html).not.toContain('<dt>Install</dt>');
    expect(md).not.toContain('[object Object]');
    expect(md).not.toContain('**Install:**');
  });

  test('an identity that fails the name shape leaves the meta line out', () => {
    const tool = { name: 'cowsay', binary: 'cowsay', packageRef: { pm: 'npm', package: 'cowsay@1.5.0' } };
    expect(buildScorecardBody(tool, scorecard)).not.toContain('result-brief__meta');
    expect(buildScorecardMarkdown(tool, scorecard)).not.toContain('**Package:**');
  });
});
