import { isScorePath } from '../shared/audit-routes';

// A scorecard links to the site it audited with the page's full URL as the
// referrer, so a query an inbound link carried (utm_*, fbclid, gclid) would be
// handed to that site. The result routes read at most `v`, which only marks
// the response uncacheable, so no parameter here is state the page needs.
export function dropScoreQuery(): void {
  const { pathname, search, hash } = location;
  if (search === '' || !isScorePath(pathname)) return;
  history.replaceState(history.state, '', pathname + hash);
}
