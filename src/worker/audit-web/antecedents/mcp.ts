// MCP antecedents: whether an MCP endpoint was discovered, whether it
// challenges for auth, and whether the rows that need a session can have
// one. With no endpoint, a declared host that was not evaluated names why.

import { advertisesResources } from '../handlers/mcp';
import { hostOf } from '../provenance';
import type { AntecedentToken } from '../registry';
import {
  type AntecedentContext,
  type AntecedentResolver,
  cardDeclaresAuth,
  evidenceShowsAuthChallenge,
  noMcpEndpoint,
  sourceEvidence,
} from './context';

const mcpPresent: AntecedentResolver = (ctx) => (ctx.mcpEndpoint !== null ? 'apply' : noMcpEndpoint(ctx));

const mcpAuth: AntecedentResolver = (ctx) => {
  if (ctx.mcpEndpoint === null) return noMcpEndpoint(ctx);
  return evidenceShowsAuthChallenge(sourceEvidence(ctx, 'mcp-initialize')) || cardDeclaresAuth(ctx) ? 'apply' : 'n_a';
};

/** A wave-1 wire probe got a 2xx answer: the endpoint served a request that carried no token. */
function answeredWithoutSignIn(ctx: AntecedentContext): boolean {
  return ['mcp-initialize', 'mcp-server-discover'].some((id) => {
    const status = sourceEvidence(ctx, id)[0]?.status;
    return typeof status === 'number' && status >= 200 && status < 300;
  });
}

// A row that needs a session asks the server for something only a signed-in
// client receives, so on an endpoint that requires sign-in it is not
// evaluated rather than read as absent or broken.
const mcpSession: AntecedentResolver = (ctx) => {
  if (ctx.mcpEndpoint === null) return noMcpEndpoint(ctx);
  if (!ctx.mcpAuth || answeredWithoutSignIn(ctx)) return 'apply';
  return {
    outcome: 'n_a',
    reason: 'auth-required',
    host: hostOf(ctx.mcpEndpoint) ?? undefined,
    evidence: ctx.mcpEndpoint,
  };
};

// Era-neutral: legacy initialize capabilities evidence and the modern
// server/discover capability advertisement both satisfy the token, so a
// single-era server's resources-gated rows probe on the lane it offers.
// Reading resources needs a session too, and an endpoint that requires
// sign-in advertises nothing to a client without one.
const mcpResources: AntecedentResolver = (ctx) => {
  const session = mcpSession(ctx);
  if (session !== 'apply') return session;
  return advertisesResources(sourceEvidence(ctx, 'mcp-initialize')) ||
    advertisesResources(sourceEvidence(ctx, 'mcp-server-discover'))
    ? 'apply'
    : 'n_a';
};

export const mcpResolvers = {
  'mcp-present': mcpPresent,
  'mcp-auth': mcpAuth,
  'mcp-session': mcpSession,
  'mcp-resources': mcpResources,
} satisfies Partial<Record<AntecedentToken, AntecedentResolver>>;

export const mcpEvidence = {
  'mcp-present': 'no MCP endpoint discovered',
  'mcp-auth': 'MCP endpoint does not challenge for auth',
  'mcp-session': 'no MCP endpoint discovered',
  'mcp-resources': 'neither initialize nor server/discover advertises capabilities.resources',
} satisfies Partial<Record<AntecedentToken, string>>;
