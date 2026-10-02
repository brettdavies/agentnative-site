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

  test('mcp-resources holds only when initialize advertised capabilities.resources', () => {
    const base = { mcpEndpoint: 'https://x.dev/mcp' };
    const withResources = ctx({
      ...base,
      sources: new Map([['mcp-initialize', outcome('pass', [{ capabilities: ['tools', 'resources'] }])]]),
    });
    expect(resolveAntecedent('mcp-resources', withResources)).toBe('apply');
    const toolsOnly = ctx({
      ...base,
      sources: new Map([['mcp-initialize', outcome('pass', [{ capabilities: ['tools'] }])]]),
    });
    expect(resolveAntecedent('mcp-resources', toolsOnly)).toBe('n_a');
    expect(resolveAntecedent('mcp-resources', ctx(base))).toBe('n_a');
    expect(resolveAntecedent('mcp-resources', ctx())).toBe('n_a');
  });

  const ENDPOINT = 'https://x.dev/mcp';
  const SIGN_IN = {
    endpoint: ENDPOINT,
    challenge: 'Bearer resource_metadata="https://x.dev/.well-known/oauth-protected-resource"',
    lane: 'legacy' as const,
    metadataUrl: 'https://x.dev/.well-known/oauth-protected-resource',
    metadata: { resource: ENDPOINT, authorization_servers: ['https://auth.x.dev'] },
  };
  const challenged = () => new Map([['mcp-initialize', outcome('na', [{ url: ENDPOINT, status: 401 }])]]);

  const AUTH_REQUIRED = { outcome: 'n_a', reason: 'auth-required', host: 'x.dev', evidence: ENDPOINT } as const;

  test('mcp-session holds unless the endpoint requires sign-in and no wire probe was served a result without it', () => {
    const base = { mcpEndpoint: ENDPOINT };
    expect(resolveAntecedent('mcp-session', ctx(base))).toBe('apply');
    expect(resolveAntecedent('mcp-session', ctx({ ...base, sources: challenged(), mcpAuth: SIGN_IN }))).toEqual(
      AUTH_REQUIRED,
    );
    const answered = challenged();
    answered.set('mcp-server-discover', outcome('pass', [{ url: ENDPOINT, status: 200, capabilities: ['tools'] }]));
    expect(resolveAntecedent('mcp-session', ctx({ ...base, sources: answered, mcpAuth: SIGN_IN }))).toBe('apply');
    expect(resolveAntecedent('mcp-session', ctx())).toBe('n_a');
  });

  test('a handshake answered at a 2xx with a JSON-RPC error is a lane refusal, not a request served without sign-in', () => {
    for (const refusal of [
      outcome('absent', [{ url: ENDPOINT, status: 200, error_code: -32601 }]),
      outcome('absent', [{ url: ENDPOINT, status: 200, error_code: -32022 }]),
      outcome('broken', [{ url: ENDPOINT, status: 200, why: ['no parseable JSON-RPC response'] }]),
    ]) {
      const sources = challenged();
      sources.set('mcp-server-discover', refusal);
      expect(resolveAntecedent('mcp-session', ctx({ mcpEndpoint: ENDPOINT, sources, mcpAuth: SIGN_IN }))).toEqual(
        AUTH_REQUIRED,
      );
    }
  });

  test('mcp-auth-required holds only when the endpoint requires sign-in, never on a card declaration alone', () => {
    expect(
      resolveAntecedent('mcp-auth-required', ctx({ mcpEndpoint: ENDPOINT, sources: challenged(), mcpAuth: SIGN_IN })),
    ).toBe('apply');
    expect(resolveAntecedent('mcp-auth-required', ctx({ mcpEndpoint: ENDPOINT }))).toBe('n_a');
    const declaresAuth = ctx({
      mcpEndpoint: ENDPOINT,
      discoveryEvidence: [{ source: '/.well-known/mcp.json', authentication: true }],
    });
    expect(resolveAntecedent('mcp-auth-required', declaresAuth)).toBe('n_a');
    expect(resolveAntecedent('mcp-auth-required', ctx())).toEqual({
      outcome: 'n_a',
      reason: 'antecedent-unmet',
      evidence: 'no MCP endpoint discovered',
    });
  });

  test('mcp-resources reads auth-required, not an unadvertised capability, when the session is unavailable', () => {
    const resolution = resolveAntecedent(
      'mcp-resources',
      ctx({ mcpEndpoint: ENDPOINT, sources: challenged(), mcpAuth: SIGN_IN }),
    );
    expect(resolution).toEqual({ outcome: 'n_a', reason: 'auth-required', host: 'x.dev', evidence: ENDPOINT });
  });
});
