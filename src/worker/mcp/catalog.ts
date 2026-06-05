// MCP catalog loader. Reads `dist/_internal/mcp-catalog.json` via the
// ASSETS binding — the build pipeline writes that file in stage 11
// (src/build/11-mcp-catalog.mjs). The Worker's /_internal/ interceptor
// (src/worker/index.ts) hard-404s public requests; this loader fetches
// through env.ASSETS.fetch which bypasses the interceptor by not re-
// entering dispatch.
//
// Cache scope is per-isolate / per-build: catalog bytes are immutable
// inside a deployed Worker version. A fresh deploy ships a new bundle
// with a new isolate; the in-module cache is the right lifetime. Tests
// reset via resetCatalogCacheForTests().

export interface CatalogRegistryEntry {
  slug: string;
  name: string;
  binary: string;
  install: string;
  audit_profile?: string;
  repo?: string;
  version?: string;
  anc_version?: string;
  scorecard_url?: string;
  score_pct?: number;
}

export interface CatalogPrincipleRequirement {
  id: string;
  level: string;
  summary: string;
  audit_ids: string[];
}

export interface CatalogPrinciple {
  n: number;
  slug: string;
  title: string;
  body_markdown: string;
  requirements: CatalogPrincipleRequirement[];
}

export interface CatalogSpecSection {
  slug: string;
  title: string;
  level: number;
  parent_slug: string | null;
  body_markdown: string;
}

export interface Catalog {
  generated_at: string;
  spec_version: string;
  registry: CatalogRegistryEntry[];
  principles: CatalogPrinciple[];
  spec_sections: CatalogSpecSection[];
}

const CATALOG_PATH = '/_internal/mcp-catalog.json';

export interface CatalogEnv {
  ASSETS: Fetcher;
}

let cached: { env: CatalogEnv; catalog: Catalog } | null = null;

export async function loadCatalog(env: CatalogEnv): Promise<Catalog> {
  if (cached && cached.env === env) return cached.catalog;
  const res = await env.ASSETS.fetch(new Request(`https://assets.internal${CATALOG_PATH}`));
  if (!res.ok) {
    throw new Error(`mcp catalog fetch failed: ${res.status} ${res.statusText}`);
  }
  const catalog = (await res.json()) as Catalog;
  cached = { env, catalog };
  return catalog;
}

export function resetCatalogCacheForTests(): void {
  cached = null;
}
