// Every /fix/<id> page the build emits is indexable and canonical, so the
// sitemap lists it. Reads dist/, so run `bun run build` first.

import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as yaml from 'js-yaml';

const REPO_ROOT = new URL('..', import.meta.url).pathname;
const DIST = join(REPO_ROOT, 'dist');

function catalogIds(): string[] {
  const doc = yaml.load(readFileSync(join(REPO_ROOT, 'src', 'data', 'web-audit', 'remediation.yaml'), 'utf8'));
  if (typeof doc !== 'object' || doc === null || !('remediation' in doc)) throw new Error('no remediation mapping');
  return Object.keys(doc.remediation as Record<string, unknown>);
}

const xml = readFileSync(join(DIST, 'sitemap.xml'), 'utf8');

function sitemapLocs(): string[] {
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(([, loc]) => loc);
}

describe('sitemap.xml fix pages', () => {
  const locs = sitemapLocs();

  test('lists the page of every catalog id, the retired id included, once', () => {
    const ids = catalogIds();
    expect(ids.length).toBeGreaterThan(60);
    for (const id of ids) {
      expect(locs.filter((loc) => loc === `https://anc.dev/fix/${id}`)).toHaveLength(1);
    }
  });

  test('lists no /fix/ path the build did not emit', () => {
    const listed = locs.filter((loc) => loc.startsWith('https://anc.dev/fix/'));
    expect(listed.length).toBe(catalogIds().length);
    for (const loc of listed) {
      expect(existsSync(join(DIST, `${new URL(loc).pathname}.html`))).toBe(true);
    }
  });

  test('dates each fix page with a lastmod day', () => {
    for (const id of catalogIds()) {
      expect(xml).toMatch(
        new RegExp(`<loc>https://anc\\.dev/fix/${id}</loc>\\s*<lastmod>\\d{4}-\\d{2}-\\d{2}</lastmod>`),
      );
    }
  });

  test('lists no retired /web-audit/skill/ path', () => {
    expect(locs.filter((loc) => loc.includes('/web-audit/skill/'))).toEqual([]);
  });
});
