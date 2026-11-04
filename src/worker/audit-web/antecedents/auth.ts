// Auth antecedents: whether the site exposes an auth surface (an OAuth
// discovery doc, a 401 challenge from a source probe, or a card auth
// declaration).

import type { AntecedentToken } from '../registry';
import {
  type AntecedentContext,
  type AntecedentResolver,
  cardDeclaresAuth,
  evidenceShowsAuthChallenge,
  handshakeShowsAuthChallenge,
  ownOriginEvidence,
  sourcePassed,
} from './context';
import { MCP_SETTLED, type Prerequisite } from './sources';

/**
 * A 401 challenge a source probe observed on the audited origin or its
 * MCP endpoint, or discovery card auth. A description an API anchor
 * declares on another host speaks for that host's auth, not the site's.
 */
function authSignalObserved(ctx: AntecedentContext): boolean {
  if (ctx.root?.status === 401) return true;
  if (evidenceShowsAuthChallenge(ownOriginEvidence(ctx, 'openapi'))) return true;
  if (handshakeShowsAuthChallenge(ctx)) return true;
  return cardDeclaresAuth(ctx);
}

const authPresent: AntecedentResolver = (ctx) =>
  sourcePassed(ctx, 'oauth-discovery') || authSignalObserved(ctx) ? 'apply' : 'n_a';

export const authResolvers = {
  'auth-present': authPresent,
} satisfies Partial<Record<AntecedentToken, AntecedentResolver>>;

export const authPrerequisites = {
  'auth-present': ['oauth-discovery', 'openapi', MCP_SETTLED],
} satisfies Partial<Record<AntecedentToken, readonly Prerequisite[]>>;

export const authEvidence = {
  'auth-present': 'no auth surface detected',
} satisfies Partial<Record<AntecedentToken, string>>;
