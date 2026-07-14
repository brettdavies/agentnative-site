import { describe, expect, test } from 'bun:test';
import { resolveAntecedent } from '../src/worker/audit-web/antecedents';
import { ctx, outcome } from './web-audit-antecedents-helpers';

describe('resolveAntecedent: content', () => {
  test('docs-site holds for a declared content type or a present root llms.txt', () => {
    expect(resolveAntecedent('docs-site', ctx({ siteType: 'content' }))).toBe('apply');
    const llmsPass = ctx({ sources: new Map([['llms-txt', outcome('pass')]]) });
    expect(resolveAntecedent('docs-site', llmsPass)).toBe('apply');
    expect(resolveAntecedent('docs-site', ctx({ siteType: 'api' }))).toBe('n_a');
  });

  test('root-llms-txt / root-llms-full-txt reuse the wave-1 probe results', () => {
    const sources = new Map([
      ['llms-txt', outcome('pass')],
      ['llms-full-txt', outcome('absent')],
    ]);
    expect(resolveAntecedent('root-llms-txt', ctx({ sources }))).toBe('apply');
    expect(resolveAntecedent('root-llms-full-txt', ctx({ sources }))).toBe('n_a');
  });
});
