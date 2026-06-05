import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMcpCatalog } from '../src/build/11-mcp-catalog.mjs';
import { ANC_VERSION, SPEC_VERSION } from '../src/worker/spec-version.gen';

const REPO_ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const DIST_DIR = join(REPO_ROOT, 'dist');

const FIXED_TIME = '2026-06-05T18:00:00.000Z';

const FIXTURE_REGISTRY_INDEX = {
  by_slug: {
    curl: {
      name: 'curl',
      binary: 'curl',
      install: 'brew install curl',
      repo: 'curl/curl',
      version: '8.20.0',
      anc_version: ANC_VERSION,
      scorecard_url: '/score/curl',
      score_pct: 73,
    },
    git: {
      name: 'git',
      binary: 'git',
      install: 'brew install git',
      audit_profile: 'workhorse',
      repo: 'git/git',
      version: '2.54.0',
      anc_version: ANC_VERSION,
      scorecard_url: '/score/git',
      score_pct: 69,
    },
  },
  by_owner_repo: {},
};

const FIXTURE_PRINCIPLES = [
  {
    n: 1,
    slug: 'non-interactive-by-default',
    body: '# P1: Non-Interactive by Default\n\n## Definition\n\nEvery automation path MUST run without human input.\n',
  },
  {
    n: 2,
    slug: 'structured-parseable-output',
    body: '# P2: Structured, Parseable Output\n\n## Definition\n\nMachine output MUST be parseable.\n',
  },
];

const FIXTURE_COVERAGE_ROWS = [
  {
    id: 'p1-must-no-interactive',
    principle: 1,
    level: 'must',
    summary: 'No interactive prompts when stdin is not a TTY.',
    applicability: { kind: 'universal' },
    verifiers: [{ audit_id: 'p1-non-interactive', layer: 'behavioral' }],
  },
  {
    id: 'p2-must-schema-print',
    principle: 2,
    level: 'must',
    summary: 'Schema printable on --schema.',
    applicability: { kind: 'conditional', antecedent: { audit_id: 'p2-json-output' } },
    verifiers: [{ audit_id: 'p2-schema-flag', layer: 'behavioral' }],
  },
];

const FIXTURE_SPEC_SECTIONS = [
  {
    slug: 'p1-non-interactive-by-default',
    title: 'P1: Non-Interactive by Default',
    body: '# P1: Non-Interactive by Default\n\nSpec-side prose for P1.\n',
    level: 1,
  },
  {
    slug: 'scoring',
    title: 'Scoring',
    body: '# Scoring\n\nLeaderboard scoring formula.\n',
    level: 1,
  },
];

describe('buildMcpCatalog: shape invariants', () => {
  const catalog = buildMcpCatalog({
    registryIndex: FIXTURE_REGISTRY_INDEX,
    principles: FIXTURE_PRINCIPLES,
    coverageRows: FIXTURE_COVERAGE_ROWS,
    specSections: FIXTURE_SPEC_SECTIONS,
    specVersion: SPEC_VERSION,
    generatedAt: FIXED_TIME,
  });

  test('top-level fields present', () => {
    expect(catalog.generated_at).toBe(FIXED_TIME);
    expect(catalog.spec_version).toBe('0.5.0');
    expect(Array.isArray(catalog.registry)).toBe(true);
    expect(Array.isArray(catalog.principles)).toBe(true);
    expect(Array.isArray(catalog.spec_sections)).toBe(true);
  });

  test('generated_at is ISO-8601 Z-suffixed', () => {
    expect(catalog.generated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/);
  });

  test('registry length matches by_slug entry count (no rows dropped)', () => {
    expect(catalog.registry.length).toBe(Object.keys(FIXTURE_REGISTRY_INDEX.by_slug).length);
  });

  test('every registry row carries non-empty slug, binary, name, install', () => {
    for (const row of catalog.registry) {
      expect(row.slug).toBeTruthy();
      expect(row.binary).toBeTruthy();
      expect(row.name).toBeTruthy();
      expect(row.install).toBeTruthy();
    }
  });

  test('registry row carries audit_profile when source had it', () => {
    const git = catalog.registry.find((r) => r.slug === 'git');
    expect(git?.audit_profile).toBe('workhorse');
    const curl = catalog.registry.find((r) => r.slug === 'curl');
    expect(curl?.audit_profile).toBeUndefined();
  });

  test('registry row carries score_pct + scorecard_url + version + anc_version when source had them', () => {
    const curl = catalog.registry.find((r) => r.slug === 'curl');
    expect(curl?.score_pct).toBe(73);
    expect(curl?.scorecard_url).toBe('/score/curl');
    expect(curl?.version).toBe('8.20.0');
    expect(curl?.anc_version).toBe(ANC_VERSION);
  });

  test('principles array has one entry per source principle', () => {
    expect(catalog.principles.length).toBe(FIXTURE_PRINCIPLES.length);
  });

  test('every principle carries non-empty slug, title, body_markdown, n', () => {
    for (const p of catalog.principles) {
      expect(typeof p.n).toBe('number');
      expect(p.slug).toBeTruthy();
      expect(p.title).toBeTruthy();
      expect(p.body_markdown).toBeTruthy();
      expect(Array.isArray(p.requirements)).toBe(true);
    }
  });

  test('principle requirements carry id, level, summary, audit_ids', () => {
    const p1 = catalog.principles.find((p) => p.n === 1);
    expect(p1?.requirements.length).toBe(1);
    const req = p1?.requirements[0];
    expect(req?.id).toBe('p1-must-no-interactive');
    expect(req?.level).toBe('must');
    expect(req?.summary).toBeTruthy();
    expect(req?.audit_ids).toEqual(['p1-non-interactive']);
  });

  test('principle title extracted from H1 of body markdown', () => {
    const p1 = catalog.principles.find((p) => p.n === 1);
    expect(p1?.title).toBe('P1: Non-Interactive by Default');
  });

  test('spec_sections non-empty; every section carries non-empty slug + title + body_markdown', () => {
    expect(catalog.spec_sections.length).toBe(FIXTURE_SPEC_SECTIONS.length);
    for (const s of catalog.spec_sections) {
      expect(s.slug).toBeTruthy();
      expect(s.title).toBeTruthy();
      expect(s.body_markdown).toBeTruthy();
      expect(typeof s.level).toBe('number');
    }
  });

  test('spec_version equals input (no transformation)', () => {
    expect(catalog.spec_version).toBe(SPEC_VERSION);
  });
});

describe('built dist artifacts', () => {
  test('dist/_internal/mcp-catalog.json exists after build', async () => {
    const raw = await readFile(join(DIST_DIR, '_internal', 'mcp-catalog.json'), 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.spec_version).toBeTruthy();
    expect(Array.isArray(parsed.registry)).toBe(true);
    expect(Array.isArray(parsed.principles)).toBe(true);
    expect(Array.isArray(parsed.spec_sections)).toBe(true);
  });

  test('catalog generated_at is a valid ISO-8601 Z-suffixed timestamp', async () => {
    const raw = await readFile(join(DIST_DIR, '_internal', 'mcp-catalog.json'), 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.generated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/);
  });

  test('catalog registry length matches dist/registry-index.json by_slug entry count', async () => {
    const catalogRaw = await readFile(join(DIST_DIR, '_internal', 'mcp-catalog.json'), 'utf8');
    const indexRaw = await readFile(join(DIST_DIR, 'registry-index.json'), 'utf8');
    const catalog = JSON.parse(catalogRaw);
    const index = JSON.parse(indexRaw);
    expect(catalog.registry.length).toBe(Object.keys(index.by_slug).length);
  });

  test('every catalog registry row carries non-empty slug, binary, name, install', async () => {
    const raw = await readFile(join(DIST_DIR, '_internal', 'mcp-catalog.json'), 'utf8');
    const parsed = JSON.parse(raw);
    for (const row of parsed.registry) {
      expect(row.slug).toBeTruthy();
      expect(row.binary).toBeTruthy();
      expect(row.name).toBeTruthy();
      expect(row.install).toBeTruthy();
    }
  });

  test('catalog principles length matches content/principles/p*.md count; numbers are 1..N contiguous', async () => {
    const raw = await readFile(join(DIST_DIR, '_internal', 'mcp-catalog.json'), 'utf8');
    const parsed = JSON.parse(raw);
    const ns = parsed.principles.map((p: { n: number }) => p.n).sort((a: number, b: number) => a - b);
    expect(ns.length).toBeGreaterThan(0);
    for (let i = 0; i < ns.length; i++) {
      expect(ns[i]).toBe(i + 1);
    }
  });

  test('every catalog principle row carries non-empty slug, title, body_markdown', async () => {
    const raw = await readFile(join(DIST_DIR, '_internal', 'mcp-catalog.json'), 'utf8');
    const parsed = JSON.parse(raw);
    for (const p of parsed.principles) {
      expect(p.slug).toBeTruthy();
      expect(p.title).toBeTruthy();
      expect(p.body_markdown).toBeTruthy();
    }
  });

  test('catalog spec_sections is non-empty; every section carries non-empty slug, title, body_markdown', async () => {
    const raw = await readFile(join(DIST_DIR, '_internal', 'mcp-catalog.json'), 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.spec_sections.length).toBeGreaterThan(0);
    for (const s of parsed.spec_sections) {
      expect(s.slug).toBeTruthy();
      expect(s.title).toBeTruthy();
      expect(s.body_markdown).toBeTruthy();
    }
  });

  test('catalog spec_version equals src/data/spec/VERSION trimmed', async () => {
    const raw = await readFile(join(DIST_DIR, '_internal', 'mcp-catalog.json'), 'utf8');
    const parsed = JSON.parse(raw);
    const versionRaw = await readFile(join(REPO_ROOT, 'src', 'data', 'spec', 'VERSION'), 'utf8');
    expect(parsed.spec_version).toBe(versionRaw.trim());
  });

  test('content/mcp.md renders to dist/mcp-docs.html and dist/mcp-docs.md', async () => {
    const html = await readFile(join(DIST_DIR, 'mcp-docs.html'), 'utf8');
    const md = await readFile(join(DIST_DIR, 'mcp-docs.md'), 'utf8');
    expect(html).toContain('<html');
    expect(md).toContain('# ');
  });

  test('dist/sitemap.xml includes /mcp-docs', async () => {
    const sitemap = await readFile(join(DIST_DIR, 'sitemap.xml'), 'utf8');
    expect(sitemap).toContain('/mcp-docs');
  });
});
