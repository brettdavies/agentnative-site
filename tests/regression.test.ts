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

    // Contains ## Pages with check, install, and about sub-pages.
    expect(llms).toContain('## Pages');
    expect(llms).toMatch(/^- \[[^\]]+\]\([^)]*\/check\.md\)$/m);
    expect(llms).toMatch(/^- \[[^\]]+\]\([^)]*\/install\.md\)$/m);
    expect(llms).toMatch(/^- \[[^\]]+\]\([^)]*\/about\.md\)$/m);

    // Contains ## Scorecards with at least the leaderboard link.
    expect(llms).toContain('## Scorecards');
    const scorecardLinks = llms.match(/^- \[[^\]]+\]\([^)]*\/scorecards\.md\)$/gm) ?? [];
    expect(scorecardLinks.length).toBeGreaterThanOrEqual(1);
  });
});

describe('regression #3 — markdown twin reflects source with site-relative links absolutified', () => {
  test.each(
    Array.from({ length: 7 }, (_, i) => {
      const n = i + 1;
      return [n, `${LOCKED_SLUGS[i]}.md`] as const;
    }),
  )('dist/p%s.md == absolutifyMarkdownLinks(content/principles/%s)', async (n, sourceName) => {
    const { absolutifyMarkdownLinks } = await import('../src/build/util.mjs');
    const distContent = await readFile(join(DIST, `p${n}.md`), 'utf8');
    const sourceContent = await readFile(join(CONTENT, 'principles', sourceName), 'utf8');
    expect(distContent).toBe(absolutifyMarkdownLinks(sourceContent));
  });

  test('absolutification idempotency: re-applying the transform is a no-op', async () => {
    const { absolutifyMarkdownLinks } = await import('../src/build/util.mjs');
    const distContent = await readFile(join(DIST, 'p1.md'), 'utf8');
    expect(absolutifyMarkdownLinks(distContent)).toBe(distContent);
  });

  test('every dist/*.md page emits absolute https://anc.dev/ URLs for site-internal links', async () => {
    const { readdir } = await import('node:fs/promises');
    const files = (await readdir(DIST)).filter((f) => f.endsWith('.md'));
    for (const file of files) {
      const content = await readFile(join(DIST, file), 'utf8');
      // Markdown link target starting with `/` (and not `//`) is the bug
      // shape: an unresolved site-relative URL in an emitted twin. Image
      // links match too via the optional `!` prefix.
      const matches = content.match(/!?\]\(\s*\/[^)\s/]/g) ?? [];
      expect({ file, relativeMarkdownLinks: matches }).toEqual({ file, relativeMarkdownLinks: [] });
    }
  });
});

describe('regression #5 — /skill.json (skill-distribution canonical surface)', () => {
  test('dist/skill.json exists and parses', async () => {
    const raw = await readFile(join(DIST, 'skill.json'), 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed).toBeDefined();
  });

  test('dist/skill.json source.commit matches src/data/skill.json', async () => {
    const distRaw = await readFile(join(DIST, 'skill.json'), 'utf8');
    const sourceRaw = await readFile(join(REPO_ROOT, 'src', 'data', 'skill.json'), 'utf8');
    const dist = JSON.parse(distRaw);
    const source = JSON.parse(sourceRaw);
    expect(dist.source.commit).toBe(source.source.commit);
    // Pin-freshness invariant: verify.expected mirrors source.commit until
    // a v2 schema decouples them.
    expect(dist.verify.expected).toBe(dist.source.commit);
  });

  test('dist/skill.json source.commit is 40-char lowercase hex', async () => {
    const raw = await readFile(join(DIST, 'skill.json'), 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.source.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  test('dist/skill.json has every required key', async () => {
    const raw = await readFile(join(DIST, 'skill.json'), 'utf8');
    const parsed = JSON.parse(raw);
    for (const key of [
      'schema_version',
      'type',
      'name',
      'version',
      'description',
      'principles_url',
      'license',
      'source',
      'install',
      'verify',
      'update',
      'uninstall',
      'skill_page_html',
    ]) {
      expect(parsed).toHaveProperty(key);
    }
    expect(Object.keys(parsed.install).length).toBeGreaterThan(0);
  });

  test('dist/skill.json is byte-stable: keys sorted, two-space indent, trailing newline', async () => {
    const raw = await readFile(join(DIST, 'skill.json'), 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw).toContain('  "schema_version"');
    // Top-level keys come out in alphabetical order.
    const topLevelKeys = (raw.match(/^ {2}"([^"]+)":/gm) ?? []).map((l) => l.replace(/^\s*"([^"]+)":.*$/, '$1'));
    const sorted = [...topLevelKeys].sort();
    expect(topLevelKeys).toEqual(sorted);
  });

  test('dist/skill.html and dist/skill.md exist', async () => {
    const html = await readFile(join(DIST, 'skill.html'), 'utf8');
    const md = await readFile(join(DIST, 'skill.md'), 'utf8');
    expect(html).toContain('<h1');
    expect(md).toMatch(/^#\s+/);
  });

  test('every install.<host> command appears byte-for-byte in skill.md', async () => {
    const raw = await readFile(join(DIST, 'skill.json'), 'utf8');
    const parsed = JSON.parse(raw);
    const md = await readFile(join(DIST, 'skill.md'), 'utf8');
    for (const [host, command] of Object.entries(parsed.install) as [string, string][]) {
      expect({ host, match: md.includes(command) }).toEqual({ host, match: true });
    }
  });

  test('every install.<host> command survives Shiki tokenization in skill.html (text content)', async () => {
    // Shiki wraps each token in its own <span>, so the raw HTML never holds
    // the contiguous command. Strip tags and decode &#x2F; (the only entity
    // the rendered command produces) to recover the agent-readable text.
    const raw = await readFile(join(DIST, 'skill.json'), 'utf8');
    const parsed = JSON.parse(raw);
    const html = await readFile(join(DIST, 'skill.html'), 'utf8');
    const text = html.replace(/<[^>]+>/g, '').replace(/&#x2F;/g, '/');
    for (const [host, command] of Object.entries(parsed.install) as [string, string][]) {
      expect({ host, match: text.includes(command) }).toEqual({ host, match: true });
    }
  });

  test('skill.html highlights the canonical command in a code block', async () => {
    const html = await readFile(join(DIST, 'skill.html'), 'utf8');
    // Shiki wraps code blocks in <pre class="shiki ..."> with a <code> child.
    expect(html).toMatch(/<pre[^>]*class="[^"]*shiki/);
    expect(html).toContain('agentnative-skill.git');
  });

  test('sitemap.xml contains /skill', async () => {
    const sitemap = await readFile(join(DIST, 'sitemap.xml'), 'utf8');
    expect(sitemap).toContain('/skill</loc>');
  });

  test('sitemap.xml does NOT contain /skill.json (noindex)', async () => {
    const sitemap = await readFile(join(DIST, 'sitemap.xml'), 'utf8');
    expect(sitemap).not.toContain('/skill.json</loc>');
  });

  // 404 contract — `/install.json` was the v1 location. After the
  // 2026-04-28-003 split, the asset must NOT exist; Cloudflare's
  // not_found_handling: "404-page" returns 404 from asset absence.
  test('dist/install.json does NOT exist (404 contract via asset absence)', async () => {
    const path = join(DIST, 'install.json');
    await expect(readFile(path, 'utf8')).rejects.toThrow(/ENOENT/);
  });

  test('llms.txt contains /skill.md and /skill.json links under ## Skill', async () => {
    const llms = await readFile(join(DIST, 'llms.txt'), 'utf8');
    expect(llms).toContain('## Skill');
    expect(llms).toMatch(/\/skill\.md\)/);
    expect(llms).toMatch(/\/skill\.json\)/);
  });

  test('llms-full.txt contains the skill section', async () => {
    const full = await readFile(join(DIST, 'llms-full.txt'), 'utf8');
    expect(full).toContain('# Install agent-native-cli');
    expect(full).toContain('Source: https://anc.dev/skill');
    expect(full).toContain('Canonical-Markdown: https://anc.dev/skill.md');
  });
});

describe('regression #6 — /install (CLI install page) — HTML+MD only, no JSON', () => {
  test('dist/install.html and dist/install.md exist; dist/install.json does NOT', async () => {
    const html = await readFile(join(DIST, 'install.html'), 'utf8');
    const md = await readFile(join(DIST, 'install.md'), 'utf8');
    expect(html).toContain('<h1');
    expect(md).toMatch(/^#\s+Install agentnative/);
    await expect(readFile(join(DIST, 'install.json'), 'utf8')).rejects.toThrow(/ENOENT/);
  });

  test('install.html includes the brew + cargo install commands', async () => {
    const html = await readFile(join(DIST, 'install.html'), 'utf8');
    // Strip tags + decode &#x2F; to recover Shiki-tokenized command text.
    const text = html.replace(/<[^>]+>/g, '').replace(/&#x2F;/g, '/');
    expect(text).toContain('brew install brettdavies/tap/agentnative');
    expect(text).toContain('cargo install agentnative');
  });

  test('sitemap.xml contains /install (CLI page is human-indexable)', async () => {
    const sitemap = await readFile(join(DIST, 'sitemap.xml'), 'utf8');
    expect(sitemap).toContain('/install</loc>');
  });

  test('primary nav contains the Install link on every page', async () => {
    // Sample one principle page + the leaderboard page.
    for (const page of ['p3.html', 'scorecards.html', 'install.html']) {
      const html = await readFile(join(DIST, page), 'utf8');
      expect({ page, hasInstallNav: /<a href="\/install">Install<\/a>/.test(html) }).toEqual({
        page,
        hasInstallNav: true,
      });
    }
  });

  test('inline brew/cargo copy lives only in content/install.md (no source-tree duplicates)', async () => {
    // Build-time guard for the dedup goal of Unit 2. Render-stage HTML
    // duplicates would re-grow if a future edit re-inlines the commands.
    const repoRoot = join(import.meta.dir, '..');
    const { execFileSync } = await import('node:child_process');
    const matches = execFileSync(
      'grep',
      ['-rlE', 'brew install brettdavies/tap/agentnative|cargo install agentnative', 'src/', 'content/'],
      { cwd: repoRoot, encoding: 'utf8' },
    )
      .trim()
      .split('\n')
      .filter(Boolean);
    expect(matches).toEqual(['content/install.md']);
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
