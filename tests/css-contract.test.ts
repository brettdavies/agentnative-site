// Contract tests for the stylesheets that ship in dist/. Two invariants:
//
//   1. Every custom property referenced without a fallback in shipped CSS
//      is defined by some shipped stylesheet (or by the Shiki inline-style
//      allowlist below). A bare var(--x) with no definition is invalid at
//      computed-value time and silently degrades to the inherited or
//      initial value, so pages keep rendering while a token is broken.
//
//   2. Every stylesheet under src/styles/ ships to dist/css/. A stylesheet
//      dropped from the asset copy step disappears from the wire silently
//      because the remaining CSS still renders the pages.
//
// Fallback policy: var(--x, fallback) may reference an undefined property.
// The fallback is the author's declared recovery value, so the reference
// resolves either way. var() references nested inside a fallback are
// scanned by the same rule (the matcher sees every occurrence, nested or
// not), so a fallback chain that dead-ends on a bare undefined property
// still fails.
//
// Assertions parse the var()/declaration grammar out of the minified dist
// bytes rather than byte-matching source formatting, so minifier
// reformatting (whitespace, quote stripping, numeric normalization)
// cannot desync them.
//
// Scope: dist/**/*.css for shipped bytes; src/styles/ for shipping
// coverage. scripts/og/og.css feeds the OG PNG renderer at build time and
// intentionally never ships; top-level styles/ holds Vale configuration,
// not stylesheets.
//
// Run `bun run build` before these tests (bun test does not auto-build).

import { beforeAll, describe, expect, test } from 'bun:test';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { distStylesheets, requireDistBuild } from './helpers/dist';

const REPO_ROOT = join(import.meta.dir, '..');
const DIST = join(REPO_ROOT, 'dist');
const STYLES_SRC = join(REPO_ROOT, 'src/styles');

// Shiki emits these as inline style attributes on highlighted tokens
// (style="--shiki-dark:#..."), so no stylesheet defines them; the
// dark-mode rules in site.css read them with bare var().
const SHIKI_INLINE_DEFINED = [
  '--shiki-dark',
  '--shiki-dark-bg',
  '--shiki-dark-font-style',
  '--shiki-dark-font-weight',
  '--shiki-dark-text-decoration',
];

interface VarRef {
  property: string;
  hasFallback: boolean;
}

function varReferences(css: string): VarRef[] {
  const refs: VarRef[] = [];
  for (const m of css.matchAll(/var\(\s*(--[A-Za-z0-9_-]+)\s*([,)])/g)) {
    refs.push({ property: m[1], hasFallback: m[2] === ',' });
  }
  return refs;
}

function definedProperties(css: string): Set<string> {
  const defined = new Set<string>();
  for (const m of css.matchAll(/(?:^|[{;])\s*(--[A-Za-z0-9_-]+)\s*:/g)) {
    defined.add(m[1]);
  }
  return defined;
}

async function bareUndefinedRefs(): Promise<{ file: string; property: string }[]> {
  const sheets = await distStylesheets(DIST);
  expect(sheets.length).toBeGreaterThanOrEqual(2);
  const defined = new Set(SHIKI_INLINE_DEFINED);
  for (const { css } of sheets) {
    for (const property of definedProperties(css)) {
      defined.add(property);
    }
  }
  const offenders: { file: string; property: string }[] = [];
  for (const { file, css } of sheets) {
    for (const ref of varReferences(css)) {
      if (ref.hasFallback || defined.has(ref.property)) continue;
      offenders.push({ file, property: ref.property });
    }
  }
  return offenders;
}

beforeAll(() => {
  requireDistBuild(DIST);
});

describe('custom property contract (shipped stylesheets)', () => {
  test('every bare var() reference names a property some shipped stylesheet defines', async () => {
    const offenders = await bareUndefinedRefs();
    if (offenders.length > 0) {
      const summary = offenders.map((o) => `  ${o.file}: var(${o.property})`).join('\n');
      throw new Error(
        `Found ${offenders.length} bare var() reference(s) to custom properties no shipped ` +
          'stylesheet defines. Define the property in src/styles/, give the reference a ' +
          'fallback value, or (for properties set via inline style attributes at render ' +
          `time) extend the allowlist:\n${summary}`,
      );
    }
    expect(offenders).toHaveLength(0);
  });

  test('self-test: a bare reference to an undefined property is flagged', () => {
    const refs = varReferences('a{color:var(--missing)}');
    expect(refs).toEqual([{ property: '--missing', hasFallback: false }]);
  });

  test('self-test: a reference with a fallback is exempt', () => {
    const refs = varReferences('a{color:var(--missing,#fff)}');
    expect(refs).toEqual([{ property: '--missing', hasFallback: true }]);
  });

  test('self-test: a bare reference nested inside a fallback is still flagged', () => {
    const refs = varReferences('a{color:var(--outer,var(--inner))}');
    expect(refs).toEqual([
      { property: '--outer', hasFallback: true },
      { property: '--inner', hasFallback: false },
    ]);
  });

  test('self-test: a fallback-bearing reference nested inside a fallback is exempt', () => {
    const refs = varReferences('a{color:var(--outer,var(--inner,red))}');
    expect(refs).toEqual([
      { property: '--outer', hasFallback: true },
      { property: '--inner', hasFallback: true },
    ]);
  });

  test('self-test: declarations are collected from minified rule bodies, any selector scope', () => {
    const defined = definedProperties(':root{--a:1;--b:calc(var(--a) * 2)}.scoped{--c:var(--b)}');
    expect([...defined].sort()).toEqual(['--a', '--b', '--c']);
  });
});

describe('stylesheet shipping (src/styles -> dist/css)', () => {
  test('every stylesheet under src/styles/ has a non-empty dist/css counterpart', async () => {
    const entries = await readdir(STYLES_SRC, { recursive: true });
    const sources = entries.filter((name) => name.endsWith('.css')).sort();
    expect(sources.length).toBeGreaterThanOrEqual(2);
    for (const name of sources) {
      const info = await stat(join(DIST, 'css', name)).catch(() => null);
      expect({ stylesheet: name, shipped: info !== null && info.size > 0 }).toEqual({
        stylesheet: name,
        shipped: true,
      });
    }
  });
});
