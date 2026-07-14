// Per-check web-audit fix skills (plan-003 U10, R11/KTD-7). Emits one
// content page per registry check at dist/web-audit/skill/<id>.html plus
// its markdown twin, generated from the registry + remediation catalog
// (STAR: remediation.yaml is the single prose source, so the skill pages
// and the get_web_remediation tool can never drift apart).
//
// Served through the standard asset-first dispatch: /web-audit/skill/<id>
// resolves the HTML, the `.md` suffix or `Accept: text/markdown` resolves
// the twin, and an unknown check id 404s like any missing asset.

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { escHtml } from '../shared/scorecard-format.mjs';
import { normalizeWebAuditRegistry, normalizeWebRemediation } from './13-web-audit-registry.mjs';
import { renderMarkdown } from './render.mjs';
import { emitShell } from './shell.mjs';
import { absolutifyMarkdownLinks, resolveBaseUrl } from './util.mjs';

const KEYWORD_LABELS = { must: 'MUST', should: 'SHOULD', may: 'MAY' };

/** Collapse multi-line markdown to the single-line prompt form (mirrors
 * src/worker/audit-web/remediation.ts). */
function oneLine(text) {
  return text.replace(/\s*\n\s*/g, ' ').trim();
}

/**
 * Assemble one check's fix-skill parts once, so the markdown twin (with the
 * fenced prompt) and the HTML page (with a hidden copy carrier) share a
 * single prose + prompt source.
 *
 * @param {object} check — normalized registry check
 * @param {{ title: string, goal: string, fix: string, resources: Array<{label: string, url: string}> }} remediation
 * @param {Record<string, string>} categories — slug → display label
 * @param {string} baseUrl
 */
function assembleSkill(check, remediation, categories, baseUrl) {
  const category = categories[check.category] ?? check.category;
  const keyword = KEYWORD_LABELS[check.keyword] ?? check.keyword;
  const docsLine =
    remediation.resources.length > 0 ? [`Docs: ${remediation.resources.map((r) => r.url).join(', ')}`] : [];
  const resourcesSection =
    remediation.resources.length > 0
      ? ['## Resources', '', ...remediation.resources.map((r) => `- [${r.label}](${r.url})`), '']
      : [];
  const prose = [
    `# Fix: ${check.title}`,
    '',
    `> Web-audit fix skill for the \`${check.id}\` check (${category}, ${keyword}).`,
    '',
    '## Goal',
    '',
    `${remediation.goal}.`,
    '',
    '## Fix',
    '',
    remediation.fix.trim(),
    '',
    ...resourcesSection,
  ];
  const promptIntro = `Paste this into your coding agent, replacing the Issue line with the Result line from [your audit](${baseUrl}/web-audit):`;
  const promptLines = [
    `Goal: ${oneLine(remediation.goal)}`,
    "Issue: <the audit's finding for this check>",
    `Fix: ${oneLine(remediation.fix)}`,
    `Skill: ${baseUrl}/web-audit/skill/${check.id}`,
    ...docsLine,
  ];
  const verify = [
    '## Verify',
    '',
    `Re-run the audit at [${baseUrl}/web-audit](${baseUrl}/web-audit) or call the \`audit_website\` MCP tool; the \`${check.id}\` check should report \`pass\`.`,
    '',
  ];
  return { prose, promptIntro, promptLines, verify };
}

/**
 * Markdown twin for one check: prose + the fenced copy-paste prompt. This is
 * the served `.md` (and the digest source), so fetch-only agents keep the
 * full prompt.
 */
export function buildSkillMarkdown(check, remediation, categories, baseUrl) {
  const a = assembleSkill(check, remediation, categories, baseUrl);
  return [
    ...a.prose,
    '## Copy-paste prompt',
    '',
    a.promptIntro,
    '',
    '```text',
    ...a.promptLines,
    '```',
    '',
    ...a.verify,
  ].join('\n');
}

/**
 * HTML body for one check: the prose and the prompt heading render normally;
 * the prompt itself never renders — it rides in a hidden `data-copy-text`
 * carrier that clipboard.js turns into a Copy-prompt button. Returned as
 * pre-rendered HTML segments so the carrier's multi-line attribute bypasses
 * the markdown renderer.
 *
 * @returns {Promise<string>} the assembled body HTML
 */
async function buildSkillHtmlBody(check, remediation, categories, baseUrl) {
  const a = assembleSkill(check, remediation, categories, baseUrl);
  const head = [...a.prose, '## Copy-paste prompt', '', a.promptIntro, ''].join('\n');
  const carrier = `<span class="skill-prompt" data-copy-text="${escHtml(a.promptLines.join('\n'))}" hidden></span>`;
  const tail = a.verify.join('\n');
  return `${await renderMarkdown(head)}\n${carrier}\n${await renderMarkdown(tail)}`;
}

/**
 * Emit every fix-skill page (HTML + markdown twin) and return the entries
 * the agent-skills discovery index lists.
 *
 * @param {{ distDir: string, registryPath: string, remediationPath: string, themeInit: string, baseUrl?: string }} opts
 * @returns {Promise<{ pages: Array<{ id: string, title: string, description: string, url: string, digest: string }> }>}
 */
export async function emitWebAuditSkillPages({ distDir, registryPath, remediationPath, themeInit, baseUrl }) {
  const base = resolveBaseUrl(baseUrl);
  const registry = normalizeWebAuditRegistry(yaml.load(await readFile(registryPath, 'utf8')));
  const remediation = normalizeWebRemediation(
    yaml.load(await readFile(remediationPath, 'utf8')),
    registry.checks.map((c) => c.id),
  );

  const skillDir = join(distDir, 'web-audit', 'skill');
  await mkdir(skillDir, { recursive: true });

  const pages = [];
  for (const check of registry.checks) {
    const markdown = buildSkillMarkdown(check, remediation[check.id], registry.categories, base);
    const served = absolutifyMarkdownLinks(markdown);
    await writeFile(join(skillDir, `${check.id}.md`), served);
    const description = `Fix the "${check.title}" web-audit check.`;
    await writeFile(
      join(skillDir, `${check.id}.html`),
      emitShell({
        title: `Fix: ${check.title}`,
        description,
        canonicalPath: `/web-audit/skill/${check.id}`,
        bodyHtml: await buildSkillHtmlBody(check, remediation[check.id], registry.categories, base),
        themeInitJs: themeInit,
      }),
    );
    pages.push({
      id: check.id,
      title: check.title,
      description,
      url: `${base}/web-audit/skill/${check.id}.md`,
      digest: createHash('sha256').update(served).digest('hex'),
    });
  }
  return { pages };
}
