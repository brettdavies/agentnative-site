// Web-scorecard surface emit (plan U10). Section 11d of the build.
//
// Reads the curated seed list (src/data/web-audit/seed.yaml) and its
// committed web scorecards (scorecards/web/<domain>.json), then emits:
//   - dist/web.html + dist/web.md            the web leaderboard page + twin
//   - dist/_internal/web-scorecards/<domain>.json   per-seed scorecard the
//     Worker's /web/<domain> route serves on an R2 miss (curated entries
//     are static + committed, independent of R2 per KTD-8).
//
// A seed entry whose scorecard is missing or malformed is excluded with a
// build warning (mirrors loadScoredTools for the CLI board), not a hard
// error, so one bad committed file can't break the whole build.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { emitShell } from './shell.mjs';
import { absolutifyMarkdownLinks } from './util.mjs';
import { buildWebLeaderboardBody, buildWebLeaderboardMarkdown } from './web-leaderboard-render.mjs';

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]{0,62})(\.[a-z0-9]([a-z0-9-]{0,62}))*(:[0-9]{1,5})?$/;

/** Load the seed list, joining each entry to its committed scorecard. */
export async function loadWebSeed(seedPath, scorecardsWebDir) {
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
    let scorecard;
    try {
      scorecard = JSON.parse(await readFile(join(scorecardsWebDir, `${entry.domain}.json`), 'utf8'));
    } catch {
      warnings.push(
        `web seed "${entry.domain}" has no committed scorecard at scorecards/web/${entry.domain}.json — excluded`,
      );
      continue;
    }
    if (typeof scorecard?.score_pct !== 'number' || typeof scorecard?.target_url !== 'string') {
      warnings.push(`web seed "${entry.domain}" scorecard is malformed (missing score_pct or target_url) — excluded`);
      continue;
    }
    loaded.push({
      domain: entry.domain,
      url: entry.url,
      name: entry.name,
      description: entry.description ?? '',
      scorecard,
    });
  }
  return { entries: loaded, warnings };
}

/**
 * Emit the web leaderboard page + per-seed scorecard projections.
 *
 * @param {{ distDir: string, seedPath: string, scorecardsWebDir: string, themeInit: string }} args
 * @returns {Promise<{ webPaths: string[], entryCount: number, warnings: string[] }>}
 */
export async function emitWebScorecardSurface({ distDir, seedPath, scorecardsWebDir, themeInit }) {
  const { entries, warnings } = await loadWebSeed(seedPath, scorecardsWebDir);
  for (const w of warnings) console.warn(`warning: ${w}`);

  // Per-seed scorecard projection the Worker reads on an R2 miss, plus an
  // index.json the list_website_audits MCP tool reads for board summaries.
  await mkdir(join(distDir, '_internal', 'web-scorecards'), { recursive: true });
  const webPaths = ['/web'];
  const index = [];
  for (const entry of entries) {
    await writeFile(
      join(distDir, '_internal', 'web-scorecards', `${entry.domain}.json`),
      `${JSON.stringify(entry.scorecard, null, 2)}\n`,
    );
    webPaths.push(`/web/${entry.domain}`);
    index.push({
      domain: entry.domain,
      url: entry.url,
      name: entry.name,
      description: entry.description,
      score_pct: entry.scorecard.score_pct,
    });
  }
  await writeFile(join(distDir, '_internal', 'web-scorecards', 'index.json'), `${JSON.stringify(index, null, 2)}\n`);

  const body = buildWebLeaderboardBody(entries);
  await writeFile(
    join(distDir, 'web.html'),
    emitShell({
      title: 'Web Agent-Readiness Leaderboard — anc.dev',
      description:
        'Agent-readiness scores for websites and their MCP servers, scored against the eight agent-native principles.',
      canonicalPath: '/web',
      bodyHtml: body,
      themeInitJs: themeInit,
    }),
  );
  await writeFile(join(distDir, 'web.md'), absolutifyMarkdownLinks(buildWebLeaderboardMarkdown(entries)));

  return { webPaths, entryCount: entries.length, warnings };
}
