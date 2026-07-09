// Web-audit registry loader + shared types (plan U1/U5). Reads
// dist/_internal/web-audit-registry.json via the ASSETS binding, the
// same per-isolate projection pattern as src/worker/mcp/catalog.ts. The
// /_internal/ interceptor hard-404s public requests; this loader fetches
// through env.ASSETS.fetch which bypasses the interceptor by not
// re-entering dispatch.

export type WebCheckKeyword = 'must' | 'should' | 'may';
export type WebCheckTier = 'required' | 'recommended' | 'optional';
export type WebCheckAppliesTo = 'any' | 'docs-site' | 'mcp-present';
export type WebCheckHandler = 'http' | 'cors-preflight' | 'mcp' | 'dns-doh';

export interface WebCheck {
  id: string;
  category: string;
  tier: WebCheckTier;
  keyword: WebCheckKeyword;
  principle: string;
  applies_to: WebCheckAppliesTo;
  weight: number;
  title: string;
  hint: string;
  handler: WebCheckHandler;
  with: Record<string, unknown>;
}

export interface WebAuditDiscoveryConfig {
  well_known: string[];
  common_paths: string[];
  protocol_version: string;
}

export interface WebAuditRegistry {
  version: number;
  mcp_discovery: WebAuditDiscoveryConfig;
  categories: Record<string, string>;
  checks: WebCheck[];
}

const REGISTRY_PATH = '/_internal/web-audit-registry.json';

export interface WebAuditRegistryEnv {
  ASSETS: Fetcher;
}

let cached: { env: WebAuditRegistryEnv; registry: WebAuditRegistry } | null = null;

export async function loadWebAuditRegistry(env: WebAuditRegistryEnv): Promise<WebAuditRegistry> {
  if (cached && cached.env === env) return cached.registry;
  const res = await env.ASSETS.fetch(new Request(`https://assets.internal${REGISTRY_PATH}`));
  if (!res.ok) {
    throw new Error(`web-audit registry fetch failed: ${res.status} ${res.statusText}`);
  }
  const registry = (await res.json()) as WebAuditRegistry;
  cached = { env, registry };
  return registry;
}

export function resetWebAuditRegistryCacheForTests(): void {
  cached = null;
}
