// Whether an MCP endpoint requires sign-in. Any route can answer 401, so a
// 401 alone is refusal evidence. A 401 from the endpoint asks for sign-in
// when RFC 9728 metadata on its own host names the endpoint as the
// protected resource, resolved by reciprocity.ts with the echo control that
// keeps a gateway minting metadata for any path from confirming anything.
// The metadata is read once per audit, for the first 401 that needs it, and
// metadata the audit already read while finding or admitting the endpoint
// is not read again.

import type { ProbeResponse } from './assert';
import { handshakeServed } from './handlers/mcp';
import type { EvidenceItem, McpAuthRequired, ProbeOutcome } from './handlers/types';
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

/** The wave-1 wire probes' evidence, in the order a 401's challenge is read. */
export function wireProbeEvidence(sources: ReadonlyMap<string, ProbeOutcome>): EvidenceItem[] {
  return WIRE_PROBES.flatMap(({ id }) => sources.get(id)?.evidence ?? []);
}

/** A wave-1 wire probe was served a JSON-RPC result: the endpoint answered a request that carried no token. */
export function servedWithoutSignIn(sources: ReadonlyMap<string, ProbeOutcome>): boolean {
  return WIRE_PROBES.some(({ id }) => handshakeServed(sources.get(id)));
}

/**
 * The lane's own handshake read absent: the server refused the lane as one
 * it does not offer, without the 401 that asks for sign-in, so a token
 * would not open it.
 */
export function laneRefused(sources: ReadonlyMap<string, ProbeOutcome>, lane: McpAuthRequired['lane']): boolean {
  return WIRE_PROBES.some((probe) => probe.lane === lane && sources.get(probe.id)?.status === 'absent');
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
    const metadata = await resolveProtectedResourceMetadata(path.url, once, { challenge: path.challenge ?? undefined });
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

/** The endpoint of record and what reading its RFC 9728 metadata draws on. */
export interface SignInInput {
  endpoint: string | null;
  /** Metadata naming the endpoint that finding or admitting it already read. */
  known: MetadataMatch | null;
  source: ArtifactSource;
}

/** Whether a 401 the endpoint answered is backed by RFC 9728 metadata naming it; null when it is not. */
export type SignInResolver = (answer: SignInChallenge) => Promise<McpAuthRequired | null>;

/**
 * Reads the endpoint's metadata at most once per audit: the first 401 it is
 * asked about decides, and every later ask gets that answer. Known metadata
 * stands unless the 401's challenge names another location, which then
 * takes precedence the way RFC 9728 orders them.
 */
export function signInResolver(input: SignInInput): SignInResolver {
  let settled: Promise<McpAuthRequired | null> | undefined;
  return (answer) => {
    settled ??= backedSignIn(input, answer);
    return settled;
  };
}

async function backedSignIn(input: SignInInput, answer: SignInChallenge): Promise<McpAuthRequired | null> {
  if (input.endpoint === null) return null;
  const endpoint = normalizeEndpointUrl(input.endpoint);
  if (endpoint === null) return null;
  const named = answer.challenge === null ? null : resourceMetadataFromChallenge(answer.challenge);
  const match =
    input.known !== null && (named === null || named === input.known.url)
      ? input.known
      : await resolveProtectedResourceMetadata(endpoint, input.source, {
          challenge: answer.challenge ?? undefined,
          ofRecord: true,
        });
  if (match === null) return null;
  return {
    endpoint: input.endpoint,
    challenge: answer.challenge,
    lane: answer.lane,
    metadataUrl: match.url,
    metadata: match.metadata,
  };
}

/**
 * Whether the endpoint of record requires sign-in, once wave 1 has probed
 * it. Wave 1's 401 is read first. When neither wire probe drew one, nor was
 * served a result, the 401 that discovery drew while finding the endpoint
 * still stands: a timeout, a rate limit, or a server error on the
 * handshake says nothing about whether the endpoint requires sign-in.
 */
export async function settleMcpAuth(input: {
  /** The 401 discovery drew from the endpoint while finding it; null when it found the endpoint another way. */
  observed: SignInChallenge | null;
  sources: ReadonlyMap<string, ProbeOutcome>;
  signIn: SignInResolver;
}): Promise<McpAuthRequired | null> {
  const answer = wireChallenge(input.sources) ?? (servedWithoutSignIn(input.sources) ? null : input.observed);
  return answer === null ? null : input.signIn(answer);
}
