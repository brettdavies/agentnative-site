// Counts and name lists the e2e suite asserts, derived from the same
// sources the build renders from. A content or nav change moves the site
// and these expectations together; what the specs then measure is that
// every entry actually reaches the rendered surface, not an editorial
// count that rots when the source changes.

import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { WEB_CHECKS } from '../../src/build/06-homepage.mjs';
import { SUB_PAGES } from '../../src/build/07-subpages.mjs';
import { AI_PROVIDERS, DUAL_SURFACE_NAV_LABELS, NAV_LINKS } from '../../src/build/shell.mjs';

const PRINCIPLE_FILE_RE = /^p(\d+)-[a-z0-9-]+\.md$/;

const PRINCIPLES_DIR = fileURLToPath(new URL('../../content/principles/', import.meta.url));

// The `n` of every content/principles/p<n>-<slug>.md, in numeric order —
// the same fileset the build's sortedGlob renders the spec index from.
export const PRINCIPLE_NUMBERS: number[] = readdirSync(PRINCIPLES_DIR)
  .map((f) => PRINCIPLE_FILE_RE.exec(f)?.[1])
  .filter((n): n is string => n !== undefined)
  .map(Number)
  .sort((a, b) => a - b);

export const PRINCIPLE_COUNT = PRINCIPLE_NUMBERS.length;

export const NAV_ENTRY_COUNT = NAV_LINKS.length;

export const DUAL_SURFACE_NAV_COUNT = DUAL_SURFACE_NAV_LABELS.length;

export const AI_PROVIDER_COUNT = AI_PROVIDERS.length;

export const WEB_CHECK_COUNT = WEB_CHECKS.length;

export const SUB_PAGE_NAMES: string[] = SUB_PAGES.map((p) => p.name);
