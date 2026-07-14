// Root-fetch antecedents: whether the single canonical GET / answered, and
// whether it is an HTML document.

import type { AntecedentToken } from '../registry';
import { type AntecedentResolver, rootContentType } from './context';

const none: AntecedentResolver = () => 'apply';

// A network error on the root makes dependents error/skip, not n_a.
const httpRoot: AntecedentResolver = (ctx) => (ctx.root !== null && ctx.root.status !== null ? 'apply' : 'error');

const htmlRoot: AntecedentResolver = (ctx) => {
  if (ctx.root === null || ctx.root.status === null) return 'error';
  return rootContentType(ctx).includes('text/html') ? 'apply' : 'n_a';
};

export const rootResolvers = {
  none,
  'http-root': httpRoot,
  'html-root': htmlRoot,
} satisfies Partial<Record<AntecedentToken, AntecedentResolver>>;

export const rootEvidence = {
  none: 'not applicable',
  'http-root': 'root did not answer',
  'html-root': 'root is not an HTML document',
} satisfies Partial<Record<AntecedentToken, string>>;
