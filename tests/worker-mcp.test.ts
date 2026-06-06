// MCP module tests for U3 — server factory, tool registration, resource
// registration, instructions string.
//
// U3 ships the MCP module under src/worker/mcp/ but does NOT wire it
// into src/worker/index.ts (that's U4). So these tests build the
// handler directly via buildMcpHandler() and dispatch synthetic
// JSON-RPC envelopes through it, with a stubbed env.ASSETS serving a
// compact synthetic catalog. This isolates the MCP surface from the
// asset-first dispatch + rate-limit gate work that lands in U4.
//
// The fixture catalog is intentionally compact (three CLIs, two
// principles, two spec sections) so assertions can name slugs
// explicitly without coupling to live registry-index churn. Scorecard
// hit/miss + the orchestrator composition are exercised separately;
// this file pins handshake + tool/resource shape + instructions drift.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { resetCatalogCacheForTests } from '../src/worker/mcp/catalog';
import { buildMcpHandler, type McpEnv } from '../src/worker/mcp/server';
import { ANC_VERSION, SPEC_VERSION } from '../src/worker/spec-version.gen';

const FIXTURE_CATALOG = {
  generated_at: '2026-06-05T18:00:00.000Z',
  spec_version: SPEC_VERSION,
  registry: [
    {
      slug: 'curl',
      name: 'curl',
      binary: 'curl',
      install: 'brew install curl',
      version: '8.20.0',
      anc_version: ANC_VERSION,
      scorecard_url: '/score/curl',
      score_pct: 73,
      repo: 'curl/curl',
    },
    {
      slug: 'ripgrep',
      name: 'ripgrep',
      binary: 'rg',
      install: 'brew install ripgrep',
      version: '14.1.1',
      anc_version: ANC_VERSION,
      scorecard_url: '/score/ripgrep',
      score_pct: 85,
      audit_profile: 'workhorse',
      repo: 'BurntSushi/ripgrep',
    },
    {
      slug: 'fakecli',
      name: 'fakecli',
      binary: 'fakecli',
      install: 'brew install fakecli',
    },
  ],
  principles: [
    {
      n: 1,
      slug: 'non-interactive-by-default',
      title: 'P1: Non-Interactive by Default',
      body_markdown: '# P1: Non-Interactive by Default\n\nFixture body.\n',
      requirements: [
        {
          id: 'p1-must-no-interactive',
          level: 'must',
          summary: 'No prompts when stdin is not a TTY.',
          audit_ids: ['p1-non-interactive'],
        },
        {
          id: 'p1-should-env-hint',
          level: 'should',
          summary: 'Env hint for the flag.',
          audit_ids: ['p1-env-hints'],
        },
      ],
    },
    {
      n: 2,
      slug: 'structured-parseable-output',
      title: 'P2: Structured, Parseable Output',
      body_markdown: '# P2: Structured, Parseable Output\n\nFixture body.\n',
      requirements: [],
    },
  ],
  spec_sections: [
    {
      slug: 'p1-non-interactive-by-default',
      title: 'P1: Non-Interactive by Default',
      level: 2,
      parent_slug: null,
      body_markdown: '# P1\n\nSpec-side fixture.\n',
    },
    {
      slug: 'scoring',
      title: 'Scoring',
      level: 2,
      parent_slug: null,
      body_markdown: '# Scoring\n\nFixture.\n',
    },
  ],
};

function makeEnv(): McpEnv {
  return {
    ASSETS: {
      fetch(req: Request) {
        const path = new URL(req.url).pathname;
        if (path === '/_internal/mcp-catalog.json') {
          return Promise.resolve(
            new Response(JSON.stringify(FIXTURE_CATALOG), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }),
          );
        }
        return Promise.resolve(new Response('not found', { status: 404 }));
      },
    } as unknown as Fetcher,
  } as McpEnv;
}

type JsonRpcBody = {
  jsonrpc: '2.0';
  id: number | string | null;
  method?: string;
  params?: unknown;
  result?: {
    serverInfo?: { name?: string; version?: string };
    protocolVersion?: string;
    capabilities?: { tools?: unknown; resources?: { subscribe?: boolean } };
    instructions?: string;
    tools?: Array<{ name: string; description?: string; inputSchema?: unknown }>;
    resources?: Array<{ uri: string; name?: string }>;
    resourceTemplates?: Array<{ uriTemplate: string; name?: string }>;
    content?: Array<{ type: string; text: string }>;
    contents?: Array<{ uri: string; mimeType: string; text: string }>;
    isError?: boolean;
  };
  error?: { code: number; message: string };
};

async function rpc(env: McpEnv, body: JsonRpcBody): Promise<JsonRpcBody> {
  const handler = await buildMcpHandler(env, { jsonResponse: true });
  const res = await handler(
    new Request('https://anc.dev/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify(body),
    }),
    env,
    {} as ExecutionContext,
  );
  expect(res.status).toBe(200);
  const text = await res.text();
  return JSON.parse(text) as JsonRpcBody;
}

async function initialize(env: McpEnv): Promise<JsonRpcBody> {
  return rpc(env, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '0.0.0' },
    },
  });
}

function getJsonContent(body: JsonRpcBody): unknown {
  const text = body.result?.content?.[0]?.text;
  if (typeof text !== 'string') throw new Error('expected text content block');
  return JSON.parse(text);
}

beforeEach(() => {
  resetCatalogCacheForTests();
});

afterEach(() => {
  resetCatalogCacheForTests();
});

describe('MCP handshake', () => {
  test('initialize returns serverInfo name anc and version 0.1.0', async () => {
    const env = makeEnv();
    const result = await initialize(env);
    expect(result.error).toBeUndefined();
    expect(result.result?.serverInfo?.name).toBe('anc');
    expect(result.result?.serverInfo?.version).toBe('0.1.0');
  });

  test('initialize advertises protocolVersion 2025-06-18', async () => {
    const env = makeEnv();
    const result = await initialize(env);
    expect(result.result?.protocolVersion).toBe('2025-06-18');
  });

  test('initialize advertises stateless capabilities (tools + resources, no subscribe)', async () => {
    const env = makeEnv();
    const result = await initialize(env);
    const caps = result.result?.capabilities;
    expect(caps?.tools).toBeDefined();
    expect(caps?.resources).toBeDefined();
    expect(caps?.resources?.subscribe).toBeFalsy();
  });
});

describe('MCP instructions string (drift gate per KTD-8)', () => {
  test('instructions carries the nine literal numeric facts', async () => {
    const env = makeEnv();
    const result = await initialize(env);
    const instructions = result.result?.instructions ?? '';
    expect(instructions.length).toBeGreaterThan(0);
    expect(instructions).toContain('9 tools');
    expect(instructions).toContain('5 resources');
    expect(instructions).toContain('60 requests per 60 seconds');
    expect(instructions).toContain('5 fresh audits per 60 minutes');
    expect(instructions).toContain('2025-06-18');
    expect(instructions).toContain('https://anc.dev/mcp-skill.md');
  });

  test('instructions surfaces protocol identifiers (MIME types + RPC method names)', async () => {
    const env = makeEnv();
    const result = await initialize(env);
    const instructions = result.result?.instructions ?? '';
    expect(instructions).toContain('application/json');
    expect(instructions).toContain('text/event-stream');
    expect(instructions).toContain('tools/list');
    expect(instructions).toContain('resources/templates/list');
  });

  test('instructions names both rate-limit bindings + both kill switches', async () => {
    const env = makeEnv();
    const result = await initialize(env);
    const instructions = result.result?.instructions ?? '';
    expect(instructions).toContain('MCP_LIMITER');
    expect(instructions).toContain('MCP_AUDIT_LIMITER');
    expect(instructions).toContain('MCP_ENABLED');
    expect(instructions).toContain('MCP_LIVE_SCORING_ENABLED');
  });
});

describe('MCP tools/list', () => {
  test('returns exactly nine tools in the expected order', async () => {
    const env = makeEnv();
    await initialize(env);
    const result = await rpc(env, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const tools = result.result?.tools ?? [];
    const names = tools.map((t) => t.name);
    expect(names).toEqual([
      'list_tools',
      'get_tool',
      'search_tools',
      'list_principles',
      'get_principle',
      'list_spec_sections',
      'get_spec_section',
      'get_scorecard',
      'score_cli',
    ]);
  });

  test('every tool carries a non-empty description and a JSON-schema-shaped inputSchema', async () => {
    const env = makeEnv();
    await initialize(env);
    const result = await rpc(env, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    for (const tool of result.result?.tools ?? []) {
      expect(typeof tool.description).toBe('string');
      expect((tool.description ?? '').length).toBeGreaterThan(0);
      expect(tool.inputSchema).toBeDefined();
    }
  });
});

describe('MCP registry tools', () => {
  test('list_tools returns the full registry projection (slug + summary fields)', async () => {
    const env = makeEnv();
    await initialize(env);
    const result = await rpc(env, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'list_tools', arguments: {} },
    });
    const rows = getJsonContent(result) as Array<{
      slug: string;
      binary: string;
      score_pct: number | null;
      audit_profile: string | null;
    }>;
    expect(rows.length).toBe(3);
    const ripgrep = rows.find((r) => r.slug === 'ripgrep');
    expect(ripgrep?.binary).toBe('rg');
    expect(ripgrep?.score_pct).toBe(85);
    expect(ripgrep?.audit_profile).toBe('workhorse');
    const curl = rows.find((r) => r.slug === 'curl');
    expect(curl?.audit_profile).toBeNull();
  });

  test('get_tool returns the full registry record for a known slug', async () => {
    const env = makeEnv();
    await initialize(env);
    const result = await rpc(env, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'get_tool', arguments: { slug: 'ripgrep' } },
    });
    expect(result.result?.isError).toBeFalsy();
    const body = getJsonContent(result) as { found: boolean; entry?: { slug: string; binary: string } };
    expect(body.found).toBe(true);
    expect(body.entry?.slug).toBe('ripgrep');
    expect(body.entry?.binary).toBe('rg');
  });

  test('get_tool returns isError false with found false on unknown slug (look-not-found is data)', async () => {
    const env = makeEnv();
    await initialize(env);
    const result = await rpc(env, {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'get_tool', arguments: { slug: 'does-not-exist' } },
    });
    expect(result.result?.isError).toBeFalsy();
    const body = getJsonContent(result) as { found: boolean; message: string };
    expect(body.found).toBe(false);
    expect(body.message).toContain('does-not-exist');
  });

  test('search_tools filters by score_min inclusively', async () => {
    const env = makeEnv();
    await initialize(env);
    const result = await rpc(env, {
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: 'search_tools', arguments: { score_min: 80 } },
    });
    const rows = getJsonContent(result) as Array<{ slug: string; score_pct: number }>;
    expect(rows.length).toBe(1);
    expect(rows[0].slug).toBe('ripgrep');
  });

  test('search_tools filters by audit_profile exact match', async () => {
    const env = makeEnv();
    await initialize(env);
    const result = await rpc(env, {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'search_tools', arguments: { audit_profile: 'workhorse' } },
    });
    const rows = getJsonContent(result) as Array<{ slug: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0].slug).toBe('ripgrep');
  });
});

describe('MCP principles tools', () => {
  test('list_principles returns one entry per fixture principle with a level_summary', async () => {
    const env = makeEnv();
    await initialize(env);
    const result = await rpc(env, {
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: { name: 'list_principles', arguments: {} },
    });
    const rows = getJsonContent(result) as Array<{
      n: number;
      slug: string;
      level_summary: { must: number; should: number; may: number };
    }>;
    expect(rows.length).toBe(2);
    const p1 = rows.find((r) => r.n === 1);
    expect(p1?.level_summary.must).toBe(1);
    expect(p1?.level_summary.should).toBe(1);
    expect(p1?.level_summary.may).toBe(0);
  });

  test('get_principle returns the full body and requirements for a known n', async () => {
    const env = makeEnv();
    await initialize(env);
    const result = await rpc(env, {
      jsonrpc: '2.0',
      id: 11,
      method: 'tools/call',
      params: { name: 'get_principle', arguments: { n: 1 } },
    });
    const body = getJsonContent(result) as {
      found: boolean;
      principle?: { n: number; body_markdown: string; requirements: Array<{ id: string; audit_ids: string[] }> };
    };
    expect(body.found).toBe(true);
    expect(body.principle?.n).toBe(1);
    expect(body.principle?.body_markdown).toContain('# P1');
    expect(body.principle?.requirements[0].audit_ids).toEqual(['p1-non-interactive']);
  });

  test('get_principle returns found false with message when n is out of range', async () => {
    const env = makeEnv();
    await initialize(env);
    const result = await rpc(env, {
      jsonrpc: '2.0',
      id: 12,
      method: 'tools/call',
      params: { name: 'get_principle', arguments: { n: 99 } },
    });
    expect(result.result?.isError).toBeFalsy();
    const body = getJsonContent(result) as { found: boolean; message: string };
    expect(body.found).toBe(false);
    expect(body.message).toContain('99');
  });
});

describe('MCP spec tools', () => {
  test('list_spec_sections returns the TOC with spec_version carried', async () => {
    const env = makeEnv();
    await initialize(env);
    const result = await rpc(env, {
      jsonrpc: '2.0',
      id: 20,
      method: 'tools/call',
      params: { name: 'list_spec_sections', arguments: {} },
    });
    const body = getJsonContent(result) as {
      spec_version: string;
      sections: Array<{ slug: string; level: number }>;
    };
    expect(body.spec_version).toBe(SPEC_VERSION);
    expect(body.sections.length).toBe(2);
  });

  test('get_spec_section returns the body and spec_version for a known slug', async () => {
    const env = makeEnv();
    await initialize(env);
    const result = await rpc(env, {
      jsonrpc: '2.0',
      id: 21,
      method: 'tools/call',
      params: { name: 'get_spec_section', arguments: { slug: 'scoring' } },
    });
    const body = getJsonContent(result) as {
      found: boolean;
      section?: { slug: string; body_markdown: string; spec_version: string };
    };
    expect(body.found).toBe(true);
    expect(body.section?.slug).toBe('scoring');
    expect(body.section?.spec_version).toBe(SPEC_VERSION);
  });
});

describe('MCP score_cli kill switch (real implementation lands in U5a)', () => {
  test('with MCP_LIVE_SCORING_ENABLED not set, returns isError: false + audited: false + disabled message', async () => {
    // makeEnv() does NOT set MCP_LIVE_SCORING_ENABLED, so the kill
    // switch fires first and short-circuits before validateInput, the
    // limiters, or runFreshOnly run. This is the production-default
    // posture (production env vars block defaults MCP_LIVE_SCORING_ENABLED
    // to "false"); the test confirms the kill switch is wired before
    // the cost-bearing path.
    const env = makeEnv();
    await initialize(env);
    const result = await rpc(env, {
      jsonrpc: '2.0',
      id: 30,
      method: 'tools/call',
      params: { name: 'score_cli', arguments: { slug: 'ripgrep' } },
    });
    expect(result.result?.isError).toBeFalsy();
    const body = getJsonContent(result) as { audited: boolean; message: string };
    expect(body.audited).toBe(false);
    expect(body.message.toLowerCase()).toContain('disabled');
  });
});

describe('MCP resources/list + templates/list', () => {
  test('resources/list returns exactly one concrete resource anc://registry', async () => {
    const env = makeEnv();
    await initialize(env);
    const result = await rpc(env, { jsonrpc: '2.0', id: 40, method: 'resources/list' });
    const resources = result.result?.resources ?? [];
    expect(resources.length).toBe(1);
    expect(resources[0].uri).toBe('anc://registry');
  });

  test('resources/templates/list returns exactly four templates', async () => {
    const env = makeEnv();
    await initialize(env);
    const result = await rpc(env, { jsonrpc: '2.0', id: 41, method: 'resources/templates/list' });
    const templates = result.result?.resourceTemplates ?? [];
    const patterns = templates.map((t) => t.uriTemplate).sort();
    expect(patterns).toEqual([
      'anc://principle/{n}',
      'anc://scorecard/{binary}',
      'anc://spec/{section}',
      'anc://tool/{slug}',
    ]);
  });
});

describe('MCP resources/read', () => {
  test('reading anc://registry returns the full catalog registry array', async () => {
    const env = makeEnv();
    await initialize(env);
    const result = await rpc(env, {
      jsonrpc: '2.0',
      id: 50,
      method: 'resources/read',
      params: { uri: 'anc://registry' },
    });
    const text = result.result?.contents?.[0]?.text ?? '';
    const parsed = JSON.parse(text) as Array<{ slug: string }>;
    expect(parsed.length).toBe(3);
    expect(parsed.map((p) => p.slug).sort()).toEqual(['curl', 'fakecli', 'ripgrep']);
  });

  test('reading anc://tool/<slug> returns the registry entry for that slug', async () => {
    const env = makeEnv();
    await initialize(env);
    const result = await rpc(env, {
      jsonrpc: '2.0',
      id: 51,
      method: 'resources/read',
      params: { uri: 'anc://tool/ripgrep' },
    });
    const text = result.result?.contents?.[0]?.text ?? '';
    const parsed = JSON.parse(text) as { slug: string; binary: string };
    expect(parsed.slug).toBe('ripgrep');
    expect(parsed.binary).toBe('rg');
  });

  test('reading anc://principle/<n> returns the principle record', async () => {
    const env = makeEnv();
    await initialize(env);
    const result = await rpc(env, {
      jsonrpc: '2.0',
      id: 52,
      method: 'resources/read',
      params: { uri: 'anc://principle/2' },
    });
    const text = result.result?.contents?.[0]?.text ?? '';
    const parsed = JSON.parse(text) as { n: number; slug: string };
    expect(parsed.n).toBe(2);
    expect(parsed.slug).toBe('structured-parseable-output');
  });

  test('reading anc://spec/<slug> returns the section plus spec_version', async () => {
    const env = makeEnv();
    await initialize(env);
    const result = await rpc(env, {
      jsonrpc: '2.0',
      id: 53,
      method: 'resources/read',
      params: { uri: 'anc://spec/scoring' },
    });
    const text = result.result?.contents?.[0]?.text ?? '';
    const parsed = JSON.parse(text) as { slug: string; spec_version: string };
    expect(parsed.slug).toBe('scoring');
    expect(parsed.spec_version).toBe(SPEC_VERSION);
  });

  test('reading anc://scorecard/<binary> resolves by binary or slug', async () => {
    const env = makeEnv();
    await initialize(env);
    const result = await rpc(env, {
      jsonrpc: '2.0',
      id: 54,
      method: 'resources/read',
      params: { uri: 'anc://scorecard/rg' },
    });
    const text = result.result?.contents?.[0]?.text ?? '';
    const parsed = JSON.parse(text) as { slug: string };
    expect(parsed.slug).toBe('ripgrep');
  });

  test('reading an unknown template URI surfaces a JSON-RPC error envelope', async () => {
    const env = makeEnv();
    await initialize(env);
    const result = await rpc(env, {
      jsonrpc: '2.0',
      id: 55,
      method: 'resources/read',
      params: { uri: 'anc://tool/does-not-exist' },
    });
    expect(result.error).toBeDefined();
  });
});
