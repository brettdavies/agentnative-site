// Markdown content extraction helpers — pure functions that parse raw
// markdown strings to extract structural content (titles, summaries,
// descriptions, paragraphs). No filesystem or rendering side effects.

/**
 * Extract the first `# Heading` from a markdown string, trimmed.
 * Falls back to a stable placeholder if no H1 is present.
 *
 * @param {string} markdown
 * @returns {string}
 */
export function extractTitle(markdown) {
  for (const line of markdown.split('\n')) {
    const match = line.match(/^#\s+(.+?)\s*$/);
    if (match) return match[1].trim();
  }
  return 'Untitled';
}

/**
 * Extract a one-paragraph summary from _intro.md — the first non-empty
 * paragraph after the H1. Used as the llms.txt `>` line.
 *
 * @param {string} introMarkdown
 * @returns {string}
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

/**
 * Extract the first paragraph after the H1 as a short description for
 * meta tags. Works on the raw markdown, pre-render.
 *
 * @param {string} markdown
 * @param {string} fallback
 * @returns {string}
 */
export function extractDescription(markdown, fallback = '') {
  const lines = markdown.split('\n');
  let i = 0;
  while (i < lines.length && !lines[i].match(/^#\s+/)) i++;
  i++; // past H1
  // Skip blank lines AND subsequent headings (`## Definition` etc.) until
  // the first real prose paragraph.
  while (i < lines.length && (lines[i].trim() === '' || /^#{1,6}\s/.test(lines[i].trim()))) {
    i++;
  }
  const buf = [];
  while (i < lines.length && lines[i].trim() !== '') {
    buf.push(lines[i].trim());
    i++;
  }
  const full = buf.join(' ').replace(/\s+/g, ' ').trim();
  if (full.length === 0) return fallback;
  // Cap at 180 chars for OG/description meta.
  return full.length <= 180 ? full : full.slice(0, 177).replace(/\s+\S*$/, '') + '…';
}

/**
 * Extract the first prose paragraph after the H1 — the lede for the
 * homepage hero. Returns the paragraph as a single string.
 *
 * @param {string} markdown
 * @returns {string}
 */
export function extractFirstParagraph(markdown) {
  const lines = markdown.split('\n');
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

/**
 * Extract the full `## Definition` paragraph — used as the description
 * in the homepage principle listing. Strips markdown formatting (bold,
 * links, inline code) for plain-text output.
 *
 * @param {string} markdown
 * @returns {string}
 */
export function extractDefinitionParagraph(markdown) {
  const lines = markdown.split('\n');
  let i = 0;
  while (i < lines.length && !/^##\s+Definition/.test(lines[i])) i++;
  i++; // past heading
  while (i < lines.length && lines[i].trim() === '') i++;
  const buf = [];
  while (i < lines.length && lines[i].trim() !== '') {
    buf.push(lines[i].trim());
    i++;
  }
  return buf
    .join(' ')
    .replace(/\*\*/g, '') // strip bold markers
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // strip links → label only
    .replace(/`([^`]+)`/g, '$1'); // strip inline code → content only
}
