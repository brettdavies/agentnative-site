#!/usr/bin/env bun
// Run the working-tree web-audit engine against a live target and report
// per-check results. Companion to docs/runbooks/web-audit-operations.md;
// invoke through run.sh (it resolves the Access token and builds first).
//
// Why Bun and not a self-audit: `runWebAudit` is TypeScript with no
// Workers-only APIs, so it runs under Bun against real remote content. This
// exercises the current working tree's audit LOGIC without deploying. The
// deployed staging Worker cannot audit itself — its internal self-fetches do
// not carry the Cloudflare Access service token, so every probe reads the
// Access login wall (all checks n_a). Running the engine locally and
// injecting the token on the staging host is the reliable path.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type AuditEvent, runWebAudit } from '../../src/worker/audit-web/engine';
import type { WebAuditRegistry } from '../../src/worker/audit-web/registry';
import { SPEC_VERSION } from '../../src/worker/spec-version.gen';

type Scorecard = Extract<AuditEvent, { type: 'complete' }>['scorecard'];

const REPO_ROOT = join(import.meta.dir, '..', '..');
const DEFAULT_TARGET = process.env.STAGING_URL ?? 'https://agentnative-site-staging.brettdavies.workers.dev/';
const STAGING_HOST_MARK = 'agentnative-site-staging';

// Exit code by status so `--check <id>` can gate CI/agents: 0 pass, 1 the
// surface exists but fails, 3 the check could not be evaluated.
const STATUS_EXIT: Record<string, number> = { pass: 0, broken: 1, absent: 1, error: 1, skip: 1, n_a: 3 };

interface Args {
  target: string;
  check?: string;
  json: boolean;
  siteType?: 'content' | 'api';
}

function parseArgs(argv: string[]): Args {
  const args: Args = { target: DEFAULT_TARGET, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--target' || arg === '-t') args.target = argv[++i] ?? args.target;
    else if (arg === '--check' || arg === '-c') args.check = argv[++i];
    else if (arg === '--json') args.json = true;
    else if (arg === '--site-type') {
      const value = argv[++i];
      if (value === 'content' || value === 'api') args.siteType = value;
    } else if (!arg.startsWith('-')) args.target = arg;
  }
  return args;
}

/**
 * A fetch that injects the Cloudflare Access service token on the staging
 * host only, so the engine reaches through the Access wall without leaking
 * the credentials to any off-host redirect target. Returns undefined when
 * the token is absent (public targets need no header).
 */
function accessInjectingFetch(): typeof fetch | undefined {
  const id = process.env.CF_ACCESS_CLIENT_ID;
  const secret = process.env.CF_ACCESS_CLIENT_SECRET;
  if (!id || !secret) return undefined;
  // Cast to typeof fetch: the wrapper omits the rarely-used `preconnect`
  // static that the type carries but guardedFetch never calls. Mirrors the
  // fetch-stub casts in tests/web-audit-handlers.test.ts.
  return ((input: Request | string | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const headers = new Headers(init?.headers);
    if (new URL(url).host.includes(STAGING_HOST_MARK)) {
      headers.set('CF-Access-Client-Id', id);
      headers.set('CF-Access-Client-Secret', secret);
    }
    return fetch(url, { ...init, headers });
  }) as typeof fetch;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  const registryPath = join(REPO_ROOT, 'dist', '_internal', 'web-audit-registry.json');
  let registry: WebAuditRegistry;
  try {
    registry = JSON.parse(readFileSync(registryPath, 'utf8')) as WebAuditRegistry;
  } catch {
    console.error(`registry not found at ${registryPath}; run \`bun run build\` first (run.sh does this for you).`);
    return 2;
  }

  const fetchImpl = accessInjectingFetch();
  if (new URL(args.target).host.includes(STAGING_HOST_MARK) && !fetchImpl) {
    console.error('target is staging (behind Cloudflare Access) but CF_ACCESS_CLIENT_ID/SECRET are unset; use run.sh.');
    return 2;
  }

  const audit = runWebAudit({
    url: args.target,
    registry,
    siteType: args.siteType ?? null,
    specVersion: SPEC_VERSION,
    fetchOptions: fetchImpl ? { fetchImpl } : {},
  });

  let scorecard: Scorecard | null = null;
  for (let ev = await audit.next(); !ev.done; ev = await audit.next()) {
    if (ev.value.type === 'complete') scorecard = ev.value.scorecard;
  }
  if (!scorecard) {
    console.error('audit produced no scorecard');
    return 2;
  }

  if (args.json) {
    console.log(JSON.stringify(scorecard, null, 2));
    return 0;
  }

  if (args.check) {
    const result = scorecard.results.find((r) => r.id === args.check);
    if (!result) {
      console.error(`no such check: ${args.check}`);
      return 3;
    }
    console.log(`${result.id}\t${result.status}\t${result.evidence ?? ''}`);
    return STATUS_EXIT[result.status] ?? 1;
  }

  console.log(`target       = ${scorecard.target_url}`);
  console.log(`site_type    = ${scorecard.site_type ?? 'auto'}`);
  console.log(`mcp_endpoint = ${scorecard.mcp_endpoint ?? '(none)'}`);
  console.log(`score_pct    = ${scorecard.score_pct}`);
  console.log('--- results ---');
  for (const result of scorecard.results) {
    console.log(`${result.status.padEnd(7)} ${result.id.padEnd(28)} ${result.evidence ?? ''}`);
  }
  return 0;
}

process.exit(await main());
