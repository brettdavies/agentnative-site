// MCP antecedents: whether an MCP endpoint was discovered, and whether it
// challenges for auth. With no endpoint, a declared host that was not
// evaluated names why.

import { advertisesResources } from '../handlers/mcp';
import type { AntecedentToken } from '../registry';
import {
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

// Era-neutral: legacy initialize capabilities evidence and the modern
// server/discover capability advertisement both satisfy the token, so a
// single-era server's resources-gated rows probe on the lane it offers.
const mcpResources: AntecedentResolver = (ctx) => {
  if (ctx.mcpEndpoint === null) return noMcpEndpoint(ctx);
  return advertisesResources(sourceEvidence(ctx, 'mcp-initialize')) ||
    advertisesResources(sourceEvidence(ctx, 'mcp-server-discover'))
    ? 'apply'
    : 'n_a';
};

export const mcpResolvers = {
  'mcp-present': mcpPresent,
  'mcp-auth': mcpAuth,
  'mcp-resources': mcpResources,
} satisfies Partial<Record<AntecedentToken, AntecedentResolver>>;

export const mcpEvidence = {
  'mcp-present': 'no MCP endpoint discovered',
  'mcp-auth': 'MCP endpoint does not challenge for auth',
  'mcp-resources': 'neither initialize nor server/discover advertises capabilities.resources',
} satisfies Partial<Record<AntecedentToken, string>>;
