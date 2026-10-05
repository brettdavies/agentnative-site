// Per-check web-audit fix skills. Emits one content page per registry check
// at dist/fix/<id>.html plus its markdown twin, generated from the registry +
// remediation catalog (STAR: remediation.yaml is the single prose source, so
// the skill pages and the get_web_remediation tool can never drift apart).
// A retired check id keeps a page, which names its successor, because stored
// rows and prompts copied from them still link it.
//
// Served through the standard asset-first dispatch: /fix/<id> resolves the
// HTML, the `.md` suffix or `Accept: text/markdown` resolves the twin, and an
// unknown check id 404s like any missing asset.

import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import { AUDIT_PATH, fixPath } from '../shared/audit-routes';
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
/** The Goal, Fix, and Resources sections a page renders from one catalog entry. */
function catalogSections(remediation) {
  const resourcesSection =
    remediation.resources.length > 0
      ? ['## Resources', '', ...remediation.resources.map((r) => `- [${r.label}](${r.url})`), '']
      : [];
  return ['## Goal', '', `${remediation.goal}.`, '', '## Fix', '', remediation.fix.trim(), '', ...resourcesSection];
}

/** "(Category, KEYWORD)" for a check. */
function checkLabel(check, categories) {
  return `${categories[check.category] ?? check.category}, ${KEYWORD_LABELS[check.keyword] ?? check.keyword}`;
}

/** The Verify section: re-run the audit and read `checkId`'s row. */
function verifySection(checkId, baseUrl) {
  return [
    '## Verify',
    '',
    `Re-run the audit at [${baseUrl}${AUDIT_PATH}](${baseUrl}${AUDIT_PATH}) or call the \`audit_website\` MCP tool; the \`${checkId}\` check should report \`pass\`.`,
    '',
  ];
}

function assembleSkill(check, remediation, categories, baseUrl) {
  const docsLine =
    remediation.resources.length > 0 ? [`Docs: ${remediation.resources.map((r) => r.url).join(', ')}`] : [];
  const prose = [
    `# Fix: ${check.title}`,
    '',
    `> Web-audit fix skill for the \`${check.id}\` check (${checkLabel(check, categories)}).`,
    '',
    ...catalogSections(remediation),
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
  return { prose, promptIntro, promptLines, verify: verifySection(check.id, baseUrl) };
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
 * Markdown for a retired check id's page: what replaced it and why, then its
 * catalog text. It carries no copy-paste prompt, because no audit reports a
 * retired id, so none adds what it observed; Verify names the successor.
 *
 * @param {string} id — the retired check id
 * @param {{ successor: string, reason: string }} retired — its registry entry
 * @param {object} successor — the normalized successor check
 * @param {{ title: string, goal: string, fix: string, resources: Array<{label: string, url: string}> }} remediation
 * @param {Record<string, string>} categories
 * @param {string} baseUrl
 */
export function buildRetiredSkillMarkdown(id, retired, successor, remediation, categories, baseUrl) {
  return [
    `# Fix: ${remediation.title}`,
    '',
    `> Retired web-audit check \`${id}\`, replaced by [\`${successor.id}\`](${baseUrl}${fixPath(successor.id)}) (${checkLabel(successor, categories)}): ${retired.reason}.`,
    '',
    ...catalogSections(remediation),
    ...verifySection(successor.id, baseUrl),
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
  const retired = registry.retired ?? {};
  const remediation = normalizeWebRemediation(
    yaml.load(await readFile(remediationPath, 'utf8')),
    registry.checks.map((c) => c.id),
    Object.keys(retired),
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
  // Retired pages answer old links only, so the agent-skills index, which
  // lists the checks an audit reports, does not carry them.
  const checkById = new Map(registry.checks.map((check) => [check.id, check]));
  for (const [id, entry] of Object.entries(retired)) {
    const successor = checkById.get(entry.successor);
    const markdown = buildRetiredSkillMarkdown(id, entry, successor, remediation[id], registry.categories, base);
    await writeFile(join(skillDir, `${id}.md`), absolutifyMarkdownLinks(markdown, baseUrl));
    await writeFile(
      join(skillDir, `${id}.html`),
      emitShell({
        title: `Fix: ${remediation[id].title}`,
        description: `The retired "${id}" web-audit check, replaced by ${entry.successor}.`,
        canonicalPath: fixPath(id),
        breadcrumb: `${successor.breadcrumb} (retired)`,
        bodyHtml: await renderMarkdown(markdown),
        themeInitJs: themeInit,
      }),
    );
  }
  return { pages };
}
