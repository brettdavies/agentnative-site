// Web-audit fix-skill pages + agent-skills directory tests (plan-003
// U10/U11, R11): one generated content page per check at
// /web-audit/skill/<id> (+ .md twin), and the .well-known index as a
// directory of pointers whose urls resolve to emitted artifacts.

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { buildAgentSkillsIndex, buildAgentSkillsIndexMd } from '../src/build/11a-discovery-emit.mjs';
import { normalizeWebAuditRegistry } from '../src/build/13-web-audit-registry.mjs';
import { buildSkillMarkdown, emitWebAuditSkillPages } from '../src/build/15-web-audit-skills.mjs';

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
    category: 'mcp-api',
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
    { 'mcp-api': 'MCP & API' },
    'https://anc.dev',
  );

  test('carries Goal, Fix, Resources, the copy-paste prompt, and the Verify tail', () => {
    expect(md).toContain('## Goal');
    expect(md).toContain('## Fix');
    expect(md).toContain('## Resources');
    expect(md).toContain('- [OpenAPI 3.1](https://spec.openapis.org/oas/latest.html)');
    expect(md).toContain('## Copy-paste prompt');
    expect(md).toContain('Skill: https://anc.dev/web-audit/skill/openapi');
    expect(md).toContain('Docs: https://spec.openapis.org/oas/latest.html');
    expect(md).toContain('## Verify');
    expect(md).toContain('MCP & API, MUST');
  });

  test('the prompt Fix line is the fix collapsed to one line', () => {
    expect(md).toContain('Fix: Publish an OpenAPI 3.1 description at /openapi.json.');
  });
});

describe('emitWebAuditSkillPages', () => {
  test('emits an HTML page and a markdown twin for every registry check', async () => {
    const { distDir, pages } = await emitToTmp();
    const raw = await readFile(REGISTRY_PATH, 'utf8');
    const registry = normalizeWebAuditRegistry(yaml.load(raw));
    expect(pages.length).toBe(registry.checks.length);
    const emitted = await readdir(join(distDir, 'web-audit', 'skill'));
    expect(emitted.length).toBe(registry.checks.length * 2);
    for (const check of registry.checks) {
      expect(emitted).toContain(`${check.id}.html`);
      expect(emitted).toContain(`${check.id}.md`);
    }
    // The first emit in this file pays module cold-start plus a full-registry
    // disk write, which exceeds bun's default 5s per-test budget on slower CI
    // runners under parallel load; warm sibling emits finish well under 1s.
  }, 30_000);

  test('a representative page serves HTML with the skill body and the twin serves markdown', async () => {
    const { distDir } = await emitToTmp();
    const html = await readFile(join(distDir, 'web-audit', 'skill', 'openapi.html'), 'utf8');
    expect(html).toContain('<h1');
    expect(html).toContain('Copy-paste prompt');
    const md = await readFile(join(distDir, 'web-audit', 'skill', 'openapi.md'), 'utf8');
    expect(md.startsWith('# Fix: ')).toBe(true);
  });

  test('skill HTML carries the prompt in a hidden data attribute and renders no fenced prompt', async () => {
    const { distDir } = await emitToTmp();
    const html = await readFile(join(distDir, 'web-audit', 'skill', 'openapi.html'), 'utf8');
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
    const md = await readFile(join(distDir, 'web-audit', 'skill', 'openapi.md'), 'utf8');
    expect(md).toContain('## Copy-paste prompt');
    expect(md).toContain('```text');
    expect(md).toContain("Issue: <the audit's finding for this check>");
  });

  test('every returned entry url maps to an emitted markdown artifact whose digest matches', async () => {
    const { distDir, pages } = await emitToTmp();
    for (const page of pages) {
      expect(page.url).toBe(`https://anc.dev/web-audit/skill/${page.id}.md`);
      const artifact = await readFile(join(distDir, 'web-audit', 'skill', `${page.id}.md`));
      const digest = new Bun.CryptoHasher('sha256').update(artifact).digest('hex');
      expect(digest).toBe(page.digest);
    }
  });
});

describe('agent-skills directory of pointers (U11)', () => {
  const webSkills = [
    {
      id: 'openapi',
      title: 't',
      description: 'Fix the "openapi" web-audit check.',
      url: 'https://anc.dev/web-audit/skill/openapi.md',
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
      url: 'https://anc.dev/web-audit/skill/openapi.md',
      digest: 'sha256:abc',
    });
  });

  test('index.md is a human-readable twin listing the same skills', () => {
    const md = buildAgentSkillsIndexMd('https://anc.dev', webSkills);
    expect(md).toContain('# Agent skills on anc.dev');
    expect(md).toContain('[web-audit-fix-openapi](https://anc.dev/web-audit/skill/openapi.md)');
  });

  test('the built dist index lists every check with a resolvable target', async () => {
    const distIndexPath = join(REPO_ROOT, 'dist', '.well-known', 'agent-skills', 'index.json');
    const raw = await readFile(distIndexPath, 'utf8').catch(() => null);
    if (raw === null) return; // dist not built in this environment
    const parsed = JSON.parse(raw) as { skills: Array<{ name: string; url: string }> };
    const registry = normalizeWebAuditRegistry(yaml.load(await readFile(REGISTRY_PATH, 'utf8')));
    expect(parsed.skills.length).toBe(registry.checks.length + 1);
    for (const skill of parsed.skills) {
      if (!skill.name.startsWith('web-audit-fix-')) continue;
      const id = skill.name.slice('web-audit-fix-'.length);
      const artifact = await readFile(join(REPO_ROOT, 'dist', 'web-audit', 'skill', `${id}.md`), 'utf8');
      expect(artifact.length).toBeGreaterThan(0);
    }
  });
});
