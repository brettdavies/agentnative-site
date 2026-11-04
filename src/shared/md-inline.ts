// Text a request or an audited target controls, on its way into markdown an agent
// reads. Imported by the build and the Worker, so only pure functions over strings
// live here.

/**
 * `text` on one line. Control characters and the Unicode line and paragraph
 * separators all collapse, because a reader that splits on any of them (Python's
 * `splitlines` does) would otherwise see the text after one start a line, where it
 * can pass for a heading, a list item, or a code fence. A stored record's field is
 * not always a string, so this takes any value, the way `escHtml` does.
 */
export function mdFlatten(text: unknown): string {
  return String(text).replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ');
}

// What turns text into structure: `](` opens a link or image destination, and `<`
// opens an autolink or a tag. A lone `[` does neither, so usage text such as
// `[OPTIONS]` stays readable.
//
// A code span is matched first and left alone, because markdown shows a backslash
// inside one literally, so an escape there would misquote the text. A backtick with
// a backslash before it never opens a span here: a text must not be able to pass a
// link off as code by escaping the span's own opener.
const CODE_SPAN_OR_DELIMITER = /(?<![`\\])(`+)(?!`).*?(?<!`)\1(?!`)|(\\*)(\](?=\()|<)/g;

// A backslash touching a delimiter would cancel a lone escape, so those double.
// Every other backslash stays as written.
function escapedDelimiter(slashes: string, delimiter: string): string {
  return `${slashes}${slashes}\\${delimiter}`;
}

/** Text on one line that cannot form a link, an image, an autolink, or a tag. */
export function mdInlineText(text: unknown): string {
  return mdFlatten(text).replace(
    CODE_SPAN_OR_DELIMITER,
    (match, fence: string | undefined, slashes: string, ch: string) => (fence ? match : escapedDelimiter(slashes, ch)),
  );
}

/**
 * `mdInlineText` for a table cell. A pipe ends the cell even inside a code span,
 * where the table parser removes the backslash before the span is read, so a pipe
 * is escaped everywhere.
 */
export function mdTableCell(text: unknown): string {
  return mdInlineText(text).replace(/(\\*)\|/g, (_match, slashes: string) => escapedDelimiter(slashes, '|'));
}

/** A code span no backtick inside it can close early. */
export function mdCodeSpan(text: unknown): string {
  const flat = mdFlatten(text);
  if (!flat.includes('`')) return `\`${flat}\``;
  const longest = Math.max(...[...flat.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(longest + 1);
  return `${fence} ${flat} ${fence}`;
}

/**
 * A URL as a markdown link destination. `encodeURIComponent` leaves parentheses
 * alone, and an unbalanced `)` ends the destination wherever it falls.
 */
export function mdLinkDestination(url: string): string {
  return url.replace(/[()]/g, (ch) => (ch === '(' ? '%28' : '%29'));
}
