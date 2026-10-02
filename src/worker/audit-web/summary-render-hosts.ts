// The Declared hosts slot on a website result page: an unboxed section
// listing each host the site declares and what the audit did with it, or
// one line saying why there is no list. Both forms carry the fragment the
// score note and the empty-category notes link to.

import { escHtml } from '../../shared/esc-html';
import { DECLARED_HOSTS_HEADING, DECLARED_HOSTS_ID } from './provenance-copy';
import { richHtml } from './rich-text';
import type { DeclaredHostsView, TrailEntryView } from './summary-trail';

function codeLine(cls: string, lead: string, value: string): string {
  return `<p class="${cls}">${escHtml(lead)}${richHtml([{ code: value }], { wbr: true })}</p>`;
}

function entryHtml(entry: TrailEntryView): string {
  const parts = [
    `<p class="declared-hosts__surface">${richHtml(entry.surface)}</p>`,
    codeLine('declared-hosts__host', '', entry.host),
  ];
  if (entry.url !== null) parts.push(codeLine('declared-hosts__url', '', entry.url));
  if (entry.redirectedTo !== null) parts.push(codeLine('declared-hosts__url', 'redirected to ', entry.redirectedTo));
  const attention = entry.attention ? ' declared-hosts__outcome--attention' : '';
  parts.push(`<p class="declared-hosts__outcome${attention}">${escHtml(entry.outcome)}</p>`);
  if (entry.why !== null) parts.push(`<p class="declared-hosts__why">${richHtml(entry.why, { wbr: true })}</p>`);
  if (entry.guidance !== null) {
    parts.push(`<p class="declared-hosts__guidance">${richHtml(entry.guidance, { wbr: true })}</p>`);
  }
  return `      <li class="declared-hosts__entry">${parts.join('')}</li>\n`;
}

export function declaredHostsHtml(view: DeclaredHostsView): string {
  if (view.kind === 'line') {
    return `<p class="declared-hosts__state" id="${DECLARED_HOSTS_ID}">${escHtml(view.line)}</p>\n`;
  }
  return `<section class="declared-hosts" id="${DECLARED_HOSTS_ID}" aria-labelledby="${DECLARED_HOSTS_ID}-heading">
  <h2 id="${DECLARED_HOSTS_ID}-heading">${DECLARED_HOSTS_HEADING}</h2>
  <p class="declared-hosts__lede">${escHtml(view.lede)}</p>
  <ol class="declared-hosts__list">
${view.entries.map(entryHtml).join('')}  </ol>
</section>
`;
}
