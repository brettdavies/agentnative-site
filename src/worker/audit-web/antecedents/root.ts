// Root-fetch antecedents: whether the single canonical GET / answered, and
// whether it is an HTML document.

import type { AntecedentToken } from '../registry';
import { type AntecedentResolver, htmlRootGate } from './context';
import type { Prerequisite } from './sources';

const none: AntecedentResolver = () => 'apply';

// A network error on the root makes dependents error/skip, not n_a.
const httpRoot: AntecedentResolver = (ctx) => (ctx.root !== null && ctx.root.status !== null ? 'apply' : 'error');

const htmlRoot: AntecedentResolver = (ctx) => htmlRootGate(ctx) ?? 'apply';

export const rootResolvers = {
  none,
  'http-root': httpRoot,
  'html-root': htmlRoot,
} satisfies Partial<Record<AntecedentToken, AntecedentResolver>>;

export const rootPrerequisites = {
  none: [],
  'http-root': [],
  'html-root': [],
} satisfies Partial<Record<AntecedentToken, readonly Prerequisite[]>>;

export const rootEvidence = {
  none: 'not applicable',
  'http-root': 'root did not answer',
  'html-root': 'root is not an HTML document',
} satisfies Partial<Record<AntecedentToken, string>>;
