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

  test('mcp-auth holds on a challenge to server/discover when initialize was refused without one', () => {
    const sources = new Map([
      ['mcp-initialize', outcome('absent', [{ url: 'https://x.dev/mcp', status: 200, error_code: -32022 }])],
      ['mcp-server-discover', outcome('na', [{ url: 'https://x.dev/mcp', status: 401, www_authenticate: 'Bearer' }])],
    ]);
    expect(resolveAntecedent('mcp-auth', ctx({ mcpEndpoint: 'https://x.dev/mcp', sources }))).toBe('apply');
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
    answered.set('mcp-server-discover', {
      ...outcome('pass', [{ url: ENDPOINT, status: 200, capabilities: ['tools'] }]),
      jsonRpcResult: true,
    });
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
      for (const mcpLane of [undefined, 'legacy'] as const) {
        expect(
          resolveAntecedent('mcp-session', ctx({ mcpEndpoint: ENDPOINT, sources, mcpAuth: SIGN_IN, mcpLane })),
        ).toEqual(AUTH_REQUIRED);
      }
    }
  });

  test('a handshake answered 200 with a JSON body that carries no result serves nothing', () => {
    const sources = challenged();
    sources.set(
      'mcp-server-discover',
      outcome('broken', [{ url: ENDPOINT, status: 200, supported_versions: null, serverInfo: null, capabilities: [] }]),
    );
    expect(resolveAntecedent('mcp-session', ctx({ mcpEndpoint: ENDPOINT, sources, mcpAuth: SIGN_IN }))).toEqual(
      AUTH_REQUIRED,
    );
  });

  test("a session row runs when its own lane's handshake refused the lane without asking for sign-in", () => {
    const refusedModern = challenged();
    refusedModern.set('mcp-server-discover', outcome('absent', [{ url: ENDPOINT, status: 200, error_code: -32601 }]));
    const modernAsked = ctx({ mcpEndpoint: ENDPOINT, sources: refusedModern, mcpAuth: SIGN_IN });
    expect({
      modern: resolveAntecedent('mcp-session', { ...modernAsked, mcpLane: 'modern' }),
      legacy: resolveAntecedent('mcp-session', { ...modernAsked, mcpLane: 'legacy' }),
    }).toEqual({ modern: 'apply', legacy: AUTH_REQUIRED });

    const refusedLegacy = new Map([
      ['mcp-initialize', outcome('absent', [{ url: ENDPOINT, status: 200, error_code: -32022 }])],
      ['mcp-server-discover', outcome('na', [{ url: ENDPOINT, status: 401 }])],
    ]);
    const legacyAsked = ctx({ mcpEndpoint: ENDPOINT, sources: refusedLegacy, mcpAuth: { ...SIGN_IN, lane: 'modern' } });
    expect({
      legacy: resolveAntecedent('mcp-session', { ...legacyAsked, mcpLane: 'legacy' }),
      modern: resolveAntecedent('mcp-session', { ...legacyAsked, mcpLane: 'modern' }),
    }).toEqual({ legacy: 'apply', modern: AUTH_REQUIRED });
  });

  test('a session row whose lane handshake went unanswered stays auth-required', () => {
    const sources = challenged();
    sources.set('mcp-server-discover', outcome('error', [{ url: ENDPOINT, status: null, error: 'TimeoutError' }]));
    expect(
      resolveAntecedent('mcp-session', ctx({ mcpEndpoint: ENDPOINT, sources, mcpAuth: SIGN_IN, mcpLane: 'modern' })),
    ).toEqual(AUTH_REQUIRED);
  });

  test('a resources row stays auth-required while a handshake sign-in blocked could have advertised resources', () => {
    const sources = challenged();
    sources.set('mcp-server-discover', outcome('absent', [{ url: ENDPOINT, status: 200, error_code: -32601 }]));
    expect(
      resolveAntecedent('mcp-resources', ctx({ mcpEndpoint: ENDPOINT, sources, mcpAuth: SIGN_IN, mcpLane: 'modern' })),
    ).toEqual(AUTH_REQUIRED);
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
