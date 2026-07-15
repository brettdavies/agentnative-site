// Board aggregate rebuild: reads every seeded domain's per-domain R2
// entry and writes the two aggregate objects (leaderboard, leaderboard-
// frontpage) that all board read surfaces resolve through. Called from
// the rescore Workflow's final step (the completion barrier) and from the
// on-demand paths after a seeded domain re-scores. A concurrent single-
// domain rebuild and a batch rebuild resolve last-writer-wins; the next
// batch self-heals any interleaving.

import {
  get as cacheGet,
  canonicalTargetOf,
  keyFor,
  putAggregate,
  type WebAggregateEntry,
  type WebCacheEnv,
} from './cache';
import { isSeededDomain, loadWebSeed, type WebSeedEnv } from './seed';

export type WebAggregateEnv = WebCacheEnv & WebSeedEnv;

// Row count of the homepage web-board pane.
export const FRONTPAGE_TOP_N = 5;

type ScoreShape = { score_pct?: number; score?: { relative?: number; global?: number } };

/**
 * Rebuild both aggregates from the per-domain R2 entries. A seeded domain
 * with no cached entry (never scored, or orphaned by a SPEC_VERSION bump)
 * is omitted from the board rather than failing the rebuild.
 */
export async function rebuildWebAggregates(
  env: WebAggregateEnv,
  specVersion: string,
): Promise<{ seeded: number; scored: number }> {
  const seed = await loadWebSeed(env);
  const entries: WebAggregateEntry[] = [];
  for (const s of seed) {
    const target = canonicalTargetOf(new URL(s.url));
    const cached = await cacheGet(env, await keyFor(target, specVersion));
    if (!cached) continue;
    const scorecard = cached.scorecard as ScoreShape | null;
    if (typeof scorecard?.score_pct !== 'number') continue;
    entries.push({
      domain: s.domain,
      url: s.url,
      name: s.name,
      description: s.description,
      score_pct: scorecard.score_pct,
      score: {
        relative: scorecard.score?.relative ?? scorecard.score_pct,
        global: scorecard.score?.global ?? 0,
      },
    });
  }
  sortByGlobal(entries);
  await putAggregate(env, 'leaderboard', entries, specVersion);
  await putAggregate(env, 'leaderboard-frontpage', entries.slice(0, FRONTPAGE_TOP_N), specVersion);
  return { seeded: seed.length, scored: entries.length };
}

/**
 * Best-effort aggregate invalidation for the on-demand paths: rebuild
 * only when the just-audited domain is on the seeded board, and never
 * fail the audit response over a rebuild problem (the next batch
 * self-heals a missed rebuild).
 */
export async function rebuildAggregatesIfSeeded(
  env: WebAggregateEnv,
  domain: string,
  specVersion: string,
): Promise<void> {
  try {
    if (!(await isSeededDomain(env, domain))) return;
    await rebuildWebAggregates(env, specVersion);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(JSON.stringify({ scope: 'web-aggregate', domain, error: message }));
  }
}

// GLOBAL is the default board order; ties break by relative then domain
// (same ordering the board renderer applies).
function sortByGlobal(entries: WebAggregateEntry[]): void {
  entries.sort((a, b) => {
    const byGlobal = b.score.global - a.score.global;
    if (byGlobal !== 0) return byGlobal;
    const byRelative = b.score.relative - a.score.relative;
    if (byRelative !== 0) return byRelative;
    return a.domain.localeCompare(b.domain);
  });
}
