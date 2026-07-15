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
});
