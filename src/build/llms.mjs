// Emit dist/llms.txt and dist/llms-full.txt per llmstxt.org + eng review A5.
//
// llms.txt layout (short index):
//   # <Title>
//   > <one-paragraph summary>
//
//   ## Principles
//   - [P1 — Non-Interactive by Default](/p1.md)
//   ...
//
//   ## Pages
//   - [Check your CLI](/check.md)
//   - [About this standard](/about.md)
//
//   ## Scorecards
//   - [Leaderboard](/scorecards.md)
//
// llms-full.txt layout (A5 format): each section is
//   # <Title>
//
//   Source: <html-url>
//   Canonical-Markdown: <md-url>
//
//   <body verbatim>
//
//   ---
//
// Sections shipped in llms-full: _intro, p1..p7, check, about.

import { resolveBaseUrl } from './util.mjs';

/**
 * Build the short llms.txt index.
 *
 * @param {object} args
 * @param {string} args.introTitle Title for the H1 (taken from _intro.md).
 * @param {string} args.summary Short paragraph summary (from _intro.md).
 * @param {Array<{ n: number, slug: string, title: string }>} args.principles
 * @param {Array<{ name: string, title: string }>=} args.subPages
 * @param {Array<{ name: string, path: string }>=} args.scorecardLinks
 * @param {Array<{ name: string, path: string }>=} args.skillLinks
 * @param {string=} args.baseUrl
 */
export function buildLlmsIndex({
  introTitle,
  summary,
  principles,
  subPages = [],
  scorecardLinks = [],
  skillLinks = [],
  baseUrl,
}) {
  const base = resolveBaseUrl(baseUrl);

  const lines = [];
  lines.push(`# ${introTitle}`);
  lines.push('');
  lines.push(`> ${summary}`);
  lines.push('');
  lines.push('## Principles');
  lines.push('');
  for (const p of principles) {
    lines.push(`- [${p.title}](${base}/p${p.n}.md)`);
  }
  if (subPages.length > 0) {
    lines.push('');
    lines.push('## Pages');
    lines.push('');
    for (const s of subPages) {
      lines.push(`- [${s.title}](${base}/${s.name}.md)`);
    }
  }
  if (skillLinks.length > 0) {
    lines.push('');
    lines.push('## Skill');
    lines.push('');
    for (const s of skillLinks) {
      lines.push(`- [${s.name}](${base}${s.path})`);
    }
  }
  if (scorecardLinks.length > 0) {
    lines.push('');
    lines.push('## Scorecards');
    lines.push('');
    for (const s of scorecardLinks) {
      lines.push(`- [${s.name}](${base}${s.path})`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Build llms-full.txt — per-section delimited per A5.
 *
 * @param {object} args
 * @param {Array<{ path: string, body: string, htmlPath: string, mdPath: string, title: string }>} args.sections
 * @param {string=} args.baseUrl
 */
export function buildLlmsFull({ sections, baseUrl }) {
  const base = resolveBaseUrl(baseUrl);

  const chunks = sections.map((s) => {
    const source = base + s.htmlPath;
    const canonicalMd = base + s.mdPath;
    // A5 format — # <Title>, blank, Source:, Canonical-Markdown:, blank, body, blank, ---.
    return [
      `# ${s.title}`,
      '',
      `Source: ${source}`,
      `Canonical-Markdown: ${canonicalMd}`,
      '',
      s.body.trim(),
      '',
      '---',
      '',
    ].join('\n');
  });

  return chunks.join('\n');
}
