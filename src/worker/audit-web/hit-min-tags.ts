// HIT-min Cache-Tag vocabulary. Shared by applyHeaders (stamp) and
// purge callers (evict) so a write cannot purge a tag the response
// never carried.

import type { Lane } from '../../shared/audit-routes';

/** The homepage and the leaderboard inject the same aggregate, so they share one tag. */
export function homeTag(): string {
  return 'home';
}

export function webTag(): string {
  return 'web';
}

export function webDomainTag(domain: string): string {
  return `web:${domain}`;
}

/** The tag every representation of a CLI result carries; the Durable Object purges it after its write. */
export function cliTargetTag(target: string): string {
  return `cli:${target}`;
}

/** The tag every representation of a live result carries, keyed by the lane its writer purges under. */
export function resultTag(lane: Lane, target: string): string {
  return lane === 'web' ? webDomainTag(target) : cliTargetTag(target);
}
