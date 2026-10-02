// Whether an MCP endpoint requires sign-in. Any route can answer 401, so a
// 401 alone is refusal evidence. An endpoint requires sign-in when a wire
// probe drew a 401 from it and RFC 9728 metadata on its own host names it
// as the protected resource, resolved by reciprocity.ts with the echo
// control that keeps a gateway minting metadata for any path from
// confirming anything. Metadata the audit already read while finding or
// admitting the endpoint is not read again.

import type { ProbeResponse } from './assert';
import { handshakeServed } from './handlers/mcp';
import type { McpAuthRequired, ProbeOutcome } from './handlers/types';
import {
  type ArtifactSource,
  type MetadataMatch,
  normalizeEndpointUrl,
  resolveProtectedResourceMetadata,
  resourceMetadataFromChallenge,
} from './reciprocity';
import { type GuardedFetchOptions, guardedFetch } from './ssrf';

/** The wave-1 wire probes whose answer decides it, in the order a 401's challenge is read, with the lane each asks on. */
const WIRE_PROBES = [
  { id: 'mcp-initialize', lane: 'legacy' },
  { id: 'mcp-server-discover', lane: 'modern' },
] as const satisfies ReadonlyArray<{ id: string; lane: McpAuthRequired['lane'] }>;

/** A 401 the endpoint answered, with the challenge it carried and the handshake lane that drew it. */
export interface SignInChallenge {
  challenge: string | null;
  lane: McpAuthRequired['lane'];
}

/** A wave-1 wire probe was served a JSON-RPC result: the endpoint answered a request that carried no token. */
export function servedWithoutSignIn(sources: ReadonlyMap<string, ProbeOutcome>): boolean {
  return WIRE_PROBES.some(({ id }) => handshakeServed(sources.get(id)));
}

/**
 * Where metadata is read outside the follow slice: one GET per location,
 * redirects disabled, under the timeout `timeout` hands out. Once it hands
 * out null, nothing more is sent.
 */
export function directArtifactSource(
  timeout: () => number | null,
  fetchOptions?: Pick<GuardedFetchOptions, 'fetchImpl' | 'maxRedirects'>,
): ArtifactSource {
  return {
    get: async (url, read) => {
      const timeoutMs = timeout();
      if (timeoutMs === null) return { status: null, headers: {}, body: '', error: 'budget spent' };
      return guardedFetch(url, read.accept === undefined ? {} : { headers: { accept: read.accept } }, {
        ...fetchOptions,
        timeoutMs,
        maxBodyBytes: read.maxBodyBytes,
        followRedirects: false,
      });
    },
    decline: () => {},
  };
}

/** A common path whose discovery POST drew a 401, with the challenge it carried. */
export interface ChallengedPath {
  path: string;
  url: string;
  /** Which discovery POST drew the 401. */
  probed: 'initialize' | 'modern-tools-list';
  challenge: string | null;
}

/** A source that sends each read once, so challenged paths on one host share their root and echo reads. */
function readingOnce(source: ArtifactSource): ArtifactSource {
  const reads = new Map<string, Promise<ProbeResponse>>();
  return {
    get: (url, read) => {
      const key = `${read.maxBodyBytes} ${read.accept ?? ''} ${url}`;
      let pending = reads.get(key);
      if (pending === undefined) {
        pending = source.get(url, read);
        reads.set(key, pending);
      }
      return pending;
    },
    decline: (url, why) => source.decline(url, why),
  };
}

/** The first challenged path, in probe order, whose own metadata names it; null when none does. */
export async function signInEndpoint(
  challenged: readonly ChallengedPath[],
  source: ArtifactSource,
): Promise<{ path: ChallengedPath; metadata: MetadataMatch; challenge: SignInChallenge } | null> {
  const once = readingOnce(source);
  for (const path of challenged) {
    const metadata = await resolveProtectedResourceMetadata(path.url, once, path.challenge ?? undefined);
    if (metadata !== null) {
      const lane = path.probed === 'initialize' ? 'legacy' : 'modern';
      return { path, metadata, challenge: { challenge: path.challenge, lane } };
    }
  }
  return null;
}

/** The 401 a wave-1 wire probe drew from the endpoint; null when none did. */
function wireChallenge(sources: ReadonlyMap<string, ProbeOutcome>): SignInChallenge | null {
  for (const { id, lane } of WIRE_PROBES) {
    const outcome = sources.get(id);
    const first = outcome?.evidence[0];
    if (outcome !== undefined && outcome.status !== 'error' && first?.status === 401) {
      return { challenge: typeof first.www_authenticate === 'string' ? first.www_authenticate : null, lane };
    }
  }
  return null;
}

/**
 * Whether the endpoint of record requires sign-in, once wave 1 has probed
 * it. Known metadata stands unless the 401's challenge names another
 * location, which then takes precedence the way RFC 9728 orders them.
 *
 * Wave 1's 401 is read first. When neither wire probe drew one, nor was
 * served a result, the 401 that discovery drew while finding the endpoint
 * still stands: a timeout, a rate limit, or a server error on the
 * handshake says nothing about whether the endpoint requires sign-in.
 */
export async function settleMcpAuth(input: {
  endpoint: string | null;
  /** Metadata naming the endpoint that finding or admitting it already read. */
  known: MetadataMatch | null;
  /** The 401 discovery drew from the endpoint while finding it; null when it found the endpoint another way. */
  observed: SignInChallenge | null;
  sources: ReadonlyMap<string, ProbeOutcome>;
  source: ArtifactSource;
}): Promise<McpAuthRequired | null> {
  if (input.endpoint === null) return null;
  const endpoint = normalizeEndpointUrl(input.endpoint);
  if (endpoint === null) return null;
  const answer = wireChallenge(input.sources) ?? (servedWithoutSignIn(input.sources) ? null : input.observed);
  if (answer === null) return null;
  const named = answer.challenge === null ? null : resourceMetadataFromChallenge(answer.challenge);
  const match =
    input.known !== null && (named === null || named === input.known.url)
      ? input.known
      : await resolveProtectedResourceMetadata(endpoint, input.source, answer.challenge ?? undefined);
  if (match === null) return null;
  return {
    endpoint: input.endpoint,
    challenge: answer.challenge,
    lane: answer.lane,
    metadataUrl: match.url,
    metadata: match.metadata,
  };
}
