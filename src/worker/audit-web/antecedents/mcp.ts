// MCP antecedents: whether an MCP endpoint was discovered, and whether it
// challenges for auth.

import type { EvidenceItem } from '../handlers/types';
import type { AntecedentToken } from '../registry';
import { type AntecedentResolver, cardDeclaresAuth, evidenceShowsAuthChallenge, sourceEvidence } from './context';

const mcpPresent: AntecedentResolver = (ctx) => (ctx.mcpEndpoint !== null ? 'apply' : 'n_a');

const mcpAuth: AntecedentResolver = (ctx) => {
  if (ctx.mcpEndpoint === null) return 'n_a';
  return evidenceShowsAuthChallenge(sourceEvidence(ctx, 'mcp-initialize')) || cardDeclaresAuth(ctx) ? 'apply' : 'n_a';
};

function advertisesResources(items: EvidenceItem[]): boolean {
  const caps = items[0]?.capabilities;
  return Array.isArray(caps) && caps.includes('resources');
}

// Era-neutral: legacy initialize capabilities evidence and the modern
// server/discover capability advertisement both satisfy the token, so a
// single-era server's resources-gated rows probe on the lane it offers.
const mcpResources: AntecedentResolver = (ctx) => {
  if (ctx.mcpEndpoint === null) return 'n_a';
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
