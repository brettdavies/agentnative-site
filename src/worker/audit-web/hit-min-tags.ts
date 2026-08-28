// HIT-min Cache-Tag vocabulary. Shared by applyHeaders (stamp) and
// purge callers (evict) so a write cannot purge a tag the response
// never carried.

export function homeTag(): string {
  return 'home';
}

export function webTag(): string {
  return 'web';
}

export function webDomainTag(domain: string): string {
  return `web:${domain}`;
}
