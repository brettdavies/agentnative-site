// Web-audit registry loader + shared types (plan U1/U5). Reads
// dist/_internal/web-audit-registry.json via the ASSETS binding, the
// same per-isolate projection pattern as src/worker/mcp/catalog.ts. The
// /_internal/ interceptor hard-404s public requests; this loader fetches
// through env.ASSETS.fetch which bypasses the interceptor by not
// re-entering dispatch.

export type WebCheckKeyword = 'must' | 'should' | 'may';
export type WebCheckTier = 'required' | 'recommended' | 'optional';
export type WebCheckHandler =
  | 'http'
  | 'cors-preflight'
  | 'mcp'
  | 'dns-doh'
  | 'auth-md'
  | 'webmcp'
  | 'scoped-llms'
  | 'markdown-frontmatter'
  | 'content-without-js'
  | 'llms-txt-quality'
  | 'api-hygiene'
  | 'protected-resource';

/** Declared audit site type (the entry-point argument). */
export type WebSiteType = 'content' | 'api';
/** Per-check site-type filter values ('mcp' auto-applies on discovery). */
export type WebCheckSiteType = 'content' | 'api' | 'mcp' | 'all';

export type AntecedentToken =
  | 'none'
  | 'http-root'
  | 'html-root'
  | 'mcp-present'
  | 'mcp-auth'
  | 'mcp-session'
  | 'mcp-auth-required'
  | 'mcp-resources'
  | 'api-surface'
  | 'schemas-ref'
  | 'docs-site'
  | 'root-llms-txt'
  | 'root-llms-full-txt'
  | 'markdown-twin'
  | 'robots-present'
  | 'auth-present';

export type WebCheckEvalRule = 'legacy-alias-redirects' | 'scoped-discovery' | 'retained-document' | 'api-description';

export interface WebCheck {
  id: string;
  category: string;
  tier: WebCheckTier;
  keyword: WebCheckKeyword;
  principle: string;
  site_types: WebCheckSiteType[];
  antecedent: AntecedentToken;
  eval?: WebCheckEvalRule;
  weight: number;
  title: string;
  hint: string;
  handler: WebCheckHandler;
  /** MCP checks only: the key of `mcp_lanes` the row groups under on the result page. */
  lane?: string;
  with: Record<string, unknown>;
}

/** One site design in a group of alternatives. */
export interface WebAlternativeVariant {
  /** The checks gated on these tokens form the variant; empty for a design with no checks of its own. */
  antecedents: AntecedentToken[];
  /** The variant is presented when a check gated on one of these tokens applied. */
  presented_by: AntecedentToken[];
}

/** Site designs that cannot both be satisfied at full access, whatever the audit's vantage. */
export interface WebAlternativeGroup {
  group: string;
  variants: Record<string, WebAlternativeVariant>;
}

/** One protocol lane the MCP category's rows group under, keyed by lane id. */
export interface McpLaneSpec {
  label: string;
  note: string;
}

export interface WebAuditDiscoveryConfig {
  /** The AI catalog whose MCP server-card entries discovery reads first. */
  ai_catalog: string;
  /** Appended to a streamable-HTTP endpoint to locate that endpoint's own server card. */
  card_suffix: string;
  well_known: string[];
  common_paths: string[];
  protocol_version: string;
}

export interface WebAuditRegistry {
  version: number;
  mcp_discovery: WebAuditDiscoveryConfig;
  category_order: string[];
  categories: Record<string, string>;
  /** Display order is key order. */
  mcp_lanes?: Record<string, McpLaneSpec>;
  /** Absent reads as no alternatives: every check counts in the global universe. */
  alternatives?: WebAlternativeGroup[];
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

/**
 * The version of what the follow phase reaches and how it scores what it
 * finds. The fingerprint hashes it beside the registry, so a release that
 * changes the follow policy without touching the registry still reflows the
 * curated seeds; raise it with any such change.
 */
export const FOLLOW_POLICY_VERSION = 1;

/**
 * Registry fields no stored scorecard depends on.
 *
 * The fingerprint answers one question: could this registry produce a
 * different scorecard than the cached ones? A field no audit consumes cannot,
 * and hashing it spends the whole audit budget re-deriving identical evidence
 * across every seeded domain. `breadcrumb` labels a check's own page in the
 * site's URL trail; its only reader is the build that emits those pages.
 * `lane` and the `mcp_lanes` map group MCP rows on the result page, read from
 * the live registry at render time, so a stored scorecard picks up a lane
 * change on its next render without a re-audit.
 *
 * Membership here is a claim that the field is build-only or read from the
 * live registry at render time, never copied into a stored scorecard.
 * Anything absent from this set counts as scoring shape, so a new field
 * reflows until someone establishes otherwise.
 */
const SITE_ONLY_REGISTRY_FIELDS: ReadonlySet<string> = new Set(['breadcrumb', 'lane', 'mcp_lanes']);

/**
 * SHA-256 hex of the normalized registry minus its site-only fields, beside
 * the follow policy version. The follow kill switch is not an input: the
 * rescore gate records it separately, so staging and production, whose
 * switches differ, still agree on the registry a score was computed under.
 */
export async function registryFingerprint(
  registry: WebAuditRegistry,
  followPolicyVersion: number = FOLLOW_POLICY_VERSION,
): Promise<string> {
  // A replacer rather than a rebuilt object: it drops the named keys while
  // leaving every surviving key in its original order, so the digest stays
  // stable across runs.
  const shape = JSON.stringify({ follow_policy: followPolicyVersion, registry }, (key, value) =>
    SITE_ONLY_REGISTRY_FIELDS.has(key) ? undefined : value,
  );
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(shape));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

const FINGERPRINT_PREFIX_LENGTH = 12;
const FINGERPRINT_PREFIX_RE = /^[0-9a-f]{12}$/;

/** The part of a fingerprint a scorecard records: its first 12 characters. */
export function fingerprintPrefix(fingerprint: string): string {
  return fingerprint.slice(0, FINGERPRINT_PREFIX_LENGTH);
}

/** The prefix a scorecard scored under `registry` records. */
export async function registryFingerprintPrefix(registry: WebAuditRegistry): Promise<string> {
  return fingerprintPrefix(await registryFingerprint(registry));
}

/** Whether `value` is a recorded fingerprint prefix; anything else reads as an unknown registry version. */
export function isRegistryFingerprintPrefix(value: unknown): value is string {
  return typeof value === 'string' && FINGERPRINT_PREFIX_RE.test(value);
}

/**
 * `scorecard` with the prefix of the registry it was scored under. Every
 * path that saves an audit stamps it after the engine returns, and the
 * engine never does, so the conformance goldens carry no fingerprint.
 */
export async function withRegistryFingerprint<T extends object>(
  scorecard: T,
  registry: WebAuditRegistry,
): Promise<T & { registry_fingerprint: string }> {
  return { ...scorecard, registry_fingerprint: await registryFingerprintPrefix(registry) };
}
