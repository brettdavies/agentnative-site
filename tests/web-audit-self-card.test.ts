// anc.dev's own server card, scored the way the web audit scores any site:
// the engine's discovery reads the documents the Worker serves from the
// built dist/ seeds, and the mcp-server-card check scores the card of record
// discovery kept. Reads dist/, so `bun run build` runs first.

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertHttp, type ExpectBlock } from '../src/worker/audit-web/assert';
import { readDiscoveryDocuments } from '../src/worker/audit-web/discovery';
import { catalogCardEntries, parseJsonObject } from '../src/worker/audit-web/discovery-documents';
import { runServerCard } from '../src/worker/audit-web/handlers/server-card';
import type { WebAuditRegistry, WebCheck } from '../src/worker/audit-web/registry';
import worker from '../src/worker/index';
import { distAssetsEnv, requireDistBuild } from './helpers/dist';
import { stubFetch } from './helpers/stub-fetch';

const REPO_ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const DIST_DIR = join(REPO_ROOT, 'dist');
const BASE = 'https://anc.dev/';
const TIMEOUT_MS = 5_000;

async function builtRegistry(): Promise<WebAuditRegistry> {
  requireDistBuild(DIST_DIR);
  const raw = await readFile(join(DIST_DIR, '_internal', 'web-audit-registry.json'), 'utf8');
  return JSON.parse(raw) as WebAuditRegistry;
}

function registryCheck(registry: WebAuditRegistry, id: string): WebCheck {
  const check = registry.checks.find((c) => c.id === id);
  if (check === undefined) throw new Error(`the built registry has no ${id} check`);
  return check;
}

describe("anc.dev's own discovery documents, through the web audit", () => {
  test('the card the AI catalog lists is the card of record and passes the card check with no advisory', async () => {
    const registry = await builtRegistry();
    const env = distAssetsEnv(DIST_DIR);
    const fetchImpl = stubFetch((url, init) => worker.fetch(new Request(url, init), env, {} as ExecutionContext));

    const discovered = await readDiscoveryDocuments(BASE, registry.mcp_discovery, {
      timeoutMs: TIMEOUT_MS,
      fetchOptions: { fetchImpl },
    });
    const result = await discovered.probeEndpoint();
    expect(result.endpoint).toBe('https://anc.dev/mcp');

    const catalog = result.documents.get('ai-catalog');
    if (catalog === undefined) throw new Error('discovery retained no AI catalog');
    const catalogExpect = registryCheck(registry, 'ai-catalog').with.expect as ExpectBlock;
    expect(assertHttp(catalogExpect, catalog.response)).toMatchObject({ ok: true });
    expect(catalog.response.headers['content-type']).toMatch(/json/i);

    // Without the catalog entry, discovery still reaches this card at
    // <endpoint>/server-card and the card check still passes, so the
    // catalog's listing of the card is asserted directly.
    const card = result.documents.get('server-card');
    if (card === undefined) throw new Error('discovery retained no server card');
    const listed = catalogCardEntries(parseJsonObject(catalog.response) ?? {}).flatMap((entry) =>
      'url' in entry ? [new URL(entry.url, catalog.url).toString()] : [],
    );
    expect(listed).toEqual([card.url]);
    expect(card.shape).toBe('sep-2127');

    const outcome = await runServerCard(registryCheck(registry, 'mcp-server-card'), {
      base: BASE,
      host: new URL(BASE).host,
      mcpEndpoint: result.endpoint,
      protocolVersion: registry.mcp_discovery.protocol_version,
      defaultTimeoutMs: TIMEOUT_MS,
      fetchOptions: { fetchImpl },
      retainedDocuments: result.documents,
    });
    expect(outcome.status).toBe('pass');
    expect(outcome.advisory).toBeUndefined();
  });
});
