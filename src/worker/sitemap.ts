// GET /sitemap.xml: the build's sitemap, dated where only stored scorecards
// know the day. A curated website result takes the day its board row's
// audit ran. `/` and `/scorecards` take the later of their build date and
// the newest row their board shows, the day each page states. The `<loc>`
// list stays the build's.
//
// The file reads the same board data as the pages it dates, so it is cached
// the same way: HIT-min under the tag the board rebuild already purges.

import { SCORECARDS_PATH, scorePath } from '../shared/audit-routes';
import { shortDate } from '../shared/result-spine';
import { raiseSitemapDates } from '../shared/sitemap-entry';
import { newestScoredDay, resolveBoardEntries, type WebBoardEnv } from './audit-web/board';
import { getAggregate } from './audit-web/cache';
import { homeTag } from './audit-web/hit-min-tags';
import { applyHeaders } from './headers';
import { SPEC_VERSION } from './spec-version.gen';

export const SITEMAP_PATH = '/sitemap.xml';

export async function serveSitemap(upstream: Response, env: WebBoardEnv, request: Request): Promise<Response> {
  const [xml, board, frontpage] = await Promise.all([
    upstream.text(),
    resolveBoardEntries(env, 'all'),
    getAggregate(env, 'leaderboard-frontpage', SPEC_VERSION),
  ]);
  const days = new Map<string, string | null>([
    ['/', newestScoredDay(frontpage?.entries ?? [])],
    [SCORECARDS_PATH, newestScoredDay(board.entries)],
  ]);
  for (const row of board.entries) {
    if (row.curated) days.set(scorePath(row.domain), shortDate(row.scored_at));
  }
  const headers = new Headers(upstream.headers);
  headers.delete('etag');
  headers.delete('last-modified');
  return applyHeaders(
    new Response(
      raiseSitemapDates(xml, (pathname) => days.get(pathname) ?? null),
      {
        status: upstream.status,
        statusText: upstream.statusText,
        headers,
      },
    ),
    { request, servedMarkdown: false, pathname: SITEMAP_PATH, cache: { klass: 'hit-min', tag: homeTag() } },
  );
}
