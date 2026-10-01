// Whether an MCP endpoint requires sign-in. Any route can answer 401, so a
// 401 alone is refusal evidence. An endpoint requires sign-in when a wire
// probe drew a 401 from it and RFC 9728 metadata on its own host names it
// as the protected resource, resolved by reciprocity.ts with the echo
// control that keeps a gateway minting metadata for any path from
// confirming anything. Metadata the audit already read while finding or
// admitting the endpoint is not read again.

import type { McpAuthRequired, ProbeOutcome } from './handlers/types';
import {
  type ArtifactSource,
  type MetadataMatch,
  normalizeEndpointUrl,
  resolveProtectedResourceMetadata,
  resourceMetadataFromChallenge,
} from './reciprocity';
import { type GuardedFetchOptions, guardedFetch } from './ssrf';

/** The wave-1 wire probes whose 401 decides it, in the order their challenge is read. */
const WIRE_PROBES = ['mcp-initialize', 'mcp-server-discover'];

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
  probed: string;
  challenge: string | null;
}

/** The first challenged path, in probe order, whose own metadata names it; null when none does. */
export async function signInEndpoint(
  challenged: readonly ChallengedPath[],
  source: ArtifactSource,
): Promise<{ path: ChallengedPath; metadata: MetadataMatch } | null> {
  for (const path of challenged) {
    const resolved = await resolveProtectedResourceMetadata(path.url, source, path.challenge ?? undefined);
    if (resolved.matched) return { path, metadata: { url: resolved.url, metadata: resolved.metadata } };
  }
  return null;
}

/** The 401 a wave-1 wire probe drew from the endpoint, with the challenge it carried; null when none did. */
function wireChallenge(sources: ReadonlyMap<string, ProbeOutcome>): { challenge: string | null } | null {
  for (const id of WIRE_PROBES) {
    const outcome = sources.get(id);
    const first = outcome?.evidence[0];
    if (outcome !== undefined && outcome.status !== 'error' && first?.status === 401) {
      return { challenge: typeof first.www_authenticate === 'string' ? first.www_authenticate : null };
    }
  }
  return null;
}

/**
 * Whether the endpoint of record requires sign-in, once wave 1 has probed
 * it. Known metadata stands unless the 401's challenge names another
 * location, which then takes precedence the way RFC 9728 orders them.
 */
export async function settleMcpAuth(input: {
  endpoint: string | null;
  /** Metadata naming the endpoint that finding or admitting it already read. */
  known: MetadataMatch | null;
  sources: ReadonlyMap<string, ProbeOutcome>;
  source: ArtifactSource;
}): Promise<McpAuthRequired | null> {
  const endpoint = input.endpoint === null ? null : normalizeEndpointUrl(input.endpoint);
  if (input.endpoint === null || endpoint === null) return null;
  const answer = wireChallenge(input.sources);
  if (answer === null) return null;
  const named = answer.challenge === null ? null : resourceMetadataFromChallenge(answer.challenge);
  let match = input.known !== null && (named === null || named === input.known.url) ? input.known : null;
  if (match === null) {
    const resolved = await resolveProtectedResourceMetadata(endpoint, input.source, answer.challenge ?? undefined);
    match = resolved.matched ? { url: resolved.url, metadata: resolved.metadata } : null;
  }
  if (match === null) return null;
  return { endpoint: input.endpoint, challenge: answer.challenge, metadataUrl: match.url, metadata: match.metadata };
}
