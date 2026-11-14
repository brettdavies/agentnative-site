// What a page's `<head>` states about itself to search engines. Bing's Site
// Scan flags a meta description outside 25 to 160 characters; the same range
// holds for every page, whether the build or the Worker writes it.

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
