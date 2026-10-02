// MCP antecedents: whether an MCP endpoint was discovered, whether it
// challenges for auth or requires sign-in, and whether the rows that need a
// session can have one. With no endpoint, a declared host that was not
// evaluated names why.

import { hostOf } from '../../../shared/url-host';
import { advertisesResources } from '../handlers/mcp';
import { laneRefused, servedWithoutSignIn } from '../mcp-auth';
import type { AntecedentToken } from '../registry';
import {
  type AntecedentContext,
  type AntecedentResolution,
  type AntecedentResolver,
  cardDeclaresAuth,
  handshakeShowsAuthChallenge,
  noMcpEndpoint,
  sourceEvidence,
} from './context';

const NO_ENDPOINT = 'no MCP endpoint discovered';

const mcpPresent: AntecedentResolver = (ctx) => (ctx.mcpEndpoint !== null ? 'apply' : noMcpEndpoint(ctx));

const mcpAuth: AntecedentResolver = (ctx) => {
  if (ctx.mcpEndpoint === null) return noMcpEndpoint(ctx);
  return handshakeShowsAuthChallenge(ctx) || cardDeclaresAuth(ctx) ? 'apply' : 'n_a';
};

// A row that needs a session asks the server for something only a signed-in
// client receives, so on an endpoint that requires sign-in it is not
// evaluated rather than read as absent or broken. A handshake answered with
// a JSON-RPC error is a lane refusing the request, not serving it, so only
// a result shows the endpoint serves clients without a token. A lane whose
// own handshake was refused that way is not one sign-in blocks: the answer
// is definitive, so its rows run and read as they do on an open server.
function signInBlocks(ctx: AntecedentContext, lane: AntecedentContext['mcpLane']): boolean {
  if (!ctx.mcpAuth || servedWithoutSignIn(ctx.sources)) return false;
  return lane === undefined || !laneRefused(ctx.sources, lane);
}

function authRequired(endpoint: string): AntecedentResolution {
  return { outcome: 'n_a', reason: 'auth-required', host: hostOf(endpoint) ?? undefined, evidence: endpoint };
}

const mcpSession: AntecedentResolver = (ctx) => {
  if (ctx.mcpEndpoint === null) return noMcpEndpoint(ctx);
  return signInBlocks(ctx, ctx.mcpLane) ? authRequired(ctx.mcpEndpoint) : 'apply';
};

// Holds only on the endpoint's own answer, a 401 its RFC 9728 metadata
// backs, so an open server reads its sign-in rows not applicable even when
// its card documents authentication.
const mcpAuthRequired: AntecedentResolver = (ctx) => {
  if (ctx.mcpEndpoint === null) {
    const unmet = noMcpEndpoint(ctx);
    return unmet === 'n_a' ? { outcome: 'n_a', reason: 'antecedent-unmet', evidence: NO_ENDPOINT } : unmet;
  }
  return ctx.mcpAuth ? 'apply' : 'n_a';
};

// Era-neutral: legacy initialize capabilities evidence and the modern
// server/discover capability advertisement both satisfy the token, so a
// single-era server's resources-gated rows probe on the lane it offers.
// Reading resources needs a session too, and an endpoint that requires
// sign-in advertises nothing to a client without one, so a handshake that
// sign-in blocked leaves unread whether the row applies.
const mcpResources: AntecedentResolver = (ctx) => {
  const session = mcpSession(ctx);
  if (session !== 'apply' || ctx.mcpEndpoint === null) return session;
  if (
    advertisesResources(sourceEvidence(ctx, 'mcp-initialize')) ||
    advertisesResources(sourceEvidence(ctx, 'mcp-server-discover'))
  ) {
    return 'apply';
  }
  return signInBlocks(ctx, 'legacy') || signInBlocks(ctx, 'modern') ? authRequired(ctx.mcpEndpoint) : 'n_a';
};

export const mcpResolvers = {
  'mcp-present': mcpPresent,
  'mcp-auth': mcpAuth,
  'mcp-session': mcpSession,
  'mcp-auth-required': mcpAuthRequired,
  'mcp-resources': mcpResources,
} satisfies Partial<Record<AntecedentToken, AntecedentResolver>>;

export const mcpEvidence = {
  'mcp-present': NO_ENDPOINT,
  'mcp-auth': 'MCP endpoint does not challenge for auth',
  'mcp-session': NO_ENDPOINT,
  'mcp-auth-required': 'MCP endpoint does not require sign-in',
  'mcp-resources': 'neither initialize nor server/discover advertises capabilities.resources',
} satisfies Partial<Record<AntecedentToken, string>>;
