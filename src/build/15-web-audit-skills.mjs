// Per-check web-audit fix skills. Emits one content page per registry check
// at dist/fix/<id>.html plus its markdown twin, generated from the registry +
// remediation catalog (STAR: remediation.yaml is the single prose source, so
// the skill pages and the get_web_remediation tool can never drift apart).
//
// Served through the standard asset-first dispatch: /fix/<id> resolves the
// HTML, the `.md` suffix or `Accept: text/markdown` resolves the twin, and an
// unknown check id 404s like any missing asset.

import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import { AUDIT_PATH, FIX_INDEX_PATH, fixPath } from '../shared/audit-routes';
import { escHtml } from '../shared/scorecard-format.mjs';
import { normalizeWebAuditRegistry, normalizeWebRemediation } from './13-web-audit-registry.mjs';
import { renderMarkdown } from './render.mjs';
import { emitShell } from './shell.mjs';
import { absolutifyMarkdownLinks, composeTwin, resolveBaseUrl } from './util.mjs';

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
  // These lines must stay byte-identical to assembleRemediation() in
  // src/worker/audit-web/remediation.ts assembled without evidence, because
  // this page and the audit result page are the same prompt reached two ways.
  // A skill page describes a check in general, so it has no run to quote: the
  // audit's own finding rides the delimited evidence block that the result
  // page appends. tests/web-audit-skills.test.ts pins the two together.
  const promptIntro = `Paste this into your coding agent. [Your audit](${baseUrl}${AUDIT_PATH}) adds what it observed for this check:`;
  const promptLines = [
    `Goal: ${oneLine(remediation.goal)}`,
    `Fix: ${oneLine(remediation.fix)}`,
    `Skill: ${baseUrl}${fixPath(check.id)}`,
    ...docsLine,
  ];
  const verify = [
    '## Verify',
    '',
    `Re-run the audit at [${baseUrl}${AUDIT_PATH}](${baseUrl}${AUDIT_PATH}) or call the \`audit_website\` MCP tool; the \`${check.id}\` check should report \`pass\`.`,
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

const FIX_INDEX_TITLE = 'Agent-readiness fixes';

/**
 * The index's markdown, and the single source both its HTML and its twin
 * render from — the same STAR posture the per-check pages take.
 *
 * Every check page is generated, so before this page existed nothing on the
 * site linked one: the 65 of them were reachable only by guessing a slug.
 * This is the hub that makes them crawlable, and the reason `/fix` appears in
 * the footer of every page and in the sitemap.
 *
 * Checks are grouped by `category_order` rather than by tier, because a reader
 * arrives holding a category ("my MCP surface is failing"), not a keyword.
 *
 * @param {{ category_order: string[], categories: Record<string, string>, checks: Array<object> }} registry
 * @returns {string} markdown body (no frontmatter)
 */
export function buildFixIndexMarkdown(registry) {
  const byCategory = new Map(registry.category_order.map((slug) => [slug, []]));
  for (const check of registry.checks) {
    byCategory.get(check.category)?.push(check);
  }

  const categoryNames = registry.category_order.map((slug) => registry.categories[slug]);
  const lines = [
    `# ${FIX_INDEX_TITLE}`,
    '',
    `Every check the website audit runs, each with a copy-paste fix you can hand to a coding agent. ${registry.checks.length} checks across ${registry.category_order.length} categories: ${categoryNames.join(', ')}.`,
    '',
    `Run the audit at [${AUDIT_PATH}](${AUDIT_PATH}) to find out which of these your site fails.`,
    '',
  ];

  for (const slug of registry.category_order) {
    const checks = byCategory.get(slug) ?? [];
    if (checks.length === 0) continue;
    lines.push(`## ${registry.categories[slug]}`, '');
    for (const check of checks) {
      const keyword = KEYWORD_LABELS[check.keyword] ?? check.keyword;
      // Three registry titles name an element inline (`<link rel>`,
      // `<noscript>`, `<meta name="description">`). Markdown passes raw HTML
      // through, so an unescaped title renders as a tag and its text vanishes.
      lines.push(`- [${escHtml(check.title)}](${fixPath(check.id)}) — ${keyword}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Emit the fix index (HTML + markdown twin) at the namespace's bare path.
 * Flat like every other page — `dist/fix.html` beside the `dist/fix/`
 * directory, not `dist/fix/index.html` — so `/fix` resolves the page and the
 * Worker's `markdownTwinFor` lands on `/fix.md`.
 */
async function emitFixIndex({ distDir, registry, themeInit, baseUrl }) {
  const markdown = buildFixIndexMarkdown(registry);
  const description = `Every web-audit check anc.dev runs, each with a copy-paste fix: ${registry.category_order
    .map((slug) => registry.categories[slug])
    .join(', ')}.`;

  await writeFile(
    join(distDir, 'fix.md'),
    composeTwin({ title: FIX_INDEX_TITLE, description, canonicalPath: FIX_INDEX_PATH }, markdown, baseUrl),
  );
  await writeFile(
    join(distDir, 'fix.html'),
    emitShell({
      title: FIX_INDEX_TITLE,
      description,
      canonicalPath: FIX_INDEX_PATH,
      breadcrumb: 'Fixes',
      // Site-relative in the page (a staging build links staging); composeTwin
      // absolutifies for the twin, where a fetched document must self-resolve.
      bodyHtml: await renderMarkdown(markdown),
      themeInitJs: themeInit,
    }),
  );
}

/**
 * Emit the fix index plus every fix-skill page (HTML + markdown twin) and
 * return the entries the agent-skills discovery index lists.
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

  const skillDir = join(distDir, 'fix');
  // dist/ survives between builds, and the Worker no longer claims the retired
  // path: a page left there would be served straight off the assets binding
  // beside the new one.
  await rm(join(distDir, 'web-audit', 'skill'), { recursive: true, force: true });
  await mkdir(skillDir, { recursive: true });

  const pages = [];
  for (const check of registry.checks) {
    const markdown = buildSkillMarkdown(check, remediation[check.id], registry.categories, base);
    const served = absolutifyMarkdownLinks(markdown, baseUrl);
    await writeFile(join(skillDir, `${check.id}.md`), served);
    const description = `Fix the "${check.title}" web-audit check.`;
    await writeFile(
      join(skillDir, `${check.id}.html`),
      emitShell({
        title: `Fix: ${check.title}`,
        description,
        canonicalPath: fixPath(check.id),
        breadcrumb: check.breadcrumb,
        bodyHtml: await buildSkillHtmlBody(check, remediation[check.id], registry.categories, base),
        themeInitJs: themeInit,
      }),
    );
    pages.push({
      id: check.id,
      title: check.title,
      description,
      url: `${base}${fixPath(check.id)}.md`,
      digest: createHash('sha256').update(served).digest('hex'),
    });
  }

  await emitFixIndex({ distDir, registry, themeInit, baseUrl });

  return { pages };
}
