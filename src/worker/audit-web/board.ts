// The website board's rows, resolved once for every surface that renders
// them: the merged leaderboard, its markdown twin, and the homepage board
// inject. The opt-in gate sits here, upstream of all renderers, so no two
// surfaces can disagree on which non-curated rows list. Curated rows come
// from the aggregate and never pass through that gate.

import { SPEC_VERSION } from '../spec-version.gen';
import { getAggregate, isBoardListable, listAllWebAudits, type WebCacheEnv } from './cache';
import type { WebBoardEntry, WebBoardView } from './leaderboard-render';
import { boardExcludeDomains } from './seed';

export interface WebBoardEnv extends WebCacheEnv {
  ASSETS: Fetcher;
}

export async function resolveBoardEntries(
  env: WebBoardEnv,
  view: WebBoardView,
): Promise<{ entries: WebBoardEntry[]; curatedCount: number; userCount: number }> {
  const aggregate = await getAggregate(env, 'leaderboard', SPEC_VERSION);
  const curatedEntries: WebBoardEntry[] = (aggregate?.entries ?? []).map((e) => ({ ...e, curated: true }));
  if (view !== 'all') {
    return { entries: curatedEntries, curatedCount: curatedEntries.length, userCount: 0 };
  }

  const excludeDomains = await boardExcludeDomains(
    env,
    curatedEntries.map((e) => e.domain),
  );
  const userSubmitted = (await listAllWebAudits(env, { specVersion: SPEC_VERSION, excludeDomains })).filter(
    isBoardListable,
  );
  const userEntries: WebBoardEntry[] = userSubmitted.map((l) => ({
    domain: l.domain,
    url: `https://${l.domain}/`,
    name: l.name,
    description: '',
    score_pct: l.score_pct,
    score: l.score,
    curated: false,
  }));
  return {
    entries: curatedEntries.concat(userEntries),
    curatedCount: curatedEntries.length,
    userCount: userEntries.length,
  };
}
