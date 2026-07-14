import { describe, expect, test } from 'bun:test';
import { resolveAntecedent } from '../src/worker/audit-web/antecedents';
import { ctx, outcome } from './web-audit-antecedents-helpers';

describe('resolveAntecedent: mcp', () => {
  test('mcp-present follows discovery', () => {
    expect(resolveAntecedent('mcp-present', ctx({ mcpEndpoint: 'https://x.dev/mcp' }))).toBe('apply');
    expect(resolveAntecedent('mcp-present', ctx())).toBe('n_a');
  });

  test('mcp-auth holds on a 401/WWW-Authenticate initialize or a card auth declaration', () => {
    const base = { mcpEndpoint: 'https://x.dev/mcp' };
    const with401 = ctx({
      ...base,
      sources: new Map([['mcp-initialize', outcome('broken', [{ url: 'https://x.dev/mcp', status: 401 }])]]),
    });
    expect(resolveAntecedent('mcp-auth', with401)).toBe('apply');
    const withHeader = ctx({
      ...base,
      sources: new Map([
        ['mcp-initialize', outcome('broken', [{ url: 'https://x.dev/mcp', status: 400, www_authenticate: 'Bearer' }])],
      ]),
    });
    expect(resolveAntecedent('mcp-auth', withHeader)).toBe('apply');
    const withCard = ctx({ ...base, discoveryEvidence: [{ source: '/.well-known/mcp.json', authentication: true }] });
    expect(resolveAntecedent('mcp-auth', withCard)).toBe('apply');
    expect(resolveAntecedent('mcp-auth', ctx(base))).toBe('n_a');
    expect(resolveAntecedent('mcp-auth', ctx())).toBe('n_a');
  });
});
