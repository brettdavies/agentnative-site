// Auth antecedents: whether the site exposes an auth surface (an OAuth
// discovery doc, a 401 challenge anywhere in wave 1, or a card auth
// declaration).

import type { AntecedentToken } from '../registry';
import {
  type AntecedentContext,
  type AntecedentResolver,
  cardDeclaresAuth,
  evidenceShowsAuthChallenge,
  sourceEvidence,
  sourcePassed,
} from './context';

/** A 401 challenge observed anywhere in wave 1, or discovery card auth. */
function authSignalObserved(ctx: AntecedentContext): boolean {
  if (ctx.root?.status === 401) return true;
  if (evidenceShowsAuthChallenge(sourceEvidence(ctx, 'openapi'))) return true;
  if (evidenceShowsAuthChallenge(sourceEvidence(ctx, 'mcp-initialize'))) return true;
  return cardDeclaresAuth(ctx);
}

const authPresent: AntecedentResolver = (ctx) =>
  sourcePassed(ctx, 'oauth-discovery') || authSignalObserved(ctx) ? 'apply' : 'n_a';

export const authResolvers = {
  'auth-present': authPresent,
} satisfies Partial<Record<AntecedentToken, AntecedentResolver>>;

export const authEvidence = {
  'auth-present': 'no auth surface detected',
} satisfies Partial<Record<AntecedentToken, string>>;
