// Text a request or an audited target controls, on its way into markdown an agent
// reads. Imported by the build and the Worker, so only pure functions over strings
// live here.

/**
 * `text` on one line. Control characters and the Unicode line and paragraph
 * separators all collapse, because a reader that splits on any of them (Python's
 * `splitlines` does) would otherwise see the text after one start a line, where it
 * can pass for a heading, a list item, or a code fence.
 */
export function mdFlatten(text: string): string {
  return text.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ');
}

/**
 * A URL as a markdown link destination. `encodeURIComponent` leaves parentheses
 * alone, and an unbalanced `)` ends the destination wherever it falls.
 */
export function mdLinkDestination(url: string): string {
  return url.replace(/[()]/g, (ch) => (ch === '(' ? '%28' : '%29'));
}
