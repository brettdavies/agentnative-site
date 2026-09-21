// Web-audit fix-skill pages + agent-skills directory tests (plan-003
// U10/U11, R11): one generated content page per check at
// /fix/<id> (+ .md twin), and the .well-known index as a
// directory of pointers whose urls resolve to emitted artifacts.

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import { buildAgentSkillsIndex, buildAgentSkillsIndexMd } from '../src/build/11a-discovery-emit.mjs';
import { normalizeWebAuditRegistry } from '../src/build/13-web-audit-registry.mjs';
import {
  buildFixIndexMarkdown,
  buildSkillMarkdown,
  emitWebAuditSkillPages,
} from '../src/build/15-web-audit-skills.mjs';
import { assembleRemediation } from '../src/worker/audit-web/remediation';

const REPO_ROOT = new URL('..', import.meta.url).pathname;
const REGISTRY_PATH = join(REPO_ROOT, 'src', 'data', 'web-audit', 'registry.yaml');
const REMEDIATION_PATH = join(REPO_ROOT, 'src', 'data', 'web-audit', 'remediation.yaml');

const tmpDirs: string[] = [];
afterAll(async () => {
  for (const dir of tmpDirs) await rm(dir, { recursive: true, force: true });
});

async function emitToTmp() {
  const distDir = await mkdtemp(join(tmpdir(), 'web-audit-skills-'));
  tmpDirs.push(distDir);
  const { pages } = await emitWebAuditSkillPages({
    distDir,
    registryPath: REGISTRY_PATH,
    remediationPath: REMEDIATION_PATH,
    themeInit: '',
    baseUrl: 'https://anc.dev',
  });
  return { distDir, pages };
}

describe('buildSkillMarkdown', () => {
  const check = {
    id: 'openapi',
    title: 'An OpenAPI description is published',
    category: 'api',
    keyword: 'must',
    hint: 'Publish an OpenAPI 3.1 description.',
  };
  const md = buildSkillMarkdown(
    check,
    {
      title: 'An OpenAPI description is published',
      goal: 'Publish an OpenAPI description so non-MCP agents can call your API',
      fix: 'Publish an OpenAPI 3.1 description\nat /openapi.json.',
      resources: [{ label: 'OpenAPI 3.1', url: 'https://spec.openapis.org/oas/latest.html' }],
    },
    { api: 'API' },
    'https://anc.dev',
  );

  test('carries Goal, Fix, Resources, the copy-paste prompt, and the Verify tail', () => {
    expect(md).toContain('## Goal');
    expect(md).toContain('## Fix');
    expect(md).toContain('## Resources');
    expect(md).toContain('- [OpenAPI 3.1](https://spec.openapis.org/oas/latest.html)');
    expect(md).toContain('## Copy-paste prompt');
    expect(md).toContain('Skill: https://anc.dev/fix/openapi');
    expect(md).toContain('Docs: https://spec.openapis.org/oas/latest.html');
    expect(md).toContain('## Verify');
    expect(md).toContain('API, MUST');
  });

  test('the prompt Fix line is the fix collapsed to one line', () => {
    expect(md).toContain('Fix: Publish an OpenAPI 3.1 description at /openapi.json.');
  });
});

describe('emitWebAuditSkillPages', () => {
  test('emits an HTML page and a markdown twin for every registry check', async () => {
    const { distDir, pages } = await emitToTmp();
    const raw = await readFile(REGISTRY_PATH, 'utf8');
    const registry = normalizeWebAuditRegistry(yaml.load(raw) as object);
    const checks = registry.checks as Array<{ id: string }>;
    expect(pages.length).toBe(checks.length);
    const emitted = await readdir(join(distDir, 'fix'));
    expect(emitted.length).toBe(checks.length * 2);
    for (const check of checks) {
      expect(emitted).toContain(`${check.id}.html`);
      expect(emitted).toContain(`${check.id}.md`);
    }
    // The first emit in this file pays module cold-start plus a full-registry
    // disk write, which exceeds bun's default 5s per-test budget on slower CI
    // runners under parallel load; warm sibling emits finish well under 1s.
  }, 30_000);

  test('a representative page serves HTML with the skill body and the twin serves markdown', async () => {
    const { distDir } = await emitToTmp();
    const html = await readFile(join(distDir, 'fix', 'openapi.html'), 'utf8');
    expect(html).toContain('<h1');
    expect(html).toContain('Copy-paste prompt');
    const md = await readFile(join(distDir, 'fix', 'openapi.md'), 'utf8');
    expect(md.startsWith('# Fix: ')).toBe(true);
  });

  test('skill HTML carries the prompt in a hidden data attribute and renders no fenced prompt', async () => {
    const { distDir } = await emitToTmp();
    const html = await readFile(join(distDir, 'fix', 'openapi.html'), 'utf8');
    // Goal/Fix prose still render as headings.
    expect(html).toContain('Goal');
    expect(html).toContain('Fix');
    // The prompt rides in the carrier, never as a fenced/pre block.
    expect(html).toContain('data-copy-text=');
    expect(html).not.toContain('<pre>');
    // The raw (unescaped) prompt Issue line is not present as visible text.
    expect(html).not.toContain("Issue: <the audit's finding for this check>");
  });

  test('skill .md keeps the Copy-paste prompt heading and fenced prompt', async () => {
    const { distDir } = await emitToTmp();
    const md = await readFile(join(distDir, 'fix', 'openapi.md'), 'utf8');
    expect(md).toContain('## Copy-paste prompt');
    expect(md).toContain('```text');
    // The Issue line is retired; the audit's own finding rides the delimited
    // evidence block the result page appends to this same prompt.
    expect(md).not.toContain('Issue:');
  });

  test('every returned entry url maps to an emitted markdown artifact whose digest matches', async () => {
    const { distDir, pages } = await emitToTmp();
    for (const page of pages) {
      expect(page.url).toBe(`https://anc.dev/fix/${page.id}.md`);
      const artifact = await readFile(join(distDir, 'fix', `${page.id}.md`));
      const digest = new Bun.CryptoHasher('sha256').update(artifact).digest('hex');
      expect(digest).toBe(page.digest);
    }
  });

  test('a copy left under the retired path does not survive the emit', async () => {
    // dist/ is not wiped between builds, so a page emitted before the move
    // would go on answering its old URL beside the new one, and nothing else
    // in the suite would notice: every other case reads a fresh temp dir.
    const distDir = await mkdtemp(join(tmpdir(), 'web-audit-skills-stale-'));
    tmpDirs.push(distDir);
    const stale = join(distDir, 'web-audit', 'skill');
    await mkdir(stale, { recursive: true });
    await writeFile(join(stale, 'openapi.md'), 'stale');
    await emitWebAuditSkillPages({
      distDir,
      registryPath: REGISTRY_PATH,
      remediationPath: REMEDIATION_PATH,
      themeInit: '',
      baseUrl: 'https://anc.dev',
    });
    expect(await readdir(stale).catch(() => null)).toBeNull();
  }, 30_000);
});

// The fix index. Every check page is generated, so before this page nothing
// on the site linked one and a crawler had no route in; these tests pin the
// two properties that make them reachable — a link per check, and the flat
// `fix.html` placement that lets `/fix` resolve beside the `/fix/` directory.
describe('the fix index', () => {
  type Check = { id: string; title: string; category: string; keyword: 'must' | 'should' | 'may' };
  type Registry = { category_order: string[]; categories: Record<string, string>; checks: Check[] };
  const registry = async () =>
    normalizeWebAuditRegistry(yaml.load(await readFile(REGISTRY_PATH, 'utf8')) as object) as Registry;

  test('links every check in the registry exactly once', async () => {
    const reg = await registry();
    const md = buildFixIndexMarkdown(reg);
    for (const check of reg.checks) {
      const occurrences = md.split(`](/fix/${check.id})`).length - 1;
      expect(`${check.id}: ${occurrences}`).toBe(`${check.id}: 1`);
    }
  });

  test('groups under every category, in category_order', async () => {
    const reg = await registry();
    const md = buildFixIndexMarkdown(reg);
    const headings = [...md.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    expect(headings).toEqual(reg.category_order.map((slug) => reg.categories[slug]));
  });

  test('names each check its registry title and keyword', async () => {
    const reg = await registry();
    const md = buildFixIndexMarkdown(reg);
    const check = reg.checks[0];
    const label = { must: 'MUST', should: 'SHOULD', may: 'MAY' }[check.keyword];
    expect(label).toBeDefined();
    expect(md).toContain(`[${check.title}](/fix/${check.id}) — ${label}`);
  });

  test('emits flat as fix.html + fix.md, not as a directory index', async () => {
    const { distDir } = await emitToTmp();
    const names = await readdir(distDir);
    expect(names).toContain('fix.html');
    expect(names).toContain('fix.md');
    // A directory index would shadow the flat page and break /fix.md.
    expect(await readdir(join(distDir, 'fix'))).not.toContain('index.html');
  });

  test('the twin absolutifies its check links so a fetched document resolves', async () => {
    const { distDir } = await emitToTmp();
    const md = await readFile(join(distDir, 'fix.md'), 'utf8');
    expect(md).toContain('](https://anc.dev/fix/');
    expect(md).toContain('url: https://anc.dev/fix');
  });

  test('the page keeps its check links site-relative', async () => {
    const { distDir } = await emitToTmp();
    const html = await readFile(join(distDir, 'fix.html'), 'utf8');
    expect(html).toContain('href="/fix/');
  });
});

describe('agent-skills directory of pointers (U11)', () => {
  const webSkills = [
    {
      id: 'openapi',
      title: 't',
      description: 'Fix the "openapi" web-audit check.',
      url: 'https://anc.dev/fix/openapi.md',
      digest: 'abc',
    },
  ];

  test('index.json lists the MCP skill plus one pointer per fix skill', () => {
    const parsed = JSON.parse(buildAgentSkillsIndex('https://anc.dev', 'deadbeef', webSkills));
    expect(parsed.skills.length).toBe(2);
    const entry = parsed.skills[1];
    expect(entry).toEqual({
      name: 'web-audit-fix-openapi',
      type: 'skill-md',
      description: 'Fix the "openapi" web-audit check.',
      url: 'https://anc.dev/fix/openapi.md',
      digest: 'sha256:abc',
    });
  });

  test('index.md is a human-readable twin listing the same skills', () => {
    const md = buildAgentSkillsIndexMd('https://anc.dev', webSkills);
    expect(md).toContain('# Agent skills on anc.dev');
    expect(md).toContain('[web-audit-fix-openapi](https://anc.dev/fix/openapi.md)');
  });

  test('the built dist index lists every check with a resolvable target', async () => {
    const distIndexPath = join(REPO_ROOT, 'dist', '.well-known', 'agent-skills', 'index.json');
    const raw = await readFile(distIndexPath, 'utf8').catch(() => null);
    if (raw === null) return; // dist not built in this environment
    const parsed = JSON.parse(raw) as { skills: Array<{ name: string; url: string }> };
    const registry = normalizeWebAuditRegistry(yaml.load(await readFile(REGISTRY_PATH, 'utf8')) as object);
    const checks = registry.checks as Array<{ id: string }>;
    expect(parsed.skills.length).toBe(checks.length + 1);
    for (const skill of parsed.skills) {
      if (!skill.name.startsWith('web-audit-fix-')) continue;
      const id = skill.name.slice('web-audit-fix-'.length);
      const artifact = await readFile(join(REPO_ROOT, 'dist', 'fix', `${id}.md`), 'utf8');
      expect(artifact.length).toBeGreaterThan(0);
    }
  });
});

// The fix-skill page and the audit result page are the same prompt reached two
// ways, but they are assembled by different code in different runtimes: this
// page at build time in 15-web-audit-skills.mjs, the result page at request
// time by assembleRemediation(). They drifted once already, when the delimited
// evidence block replaced the prompt's `Issue:` line and only one side moved.
describe('the skill-page prompt equals the assembled remediation prompt', () => {
  const ENTRY = {
    title: 'An OpenAPI description is published',
    goal: 'Publish an OpenAPI description so non-MCP agents can call your API',
    fix: 'Publish an OpenAPI 3.1 description at /openapi.json covering your REST\nsurface.',
    resources: [{ label: 'OpenAPI 3.1', url: 'https://spec.openapis.org/oas/latest.html' }],
  };
  const CHECK = {
    id: 'openapi',
    category: 'api',
    tier: 'required',
    keyword: 'must',
    principle: 'P2',
    site_types: ['all'],
    antecedent: 'none',
    weight: 5,
    title: 'An OpenAPI description is published',
    hint: 'h',
    handler: 'http',
    with: {},
  };

  test('the built prompt is what assembleRemediation produces without evidence', () => {
    const md = buildSkillMarkdown(CHECK, ENTRY, { api: 'API' }, 'https://anc.dev');
    const expected = assembleRemediation(ENTRY, { checkId: 'openapi', origin: 'https://anc.dev' }).prompt;
    expect(md).toContain(expected);
  });

  test('neither side reintroduces the retired Issue line', () => {
    const md = buildSkillMarkdown(CHECK, ENTRY, { api: 'API' }, 'https://anc.dev');
    expect(md).not.toContain('Issue:');
    expect(assembleRemediation(ENTRY, { checkId: 'openapi', origin: 'https://anc.dev' }).prompt).not.toContain(
      'Issue:',
    );
  });

  // A skill page has no run behind it, so it must not invent evidence.
  test('the skill page carries no evidence block', () => {
    const md = buildSkillMarkdown(CHECK, ENTRY, { api: 'API' }, 'https://anc.dev');
    expect(md).not.toContain('begin evidence');
  });
});
