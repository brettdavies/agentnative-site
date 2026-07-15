// MCP antecedents: whether an MCP endpoint was discovered, and whether it
// challenges for auth.

import type { AntecedentToken } from '../registry';
import { type AntecedentResolver, cardDeclaresAuth, evidenceShowsAuthChallenge, sourceEvidence } from './context';

const mcpPresent: AntecedentResolver = (ctx) => (ctx.mcpEndpoint !== null ? 'apply' : 'n_a');

const mcpAuth: AntecedentResolver = (ctx) => {
  if (ctx.mcpEndpoint === null) return 'n_a';
  return evidenceShowsAuthChallenge(sourceEvidence(ctx, 'mcp-initialize')) || cardDeclaresAuth(ctx) ? 'apply' : 'n_a';
};

export const mcpResolvers = {
  'mcp-present': mcpPresent,
  'mcp-auth': mcpAuth,
} satisfies Partial<Record<AntecedentToken, AntecedentResolver>>;

export const mcpEvidence = {
  'mcp-present': 'no MCP endpoint discovered',
  'mcp-auth': 'MCP endpoint does not challenge for auth',
} satisfies Partial<Record<AntecedentToken, string>>;
