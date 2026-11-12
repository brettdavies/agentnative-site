// Guard: content/changelog.md links the site's own pages by relative path.
//
// Each release adds a hand-written entry to this page. A relative link resolves
// against whichever origin serves the HTML page (production, staging, a local
// preview), and the build absolutifies the markdown twin's links on its own, so
// an entry that hard-codes the site's host sends staging and local readers to
// production.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const SOURCE = readFileSync(new URL('../content/changelog.md', import.meta.url), 'utf8');
const OWN_HOST_URL =
  /(?:https?:)?\/\/(?:(?:www\.)?anc\.dev|(?:[a-z0-9-]+\.)+workers\.dev|localhost|127\.0\.0\.1)\b[^\s)>\]"']*/gi;

describe('content/changelog.md', () => {
  test('links to the site carry no absolute anc.dev, workers.dev, or localhost URL', () => {
    const absolute = [...SOURCE.matchAll(OWN_HOST_URL)].map((m) => m[0]);
    expect(absolute).toEqual([]);
  });
});
