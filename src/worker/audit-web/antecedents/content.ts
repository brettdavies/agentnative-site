// Content antecedents: whether the site is a docs/content site, and whether
// its root llms.txt / llms-full.txt indexes are present.

import type { AntecedentToken } from '../registry';
import { type AntecedentResolver, sourcePassed } from './context';

const docsSite: AntecedentResolver = (ctx) =>
  ctx.siteType === 'content' || sourcePassed(ctx, 'llms-txt') ? 'apply' : 'n_a';

const rootLlmsTxt: AntecedentResolver = (ctx) => (sourcePassed(ctx, 'llms-txt') ? 'apply' : 'n_a');

const rootLlmsFullTxt: AntecedentResolver = (ctx) => (sourcePassed(ctx, 'llms-full-txt') ? 'apply' : 'n_a');

export const contentResolvers = {
  'docs-site': docsSite,
  'root-llms-txt': rootLlmsTxt,
  'root-llms-full-txt': rootLlmsFullTxt,
} satisfies Partial<Record<AntecedentToken, AntecedentResolver>>;

export const contentEvidence = {
  'docs-site': 'not a docs/content site',
  'root-llms-txt': 'root llms.txt not present',
  'root-llms-full-txt': 'root llms-full.txt not present',
} satisfies Partial<Record<AntecedentToken, string>>;
