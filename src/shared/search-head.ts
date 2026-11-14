// What a page's `<head>` states about itself to search engines, whether the
// build or the Worker writes it. Bing's Site Scan flags a meta description
// outside 25 to 160 characters.

export const DESCRIPTION_MIN = 25;
export const DESCRIPTION_MAX = 160;

/** A description's last character: terminal punctuation, then any closing quote or bracket. */
export const SENTENCE_END = /[.!?]["')\]]*$/;

/** Whether a description sits inside the range engines show whole. */
export function descriptionFits(description: string): boolean {
  return description.length >= DESCRIPTION_MIN && description.length <= DESCRIPTION_MAX;
}

/** The text, closed with a full stop when it does not already end a sentence. */
export function endSentence(text: string): string {
  return SENTENCE_END.test(text) ? text : `${text}.`;
}

/**
 * The first candidate that fits, in preference order. A request-time page
 * names a visitor-supplied target, so its richest wording can run long; the
 * last candidate is the one that always fits, and the result when none does.
 */
export function fitDescription(first: string, ...fallbacks: string[]): string {
  const candidates = [first, ...fallbacks];
  return candidates.find(descriptionFits) ?? candidates[candidates.length - 1];
}

// A page's `<title>` names the site so a search for the brand has something to
// match. Bing's Site Scan flags a title outside 15 to 70 characters.

export const BRAND = 'agentnative';
export const TITLE_MIN = 15;
export const TITLE_MAX = 70;

const TITLE_SUFFIX = ` · ${BRAND}`;

/** The home page's `<title>`: the one page that names the brand and the standard instead of taking the suffix. */
export const HOME_HEAD_TITLE = `${BRAND}: the agent-native CLI standard`;

/**
 * The `<title>` for a page: its own title, then the brand. The first candidate
 * that keeps the whole title inside 70 characters wins, so a page offers a
 * shorter wording of its own part, never a shorter suffix. When none fits, the
 * last candidate is cut to the room that is left.
 */
export function headTitle(first: string, ...shorter: string[]): string {
  const candidates = [first, ...shorter];
  const fits = candidates.find((candidate) => candidate.length + TITLE_SUFFIX.length <= TITLE_MAX);
  if (fits !== undefined) return `${fits}${TITLE_SUFFIX}`;
  const last = candidates[candidates.length - 1];
  return `${last.slice(0, TITLE_MAX - TITLE_SUFFIX.length - 1)}…${TITLE_SUFFIX}`;
}
