// CRITICAL regression tests (ce-work prompt). These gate every PR —
// if any goes red, the site ships with a broken citation primitive.
//
//   1. Anchor-slug snapshot against docs/DESIGN.md §3.5's seven LOCKED slugs.
//      Renaming ANY of these breaks every inbound link, HN comment, blog
//      quote, or agent citation in perpetuity.
//
//   2. llms.txt shape — H1 + `>` summary + H2 "Principles" + 7 `.md`
//      bullets + H2 "Scorecards". Shape is the llmstxt.org contract for
//      agent discovery.
//
//   3. Markdown byte-equivalence: sha256(dist/p<n>.md) must equal
//      sha256(content/principles/p<n>-*.md). The `/p<n>.md` endpoint
//      promises the authored bytes, not a re-wrapped derivative.
//
//   4. Scorecard pages — leaderboard exists with a <table>, at least one
//      per-tool scorecard page exists, and sitemap includes scorecard paths.
//
// Run `bun run build` before these tests (bun test does not auto-build).

import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..');
const DIST = join(REPO_ROOT, 'dist');
const CONTENT = join(REPO_ROOT, 'content');

// docs/DESIGN.md §3.5 — locked anchor slugs. DO NOT edit this list casually.
// Renaming here must be simultaneous with a rename in docs/DESIGN.md + a 301
// redirect in the Worker per docs/DESIGN.md §3.5 "propagation protocol".
const LOCKED_SLUGS = [
  'p1-non-interactive-by-default',
  'p2-structured-parseable-output',
  'p3-progressive-help-discovery',
  'p4-fail-fast-actionable-errors',
  'p5-safe-retries-mutation-boundaries',
  'p6-composable-predictable-command-structure',
  'p7-bounded-high-signal-responses',
];

async function sha256OfFile(path: string): Promise<string> {
  const buf = await readFile(path);
  return createHash('sha256').update(buf).digest('hex');
}

describe('regression #1 — anchor slug snapshot (docs/DESIGN.md §3.5 locked list)', () => {
  test('homepage links to every principle page', async () => {
    const html = await readFile(join(DIST, 'index.html'), 'utf8');
    for (let n = 1; n <= 7; n++) {
      expect(html).toContain(`href="/p${n}"`);
    }
  });

  test('every locked slug appears exactly once as an id in its per-principle page', async () => {
    for (const slug of LOCKED_SLUGS) {
      const n = LOCKED_SLUGS.indexOf(slug) + 1;
      const html = await readFile(join(DIST, `p${n}.html`), 'utf8');
      const matches = html.match(new RegExp(`id="${slug}"`, 'g')) ?? [];
      expect({ n, slug, count: matches.length }).toEqual({ n, slug, count: 1 });
    }
  });

  test('no stray draft slugs in principle pages', async () => {
    for (let n = 1; n <= 7; n++) {
      const html = await readFile(join(DIST, `p${n}.html`), 'utf8');
      // Tier keywords in slug would indicate drift (§3.5 forbids this).
      expect(html).not.toMatch(/id="p\d+-(must|should|may)-/i);
      // Uppercase `P<n>-` in ids would fail browser anchor matching.
      expect(html).not.toMatch(/id="P\d+-/);
    }
  });
});

describe('regression #2 — llms.txt shape (llmstxt.org + A5)', () => {
  test('has H1, blockquote summary, ## Principles with 7 .md bullets, ## Pages, and ## Scorecards', async () => {
    const llms = await readFile(join(DIST, 'llms.txt'), 'utf8');
    const lines = llms.split('\n');

    // First non-empty line is `# <Title>`.
    const firstContent = lines.find((l) => l.trim() !== '') ?? '';
    expect(firstContent.startsWith('# ')).toBe(true);

    // Contains a `> ` blockquote summary line.
    expect(llms).toMatch(/^> /m);

    // Contains the literal `## Principles` H2.
    expect(llms).toContain('## Principles');

    // Contains exactly seven `- [...](.../p<n>.md)` bullets.
    const principleLinks = llms.match(/^- \[[^\]]+\]\([^)]*\/p\d+\.md\)$/gm) ?? [];
    expect(principleLinks.length).toBe(7);

    // Bullets are in p1..p7 order.
    const orderedNumbers = principleLinks.map((l) => l.match(/\/p(\d+)\.md/)?.[1]).map((s) => (s ? Number(s) : 0));
    expect(orderedNumbers).toEqual([1, 2, 3, 4, 5, 6, 7]);

    // Contains ## Pages with check and about sub-pages.
    expect(llms).toContain('## Pages');
    const pageLinks = llms.match(/^- \[[^\]]+\]\([^)]*\/(check|about)\.md\)$/gm) ?? [];
    expect(pageLinks.length).toBe(2);

    // Contains ## Scorecards with at least the leaderboard link.
    expect(llms).toContain('## Scorecards');
    const scorecardLinks = llms.match(/^- \[[^\]]+\]\([^)]*\/scorecards\.md\)$/gm) ?? [];
    expect(scorecardLinks.length).toBeGreaterThanOrEqual(1);
  });
});

describe('regression #3 — markdown byte-equivalence', () => {
  test.each(
    Array.from({ length: 7 }, (_, i) => {
      const n = i + 1;
      return [n, `${LOCKED_SLUGS[i]}.md`] as const;
    }),
  )('sha256(dist/p%s.md) == sha256(content/principles/%s)', async (n, sourceName) => {
    const distHash = await sha256OfFile(join(DIST, `p${n}.md`));
    const sourceHash = await sha256OfFile(join(CONTENT, 'principles', sourceName));
    expect(distHash).toBe(sourceHash);
  });
});

describe('regression #4 — scorecard pages', () => {
  test('dist/scorecards.html exists and contains a <table> element', async () => {
    const html = await readFile(join(DIST, 'scorecards.html'), 'utf8');
    expect(html).toContain('<table');
    expect(html).toContain('class="leaderboard-table"');
  });

  test('dist/scorecards.md exists and is a readable markdown table', async () => {
    const md = await readFile(join(DIST, 'scorecards.md'), 'utf8');
    expect(md).toContain('# ANC 100');
    expect(md).toContain('| # | Tool |');
  });

  test('at least one dist/score/*.html file exists', async () => {
    const { readdir } = await import('node:fs/promises');
    const files = await readdir(join(DIST, 'score'));
    const htmlFiles = files.filter((f) => f.endsWith('.html'));
    expect(htmlFiles.length).toBeGreaterThanOrEqual(1);
  });

  test('each per-tool HTML has a matching .md twin', async () => {
    const { readdir } = await import('node:fs/promises');
    const files = await readdir(join(DIST, 'score'));
    const htmlFiles = files.filter((f) => f.endsWith('.html'));
    for (const html of htmlFiles) {
      const md = html.replace('.html', '.md');
      expect(files).toContain(md);
    }
  });

  test('sitemap.xml contains /scorecards', async () => {
    const sitemap = await readFile(join(DIST, 'sitemap.xml'), 'utf8');
    expect(sitemap).toContain('/scorecards</loc>');
  });

  test('sitemap.xml contains at least one /score/<tool> path', async () => {
    const sitemap = await readFile(join(DIST, 'sitemap.xml'), 'utf8');
    expect(sitemap).toMatch(/\/score\/[a-z0-9-]+<\/loc>/);
  });
});
