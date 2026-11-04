// Discoverability antecedents: whether robots.txt is present.

import type { AntecedentToken } from '../registry';
import { type AntecedentResolver, sourcePassed } from './context';
import type { Prerequisite } from './sources';

const robotsPresent: AntecedentResolver = (ctx) => (sourcePassed(ctx, 'robots') ? 'apply' : 'n_a');

export const discoverabilityResolvers = {
  'robots-present': robotsPresent,
} satisfies Partial<Record<AntecedentToken, AntecedentResolver>>;

export const discoverabilityPrerequisites = {
  'robots-present': ['robots'],
} satisfies Partial<Record<AntecedentToken, readonly Prerequisite[]>>;

export const discoverabilityEvidence = {
  'robots-present': 'robots.txt not present',
} satisfies Partial<Record<AntecedentToken, string>>;
