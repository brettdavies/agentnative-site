import { describe, expect, test } from 'bun:test';
import { resolveAntecedent } from '../src/worker/audit-web/antecedents';
import { ctx, outcome } from './web-audit-antecedents-helpers';

describe('resolveAntecedent: discoverability', () => {
  test('robots-present reuses the robots result, not a second fetch', () => {
    expect(resolveAntecedent('robots-present', ctx({ sources: new Map([['robots', outcome('pass')]]) }))).toBe('apply');
    expect(resolveAntecedent('robots-present', ctx({ sources: new Map([['robots', outcome('absent')]]) }))).toBe('n_a');
    expect(resolveAntecedent('robots-present', ctx())).toBe('n_a');
  });
});
