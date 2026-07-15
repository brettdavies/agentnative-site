// Web-seed projection. Section 11d of the build.
//
// Reads the curated seed list (src/data/web-audit/seed.yaml) and emits
// dist/_internal/web-seed.json — the runtime domain list the Worker's
// rescore Workflow and seed-membership check consume. Every web read
// surface (board, homepage pane, per-domain pages, MCP list/get) renders
// from R2 at request time, so nothing else is emitted here: no static
// board page and no per-seed scorecard projections.
//
// A malformed seed entry is excluded with a build warning, not a hard
// error, so one bad row can't break the whole build.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import yaml from 'js-yaml';

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]{0,62})(\.[a-z0-9]([a-z0-9-]{0,62}))*(:[0-9]{1,5})?$/;

/** Load and validate the seed list (domain, url, name, description). */
export async function loadWebSeed(seedPath) {
  const doc = yaml.load(await readFile(seedPath, 'utf8'));
  const entries = doc?.entries;
  if (!Array.isArray(entries)) {
    throw new Error('web-audit seed.yaml: expected a top-level "entries" array');
  }
  const loaded = [];
  const warnings = [];
  for (const entry of entries) {
    if (!entry?.domain || !DOMAIN_RE.test(entry.domain)) {
      warnings.push(`web seed entry has an invalid domain: ${JSON.stringify(entry?.domain)} — skipped`);
      continue;
    }
    if (!entry.url || !entry.name) {
      warnings.push(`web seed "${entry.domain}" missing url or name — skipped`);
      continue;
    }
    loaded.push({
      domain: entry.domain,
      url: entry.url,
      name: entry.name,
      description: entry.description ?? '',
    });
  }
  return { entries: loaded, warnings };
}

/**
 * Emit dist/_internal/web-seed.json from a preloaded seed.
 *
 * @param {{ distDir: string, seed: { entries: Array, warnings: string[] } }} args
 * @returns {Promise<{ entryCount: number, warnings: string[] }>}
 */
export async function emitWebSeedProjection({ distDir, seed }) {
  await mkdir(join(distDir, '_internal'), { recursive: true });
  await writeFile(join(distDir, '_internal', 'web-seed.json'), `${JSON.stringify(seed.entries, null, 2)}\n`);
  return { entryCount: seed.entries.length, warnings: seed.warnings };
}
