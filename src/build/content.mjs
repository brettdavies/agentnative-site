// Markdown content extraction helpers — pure functions that parse raw
// markdown strings to extract structural content (titles, summaries,
// descriptions, paragraphs). No filesystem or rendering side effects.

/**
 * Collect the first non-empty paragraph starting at line index `i`.
 * Returns the paragraph as a single joined string plus the new index.
 *
 * @param {string[]} lines
 * @param {number} i — start scanning from this index (inclusive)
 * @returns {{ text: string, end: number }}
 */
function collectParagraph(lines, i) {
  while (i < lines.length && lines[i].trim() === '') i++;
  const buf = [];
  while (i < lines.length && lines[i].trim() !== '') {
    buf.push(lines[i].trim());
    i++;
  }
  return { text: buf.join(' '), end: i };
}

/**
 * Find the line index of the first `# Heading` in a line array.
 * Returns the index of the H1, or `lines.length` if not found.
 *
 * @param {string[]} lines
 * @returns {number}
 */
function findH1(lines) {
  for (let i = 0; i < lines.length; i++) {
    if (/^#\s+/.test(lines[i])) return i;
  }
  return lines.length;
}

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
 * Extract the first prose paragraph after the H1.
 * Used as the homepage hero lede and the llms.txt `>` summary.
 *
 * @param {string} markdown
 * @returns {string}
 */
export function extractFirstParagraph(markdown) {
  const lines = markdown.split('\n');
  return collectParagraph(lines, findH1(lines) + 1).text;
}

/**
 * Extract a one-paragraph summary from _intro.md — the first non-empty
 * paragraph after the H1. Used as the llms.txt `>` line.
 *
 * Delegates to extractFirstParagraph — kept as a named export so call
 * sites read clearly (introSummary vs. generic firstParagraph).
 *
 * @param {string} introMarkdown
 * @returns {string}
 */
export function extractIntroSummary(introMarkdown) {
  return extractFirstParagraph(introMarkdown);
}

/**
 * Extract the first paragraph after the H1 as a short description for
 * meta tags. Skips sub-headings to reach the first prose paragraph.
 * Caps at 180 chars for OG/description meta.
 *
 * @param {string} markdown
 * @param {string} fallback
 * @returns {string}
 */
export function extractDescription(markdown, fallback = '') {
  const lines = markdown.split('\n');
  let i = findH1(lines) + 1;
  // Skip blank lines AND subsequent headings until the first prose paragraph.
  while (i < lines.length && (lines[i].trim() === '' || /^#{1,6}\s/.test(lines[i].trim()))) {
    i++;
  }
  const { text: full } = collectParagraph(lines, i);
  const normalized = full.replace(/\s+/g, ' ').trim();
  if (normalized.length === 0) return fallback;
  // Cap at 180 chars for OG/description meta.
  return normalized.length <= 180 ? normalized : `${normalized.slice(0, 177).replace(/\s+\S*$/, '')}…`;
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
  const { text } = collectParagraph(lines, i + 1);
  return text
    .replace(/\*\*/g, '') // strip bold markers
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // strip links → label only
    .replace(/`([^`]+)`/g, '$1'); // strip inline code → content only
}
