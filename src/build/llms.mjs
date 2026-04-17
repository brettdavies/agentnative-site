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

const DEFAULT_BASE = 'https://agentnative.dev';

/**
 * Extract the first `# Heading` from a markdown string, trimmed.
 * Falls back to a stable placeholder if no H1 is present.
 */
export function extractTitle(markdown) {
  for (const line of markdown.split('\n')) {
    const match = line.match(/^#\s+(.+?)\s*$/);
    if (match) return match[1].trim();
  }
  return 'Untitled';
}

/**
 * Build the short llms.txt index.
 *
 * @param {object} args
 * @param {string} args.introTitle Title for the H1 (taken from _intro.md).
 * @param {string} args.summary Short paragraph summary (from _intro.md).
 * @param {Array<{ n: number, slug: string, title: string }>} args.principles
 * @param {Array<{ name: string, title: string }>=} args.subPages
 * @param {string=} args.baseUrl
 */
export function buildLlmsIndex({ introTitle, summary, principles, subPages = [], baseUrl }) {
  const base = (baseUrl ?? process.env.PUBLIC_BASE_URL ?? DEFAULT_BASE).replace(/\/$/, '');

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
  const base = (baseUrl ?? process.env.PUBLIC_BASE_URL ?? DEFAULT_BASE).replace(/\/$/, '');

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

/**
 * Extract a one-paragraph summary from _intro.md — the first non-empty
 * paragraph after the H1. Used as the llms.txt `>` line.
 */
export function extractIntroSummary(introMarkdown) {
  const lines = introMarkdown.split('\n');
  let i = 0;
  while (i < lines.length && !lines[i].match(/^#\s+/)) i++;
  i++; // past H1
  while (i < lines.length && lines[i].trim() === '') i++;

  const buf = [];
  while (i < lines.length && lines[i].trim() !== '') {
    buf.push(lines[i].trim());
    i++;
  }
  return buf.join(' ');
}
