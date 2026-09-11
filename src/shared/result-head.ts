// The `<head>` alternates a result page advertises. Both hrefs come from
// the route module's builders, so they are byte-equal to the `Link`
// header targets an agent reading only headers sees; a page and its
// headers cannot disagree about where the twin and the JSON live.

import { scoreJsonPath, scoreMarkdownPath } from './audit-routes';

function escAttr(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
}

/** The markdown alternate `<link>` for a page whose twin lives at `markdownPath`. */
export function markdownAlternateLink(markdownPath: string): string {
  return `<link rel="alternate" type="text/markdown" href="${escAttr(markdownPath)}" title="This page as markdown" />`;
}

/** The JSON alternate `<link>` for a page whose envelope lives at `jsonPath`. */
export function jsonAlternateLink(jsonPath: string): string {
  return `<link rel="alternate" type="application/json" href="${escAttr(jsonPath)}" title="This result as JSON" />`;
}

/** Both alternates for `/score/<target>`: the `/md` twin and the `/json` envelope. */
export function resultAlternateLinks(target: string): string {
  return `${markdownAlternateLink(scoreMarkdownPath(target))}\n    ${jsonAlternateLink(scoreJsonPath(target))}`;
}
