// Runtime web-board seed loader. The build projects src/data/web-audit/
// seed.yaml to dist/_internal/web-seed.json (domain list only, no
// scorecards); the Worker reads it here to drive the rescore Workflow and
// the seed-membership check on on-demand audits. Module-cached per env
// like the registry loader.

export interface WebSeedEntry {
  domain: string;
  url: string;
  name: string;
  description: string;
}

export interface WebSeedEnv {
  ASSETS: Fetcher;
}

const SEED_PATH = '/_internal/web-seed.json';

let cached: { env: WebSeedEnv; entries: WebSeedEntry[] } | null = null;

export async function loadWebSeed(env: WebSeedEnv): Promise<WebSeedEntry[]> {
  if (cached && cached.env === env) return cached.entries;
  const res = await env.ASSETS.fetch(new Request(`https://assets.internal${SEED_PATH}`));
  if (!res.ok) {
    throw new Error(`web seed fetch failed: ${res.status} ${res.statusText}`);
  }
  const raw = (await res.json()) as unknown;
  if (!Array.isArray(raw)) {
    throw new Error('web seed is not an array');
  }
  const entries: WebSeedEntry[] = [];
  for (const item of raw) {
    if (!isWebSeedEntry(item)) {
      console.log(JSON.stringify({ scope: 'web-seed', error: 'malformed_entry', entry: item }));
      continue;
    }
    entries.push({ domain: item.domain, url: item.url, name: item.name, description: item.description ?? '' });
  }
  cached = { env, entries };
  return entries;
}

/** `true` when `domain` (a URL host) is on the seeded board. */
export async function isSeededDomain(env: WebSeedEnv, domain: string): Promise<boolean> {
  const entries = await loadWebSeed(env);
  return entries.some((e) => e.domain === domain);
}

function isWebSeedEntry(value: unknown): value is WebSeedEntry & { description?: string } {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.domain === 'string' &&
    obj.domain.length > 0 &&
    typeof obj.url === 'string' &&
    obj.url.length > 0 &&
    typeof obj.name === 'string' &&
    obj.name.length > 0 &&
    (obj.description === undefined || typeof obj.description === 'string')
  );
}

export function resetWebSeedCacheForTests(): void {
  cached = null;
}
