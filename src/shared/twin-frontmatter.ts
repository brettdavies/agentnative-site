// The YAML frontmatter block every markdown twin opens with, built and
// Worker-rendered alike, so an agent fetching a twin gets the metadata the
// HTML page carries in its head. Every block is written here.

import * as yaml from 'js-yaml';
import { isDay } from './page-date';

export type TwinMeta = {
  title: string;
  description: string;
  /** The page's canonical HTML URL. */
  url: string;
  /** The page's `YYYY-MM-DD` content date; a page with none omits the key. */
  dateModified?: string | null;
};

const DATE_KEY = 'dateModified';

/**
 * A frontmatter fence, `---\n<yaml>---\n`: the page's metadata when there is
 * a page, then `extra` in order.
 */
export function frontmatterFence(meta: TwinMeta | null, extra: Readonly<Record<string, string>> = {}): string {
  const fields: Record<string, string> = {};
  if (meta) {
    const { title, description, url, dateModified = null } = meta;
    if (dateModified !== null && !isDay(dateModified)) {
      throw new Error(`frontmatter: ${url} dateModified "${dateModified}" is not a YYYY-MM-DD day`);
    }
    Object.assign(fields, { title, description, url }, dateModified === null ? {} : { [DATE_KEY]: dateModified });
  }
  Object.assign(fields, extra);
  // lineWidth: -1 disables yaml's line folding so a long description stays
  // one physical `description:` line instead of a `>-` block scalar.
  return `---\n${yaml.dump(fields, { lineWidth: -1 })}---\n`;
}

/** A twin's frontmatter block and the blank line before its body. */
export function renderFrontmatter(meta: TwinMeta): string {
  return `${frontmatterFence(meta)}\n`;
}

/**
 * A twin with its `dateModified` moved to `day` when `day` is later. The key
 * is matched unindented inside the opening block, where a multi-line
 * description cannot start a line with it, and a twin with no date stays as
 * it is.
 */
export function raiseFrontmatterDate(twin: string, day: string | null): string {
  if (!isDay(day) || !twin.startsWith('---\n')) return twin;
  const end = twin.indexOf('\n---\n');
  if (end < 0) return twin;
  const block = twin.slice(0, end + 1);
  const line = block.split('\n').find((l) => l.startsWith(`${DATE_KEY}:`));
  if (line === undefined) return twin;
  const stated = (yaml.load(line) as Record<string, unknown> | null)?.[DATE_KEY];
  if (!isDay(stated) || stated >= day) return twin;
  const raised = yaml.dump({ [DATE_KEY]: day }, { lineWidth: -1 }).trimEnd();
  return block.replace(line, () => raised) + twin.slice(end + 1);
}
