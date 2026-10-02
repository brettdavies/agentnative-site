import { describe, expect, test } from 'bun:test';
import { resolveAntecedent } from '../src/worker/audit-web/antecedents';
import type { ProbeResponse } from '../src/worker/audit-web/assert';
import { ctx, outcome } from './web-audit-antecedents-helpers';

describe('resolveAntecedent: auth', () => {
  test('auth-present holds on oauth discovery metadata or any observed 401', () => {
    expect(resolveAntecedent('auth-present', ctx({ sources: new Map([['oauth-discovery', outcome('pass')]]) }))).toBe(
      'apply',
    );
    const root401: ProbeResponse = { status: 401, headers: {}, body: '', error: null };
    expect(resolveAntecedent('auth-present', ctx({ root: root401 }))).toBe('apply');
    const openapi401 = ctx({
      sources: new Map([['openapi', outcome('broken', [{ url: 'https://x.dev/openapi.json', status: 401 }])]]),
    });
    expect(resolveAntecedent('auth-present', openapi401)).toBe('apply');
    expect(resolveAntecedent('auth-present', ctx())).toBe('n_a');
  });

  test('auth-present holds on a challenge to server/discover when initialize was refused without one', () => {
    const sources = new Map([
      ['mcp-initialize', outcome('absent', [{ url: 'https://x.dev/mcp', status: 200, error_code: -32022 }])],
      ['mcp-server-discover', outcome('na', [{ url: 'https://x.dev/mcp', status: 401, www_authenticate: 'Bearer' }])],
    ]);
    expect(resolveAntecedent('auth-present', ctx({ mcpEndpoint: 'https://x.dev/mcp', sources }))).toBe('apply');
  });
});
