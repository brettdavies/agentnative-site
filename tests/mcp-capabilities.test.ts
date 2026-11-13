// The capabilities the server declares, and the cache hints that carry list
// freshness. The handshake on both lanes and the SEP-1649 card read one
// constant; nothing publishes a list change, so a client learns of a changed
// list on its next list call, bounded by the hint.
//
// The expected values are written out rather than imported: a test that reads
// the constant it checks cannot notice the constant changing.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emitDiscovery } from '../src/build/11a-discovery-emit.mjs';
import worker, { type Env } from '../src/worker/index';
import { distAssetsEnv, requireDistBuild } from './helpers/dist';
import {
  MODERN_META,
  MODERN_PROTOCOL,
  modernResourcesReadBody,
  modernResourcesReadHeaders,
  modernServerDiscoverBody,
  modernServerDiscoverHeaders,
  modernToolsListBody,
  modernToolsListHeaders,
} from './helpers/mcp-modern';
import { type JsonRpcBody, mcpInitialize, mcpRpc, mcpRpcExpect200, resetMcpTestState } from './helpers/mcp-rpc';

const DIST_DIR = join(fileURLToPath(import.meta.url), '..', '..', 'dist');

const EXPECTED_CAPABILITIES = {
  tools: { listChanged: false },
  resources: { subscribe: false, listChanged: false },
};

const LIST_HINT_MS = 300_000;
const READ_HINT_MS = 3_600_000;

function env() {
  requireDistBuild(DIST_DIR);
  return { ...distAssetsEnv(DIST_DIR), MCP_ENABLED: 'true' } as unknown as Env;
}

async function modernList(method: string, headers: Record<string, string>): Promise<JsonRpcBody> {
  return mcpRpcExpect200(
    env() as never,
    { jsonrpc: '2.0', id: 20, method, params: { ...MODERN_META } },
    { 'MCP-Protocol-Version': MODERN_PROTOCOL, 'Mcp-Method': method, ...headers },
  );
}

async function postListen(params: object): Promise<Response> {
  return worker.fetch(
    new Request('https://anc.dev/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        host: 'anc.dev',
        'MCP-Protocol-Version': MODERN_PROTOCOL,
        'Mcp-Method': 'subscriptions/listen',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'listen:1',
        method: 'subscriptions/listen',
        params: { ...params, ...MODERN_META },
      }),
    }),
    env(),
    {} as ExecutionContext,
  );
}

async function builtCard(): Promise<{ capabilities: Record<string, unknown> }> {
  const dir = join(tmpdir(), `anc-capabilities-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  try {
    await emitDiscovery({ distDir: dir, baseUrl: 'https://example.test' });
    return JSON.parse(await readFile(join(dir, '_internal', 'mcp-server-card.json'), 'utf8'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

beforeEach(() => {
  resetMcpTestState();
});

afterEach(() => {
  resetMcpTestState();
});

describe('declared capabilities', () => {
  test('server/discover declares no list-change notification and no prompts', async () => {
    const body = await mcpRpcExpect200(env() as never, modernServerDiscoverBody(), modernServerDiscoverHeaders());
    expect(body.error).toBeUndefined();
    expect(body.result?.capabilities).toEqual(EXPECTED_CAPABILITIES);
  });

  test('legacy initialize declares the same capabilities', async () => {
    const body = await mcpInitialize(env() as never);
    expect(body.error).toBeUndefined();
    expect(body.result?.capabilities).toEqual(EXPECTED_CAPABILITIES);
  });

  test('the SEP-1649 card declares the capabilities both lanes report', async () => {
    const card = await builtCard();
    expect(card.capabilities).toEqual(EXPECTED_CAPABILITIES);
    const discover = await mcpRpcExpect200(env() as never, modernServerDiscoverBody(), modernServerDiscoverHeaders());
    expect(card.capabilities).toEqual(discover.result?.capabilities as Record<string, unknown>);
  });

  test('no declared capability names a method that answers -32601', async () => {
    const card = await builtCard();
    expect(Object.keys(card.capabilities)).not.toContain('prompts');
    const { body } = await mcpRpc(
      env() as never,
      { jsonrpc: '2.0', id: 21, method: 'prompts/list', params: { ...MODERN_META } },
      { 'MCP-Protocol-Version': MODERN_PROTOCOL, 'Mcp-Method': 'prompts/list' },
    );
    expect(body.error?.code).toBe(-32601);
  });
});

describe('subscriptions/listen', () => {
  test('a request for both list notifications gets an empty acknowledgement and a closed stream', async () => {
    const res = await postListen({ notifications: { toolsListChanged: true, resourcesListChanged: true } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') ?? '').toContain('text/event-stream');

    const text = await Promise.race([
      res.text(),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('the listen stream was still open after 3 s')), 3_000);
      }),
    ]);
    const events = text
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice(6)) as { method?: string; params?: { notifications?: unknown } });
    const ack = events.find((event) => event.method === 'notifications/subscriptions/acknowledged');
    expect(ack?.params?.notifications).toEqual({});
  });
});

describe('list cache hints', () => {
  test('tools/list carries a 5-minute public hint', async () => {
    const body = await mcpRpcExpect200(env() as never, modernToolsListBody(), modernToolsListHeaders());
    expect(body.result?.ttlMs).toBe(LIST_HINT_MS);
    expect(body.result?.cacheScope).toBe('public');
  });

  test('resources/list carries a 5-minute public hint', async () => {
    const body = await modernList('resources/list', {});
    expect(body.result?.ttlMs).toBe(LIST_HINT_MS);
    expect(body.result?.cacheScope).toBe('public');
  });

  test('resources/templates/list carries a 5-minute public hint', async () => {
    const body = await modernList('resources/templates/list', {});
    expect(body.result?.ttlMs).toBe(LIST_HINT_MS);
    expect(body.result?.cacheScope).toBe('public');
  });

  test('resources/read keeps its 1-hour public hint', async () => {
    const uri = 'anc://registry';
    const body = await mcpRpcExpect200(env() as never, modernResourcesReadBody(uri), modernResourcesReadHeaders(uri));
    expect(body.error).toBeUndefined();
    expect(body.result?.ttlMs).toBe(READ_HINT_MS);
    expect(body.result?.cacheScope).toBe('public');
  });
});
