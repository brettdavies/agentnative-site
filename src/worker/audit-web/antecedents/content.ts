// Content antecedents: whether the site is a docs/content site, and whether
// its root llms.txt / llms-full.txt indexes are present.

import type { AntecedentToken } from '../registry';
import { type AntecedentResolver, htmlRootGate, sourcePassed } from './context';

const docsSite: AntecedentResolver = (ctx) =>
  ctx.siteType === 'content' || sourcePassed(ctx, 'llms-txt') ? 'apply' : 'n_a';

const rootLlmsTxt: AntecedentResolver = (ctx) => (sourcePassed(ctx, 'llms-txt') ? 'apply' : 'n_a');

const rootLlmsFullTxt: AntecedentResolver = (ctx) => (sourcePassed(ctx, 'llms-full-txt') ? 'apply' : 'n_a');

// A markdown twin is an affordance of an HTML page: a non-HTML root has no
// twin to serve, and a root that never answered gates dependents to error.
const markdownTwin: AntecedentResolver = (ctx) => {
  const gate = htmlRootGate(ctx);
  if (gate) return gate;
  const link = ctx.root?.headers.link ?? '';
  const advertisesMdAlternate = /rel=["']?alternate["']?/i.test(link) && /text\/markdown/i.test(link);
  return sourcePassed(ctx, 'accept-markdown') || sourcePassed(ctx, 'llms-txt') || advertisesMdAlternate
    ? 'apply'
    : 'n_a';
};

export const contentResolvers = {
  'docs-site': docsSite,
  'root-llms-txt': rootLlmsTxt,
  'root-llms-full-txt': rootLlmsFullTxt,
  'markdown-twin': markdownTwin,
} satisfies Partial<Record<AntecedentToken, AntecedentResolver>>;

export const contentEvidence = {
  'docs-site': 'not a docs/content site',
  'root-llms-txt': 'root llms.txt not present',
  'root-llms-full-txt': 'root llms-full.txt not present',
  'markdown-twin':
    'site exposes no markdown twin (no text/markdown negotiation, no markdown alternate link, no llms.txt)',
} satisfies Partial<Record<AntecedentToken, string>>;
