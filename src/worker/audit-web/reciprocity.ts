// Control-bound reciprocity: whether the host serving a declared MCP
// endpoint publishes an artifact naming it, which is the only thing that
// lets the auditor send that endpoint a wire probe. A site can declare any
// URL, so a declaration alone admits nothing.
//
// Three artifacts count, each read from a fixed location on the
// endpoint's own host: a SEP-2127 card at <endpoint> + card suffix, an
// entry in that host's AI catalog (never the audited site's), and RFC 9728
// protected-resource metadata. Each must name the endpoint exactly after
// RFC 3986 syntax normalization, so an artifact naming one path admits no
// other path, scheme, or port. A 405, an Allow header, or a JSON-RPC
// envelope is what any POST-only route answers, so none of them admits.

import type { ProbeResponse } from './assert';
import {
  cardShape,
  cardSuffixUrl,
  catalogCardEntries,
  isJsonObject,
  type JsonObject,
  MCP_SERVER_CARD_TYPE,
  parseJsonObject,
} from './discovery-documents';
import { resolveUrl } from './handlers/shared';
import { hostOf } from './provenance';
import type { WebAuditDiscoveryConfig } from './registry';
import { DOCUMENT_MAX_BODY_BYTES, METADATA_MAX_BODY_BYTES, validatePublicUrl } from './ssrf';

export type AdmittedBy = 'card' | 'ai-catalog' | 'metadata';

export interface ArtifactReadOptions {
  maxBodyBytes: number;
  accept?: string;
}

/** Where reciprocity reads its artifacts; the caller owns timeouts, caps, budgets, and redirects. */
export interface ArtifactSource {
  get(url: string, opts: ArtifactReadOptions): Promise<ProbeResponse>;
  /** Records a location the resolver will not request, with the reason. */
  decline(url: string, why: string): void;
}

const PROTECTED_RESOURCE_PATH = '/.well-known/oauth-protected-resource';
// A path no real resource lives at: metadata naming it as its resource
// was generated from the request, not published for an endpoint.
const ECHO_PROBE_PATH = '/anc-web-audit-no-such-resource';

/**
 * RFC 3986 syntax normalization: lowercase scheme, punycoded host, default
 * port dropped, an empty path read as `/`, fragment dropped. Null when the
 * value is not an absolute URL.
 */
export function normalizeEndpointUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

export function sameHost(a: string, b: string): boolean {
  const host = hostOf(a);
  return host !== null && host === hostOf(b);
}

function cardNamesEndpoint(card: JsonObject | null, cardUrl: string, endpoint: string): boolean {
  if (card === null || cardShape(card) !== 'sep-2127' || !Array.isArray(card.remotes)) return false;
  return card.remotes.some(
    (remote) =>
      isJsonObject(remote) &&
      typeof remote.url === 'string' &&
      normalizeEndpointUrl(resolveUrl(cardUrl, remote.url)) === endpoint,
  );
}

const cardRead = { maxBodyBytes: DOCUMENT_MAX_BODY_BYTES, accept: MCP_SERVER_CARD_TYPE };

async function readsAsCardNaming(source: ArtifactSource, url: string, endpoint: string): Promise<boolean> {
  const response = await source.get(url, cardRead);
  return response.status === 200 && cardNamesEndpoint(parseJsonObject(response), url, endpoint);
}

async function hostCatalogNames(source: ArtifactSource, endpoint: string, catalogPath: string): Promise<boolean> {
  const catalogUrl = resolveUrl(new URL(endpoint).origin, catalogPath);
  const response = await source.get(catalogUrl, { maxBodyBytes: DOCUMENT_MAX_BODY_BYTES });
  const catalog = response.status === 200 ? parseJsonObject(response) : null;
  for (const entry of catalog === null ? [] : catalogCardEntries(catalog)) {
    if ('data' in entry) {
      if (cardNamesEndpoint(entry.data, catalogUrl, endpoint)) return true;
    } else if ('url' in entry) {
      const cardUrl = resolveUrl(catalogUrl, entry.url);
      if (!sameHost(cardUrl, endpoint)) {
        source.decline(cardUrl, 'catalog card on another host');
      } else if (await readsAsCardNaming(source, cardUrl, endpoint)) {
        return true;
      }
    }
  }
  return false;
}

/** RFC 9728 §3.1: the path-suffixed well-known location, then the root one. */
export function protectedResourceMetadataUrls(endpoint: string): string[] {
  const u = new URL(endpoint);
  const path = u.pathname === '/' ? '' : u.pathname;
  const suffixed = `${u.origin}${PROTECTED_RESOURCE_PATH}${path}${u.search}`;
  const root = `${u.origin}${PROTECTED_RESOURCE_PATH}`;
  return suffixed === root ? [root] : [suffixed, root];
}

/** The `resource_metadata` URL a `WWW-Authenticate` challenge names, as written. */
export function resourceMetadataFromChallenge(challenge: string | undefined): string | null {
  const match = challenge?.match(/(?:^|[\s,])resource_metadata\s*=\s*(?:"([^"]*)"|([^\s,]+))/i);
  return match ? (match[1] ?? match[2] ?? null) : null;
}

/** RFC 9728 metadata naming an endpoint, and where it was read. */
export type MetadataMatch = { url: string; metadata: JsonObject };

async function readMetadata(source: ArtifactSource, url: string): Promise<JsonObject | null> {
  const response = await source.get(url, { maxBodyBytes: METADATA_MAX_BODY_BYTES });
  return response.status === 200 ? parseJsonObject(response) : null;
}

function resourceOf(metadata: JsonObject | null): string | null {
  return typeof metadata?.resource === 'string' ? normalizeEndpointUrl(metadata.resource) : null;
}

/**
 * The metadata URL a challenge names: undefined when it names none, null
 * when it names one the auditor will not read. It must be https, public,
 * and on the endpoint's own host; anywhere else is a host nothing vouched for.
 */
function challengeMetadataUrl(source: ArtifactSource, endpoint: string, challenge: string): string | null | undefined {
  const raw = resourceMetadataFromChallenge(challenge);
  if (raw === null) return undefined;
  const validated = validatePublicUrl(raw);
  if (!validated.ok) {
    source.decline(raw, validated.reason);
    return null;
  }
  if (validated.url.protocol !== 'https:' || !sameHost(raw, endpoint)) {
    source.decline(raw, 'metadata URL is not https on the endpoint host');
    return null;
  }
  return raw;
}

/**
 * Whether the nonsense-path metadata read rules out a gateway that echoes
 * any requested path: it must have answered, below 500, without naming
 * that path. A read that failed, timed out, ran out of budget, or hit a
 * server error leaves the echo unchecked, so it confirms nothing.
 */
async function echoRuledOut(source: ArtifactSource, origin: string): Promise<boolean> {
  const response = await source.get(`${origin}${PROTECTED_RESOURCE_PATH}${ECHO_PROBE_PATH}`, {
    maxBodyBytes: METADATA_MAX_BODY_BYTES,
  });
  if (response.status === null || response.status >= 500) return false;
  const echoed = response.status === 200 ? resourceOf(parseJsonObject(response)) : null;
  return echoed !== normalizeEndpointUrl(`${origin}${ECHO_PROBE_PATH}`);
}

/**
 * Resolves RFC 9728 metadata for `endpoint` in order: the challenge's
 * `resource_metadata` URL when the endpoint sent one, else the
 * path-suffixed well-known location, then the root one. It matches only
 * when its `resource` normalizes to the endpoint. For an endpoint below the
 * root, metadata at a nonsense path must answer without echoing that path
 * back: a gateway that generates metadata for any requested path confirms
 * nothing.
 */
export async function resolveProtectedResourceMetadata(
  endpoint: string,
  source: ArtifactSource,
  challenge?: string,
): Promise<MetadataMatch | null> {
  const fromChallenge = challenge === undefined ? undefined : challengeMetadataUrl(source, endpoint, challenge);
  if (fromChallenge === null) return null;
  let found: MetadataMatch | null = null;
  for (const url of fromChallenge !== undefined ? [fromChallenge] : protectedResourceMetadataUrls(endpoint)) {
    const metadata = await readMetadata(source, url);
    if (metadata !== null) {
      found = { url, metadata };
      break;
    }
  }
  if (found === null || resourceOf(found.metadata) !== endpoint) return null;
  const { origin, pathname } = new URL(endpoint);
  if (pathname !== '/' && !(await echoRuledOut(source, origin))) return null;
  return found;
}

/** The artifact that admitted an endpoint, and the metadata when metadata is what did. */
export interface Admission {
  by: AdmittedBy;
  metadata: MetadataMatch | null;
}

/**
 * The artifact that admits `endpoint` (already normalized), checked in a
 * fixed order and stopping at the first that names it; null when none does.
 */
export async function admittingArtifact(
  endpoint: string,
  cfg: Pick<WebAuditDiscoveryConfig, 'ai_catalog' | 'card_suffix'>,
  source: ArtifactSource,
  challenge?: string,
): Promise<Admission | null> {
  if (await readsAsCardNaming(source, cardSuffixUrl(endpoint, cfg.card_suffix), endpoint)) {
    return { by: 'card', metadata: null };
  }
  if (await hostCatalogNames(source, endpoint, cfg.ai_catalog)) return { by: 'ai-catalog', metadata: null };
  const metadata = await resolveProtectedResourceMetadata(endpoint, source, challenge);
  return metadata === null ? null : { by: 'metadata', metadata };
}
