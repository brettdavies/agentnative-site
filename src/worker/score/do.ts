// Live-scoring Sandbox Durable Object: install + anc audit inside a
// Debian-slim Container, with two-phase egress (R7) enforced via the CF
// Sandbox SDK's named outbound handlers (Pattern Y). The class extends
// `@cloudflare/sandbox` and inherits the runtime egress control and the
// container exec surface from `@cloudflare/containers`.
//
// Contract with the Worker: `POST { spec: InstallSpec, hash }` answers a
// 200 whose body is NDJSON. One `phase` line per sandbox boundary
// (installing, installed, verifying, lockdown, auditing), then exactly one
// result line: the success envelope `{ scorecard, anc_version, install_ms,
// anc_audit_ms, source_sha? }` or `{ error, details? }`. The R2 write and
// the `cli:<target>` purge run before the result line is written, so a
// reader that sees the result can read the record back. The body starts
// streaming before the run finishes; the Durable Object stays active while
// the response stream is open.
//
// Test-mode importability:
//
//   `@cloudflare/containers` does a top-level `import { DurableObject }
//   from 'cloudflare:workers'` (workerd virtual module). Bun's test
//   runtime can't resolve `cloudflare:workers` natively; tests/bun-setup.ts
//   registers a virtual-module shim so do.ts loads inside `bun test`
//   without bringing in real DO state machinery. The shim provides no-op
//   base classes, enough for `import { Sandbox } from '@cloudflare/sandbox'`
//   to succeed at module load. Tests that exercise real DO behavior
//   (state, alarms, container exec) require a workerd-backed runtime;
//   `streamScore` and `writeCacheBestEffort` are exported so the body
//   contract and the write contract are testable without the class.

import type { OutboundHandler } from '@cloudflare/containers';
import { Sandbox as BaseSandbox } from '@cloudflare/sandbox';
import { targetOfSpec } from '../../shared/audit-routes';
import { invokeCachedPurge } from '../audit-web/hit-min-purge';
import { cliTargetTag } from '../audit-web/hit-min-tags';
import { SPEC_VERSION } from '../spec-version.gen';
import { emitLog } from '../telemetry/log';
import * as cache from './cache';
import type { InstallSpec } from './discover-binary';
import { score as runSandboxScore, type SandboxPhase, type ScoreResult } from './sandbox-exec';

// ---------------------------------------------------------------------------
// Env contract
// ---------------------------------------------------------------------------

// Wrangler injects all Worker bindings into the DO's env at construction.
// We declare only what this DO uses so tests can pass a minimal stub.
// SCORE_CACHE is optional because the DO functions correctly without it
// (the cache write is best-effort by design: failure logs but never
// blocks the user response), and tests that exercise the install + score
// flow without exercising the cache write don't need to stub it.
//
// ASSETS stays in the env shape because @cloudflare/sandbox + the
// Worker binding plumbing inject it regardless; the DO does not read it.
export type ScoreSandboxEnv = {
  ASSETS: Fetcher;
  SCORE_CACHE?: R2Bucket;
};

// `hash` is unused in the install+score path; it stays on the wire for
// telemetry alignment with the Worker's per-request log line.
export type ScoreRequestBody = {
  spec: InstallSpec;
  hash: string;
};

// ---------------------------------------------------------------------------
// Outbound handlers (Pattern Y — named, runtime-swappable)
//
// Per-request egress observability is why we picked named handlers
// (Pattern Y) over a static allowedHosts list: every outbound attempt
// during install OR after the noHttp lockdown emits one structured log
// line so attempted-but-blocked egress surfaces as a security signal in
// Workers Logs.
// ---------------------------------------------------------------------------

type AllowedInstallParams = { allowedHostnames: string[] };

// Match a hostname against an allowlist that supports leading-wildcard
// entries (`*.githubusercontent.com` matches
// `objects.githubusercontent.com`, `release-assets.githubusercontent.com`,
// etc.). Exact matches still work without the wildcard. Kept
// conservative: only `*.` prefix is supported (not arbitrary glob), and
// the wildcard requires AT LEAST ONE subdomain label — bare apex hits
// (`githubusercontent.com`) must be allowlisted explicitly to avoid
// over-permissive matching when the apex domain has different trust
// semantics from its CDN subdomains.
function hostnameAllowed(host: string, allowlist: readonly string[]): boolean {
  for (const entry of allowlist) {
    if (entry === host) return true;
    if (entry.startsWith('*.')) {
      const suffix = entry.slice(1); // `.githubusercontent.com`
      if (host.length > suffix.length && host.endsWith(suffix)) return true;
    }
  }
  return false;
}

const allowedInstall: OutboundHandler<unknown, AllowedInstallParams> = async (req, _env, ctx) => {
  const host = new URL(req.url).hostname;
  const allowed = hostnameAllowed(host, ctx.params.allowedHostnames);
  emitLog({ scope: 'score.outbound' }, { phase: 'install', host, allowed });
  if (allowed) return fetch(req);
  return new Response(null, { status: 403 });
};

const noHttp: OutboundHandler = async (req) => {
  const host = new URL(req.url).hostname;
  emitLog({ scope: 'score.outbound' }, { phase: 'noHttp', host, blocked: true });
  return new Response(null, { status: 403 });
};

// Export the handler shapes so tests can call them as plain functions
// without instantiating the DO class. Useful for the per-request log
// shape assertion (test scenario (c)).
export const handlers = { allowedInstall, noHttp };

// ---------------------------------------------------------------------------
// DO class
// ---------------------------------------------------------------------------

export class Sandbox extends BaseSandbox<ScoreSandboxEnv> {
  // DIAGNOSTIC: HTTPS interception OFF to isolate whether the SDK's
  // Worker-fetch passthrough is the cause of the upstream-403 regressions
  // seen on staging after the Debian-slim rework. With interception off,
  // container HTTPS bypasses allowedInstall + noHttp entirely; outbound
  // hits upstream from the CF Container IP rather than the Worker fetch
  // IP. Phase 2 lockdown is lost while this flag is false.
  override interceptHttps = false;

  // Override BaseSandbox.fetch (which normally proxies to the container's
  // HTTP listener) to dispatch the score endpoint instead. Our container
  // is a compute substrate exposed via exec(), not an HTTP service.
  override async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return json({ error: 'method_not_allowed' }, 405);
    }

    let parsed: ScoreRequestBody;
    try {
      const body = (await request.json()) as ScoreRequestBody;
      if (!body || typeof body !== 'object' || !body.spec) {
        return json({ error: 'invalid_do_body' }, 400);
      }
      parsed = body;
    } catch {
      return json({ error: 'invalid_do_body' }, 400);
    }

    const body = streamScore(parsed.spec, {
      env: this.env,
      run: (spec, onPhase) => this.score(spec, onPhase),
      purge: (tags) => invokeCachedPurge(this.ctx, tags),
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'application/x-ndjson; charset=utf-8' } });
  }

  // RPC entry point: the score flow without a Request round-trip, for a
  // server-side caller such as a batch-scoring cron Worker.
  async score(spec: InstallSpec, onPhase?: (phase: SandboxPhase) => void): Promise<ScoreResult> {
    return runSandboxScore(this, spec, { onPhase });
  }
}

// Wire named handlers on the class. Done at module load so a wrangler
// binding-resolution pass picks up the static map before any handler
// invocation.
Sandbox.outboundHandlers = { allowedInstall, noHttp };

// ---------------------------------------------------------------------------
// The NDJSON body
// ---------------------------------------------------------------------------

export type StreamScoreDeps = {
  env: ScoreSandboxEnv;
  /** The sandbox run; the callback receives each phase as it begins. */
  run: (spec: InstallSpec, onPhase: (phase: SandboxPhase) => void) => Promise<ScoreResult>;
  /** The `Cached` entrypoint's purge RPC; a throw is logged, never raised. */
  purge: (tags: string[]) => Promise<void>;
  now?: () => string;
};

/**
 * The response body for one run: a `phase` line per boundary, then one
 * result line after the R2 write and its purge. The body is returned at
 * once; the run continues behind it.
 */
export function streamScore(spec: InstallSpec, deps: StreamScoreDeps): ReadableStream<Uint8Array> {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const now = deps.now ?? (() => new Date().toISOString());
  const line = (payload: unknown) => writer.write(encoder.encode(`${JSON.stringify(payload)}\n`)).catch(() => {});
  void (async () => {
    try {
      const result = await deps.run(spec, (phase) => {
        void line({ type: 'phase', phase, at: now() });
      });
      if (result.ok) {
        await writeCacheBestEffort(deps.env, spec, result.value, deps.purge);
        await line(result.value);
      } else {
        await line({ error: result.error, ...(result.details !== undefined ? { details: result.details } : {}) });
      }
    } catch (err) {
      await line({ error: 'sandbox_exception', details: err instanceof Error ? err.message : String(err) });
    } finally {
      await writer.close().catch(() => {});
    }
  })();
  return readable;
}

// ---------------------------------------------------------------------------
// Cache write
// ---------------------------------------------------------------------------

export type ScoredValue = { scorecard: unknown; anc_version: string; source_sha?: string };

// Best-effort R2 write after a successful score, under the key the result
// route reads: `scores/<binary>/...` for an installed binary and
// `scores/<owner>/<repo>@<branch>/...` for a source clone. The per-family
// precondition is checked here so cache.put's refusal never throws at
// runtime: a binary record needs the scorecard's tool version, a branch
// record needs the SHA the clone printed (a source run may report no
// tool version). Skipped with a log when SCORE_CACHE isn't bound. Once
// R2 accepts the record, `cli:<target>` is purged through the RPC the
// caller passes; a failed purge is logged and never thrown.
export async function writeCacheBestEffort(
  env: ScoreSandboxEnv,
  spec: InstallSpec,
  value: ScoredValue,
  purge?: (tags: string[]) => Promise<void>,
): Promise<void> {
  if (!env.SCORE_CACHE) {
    emitLog({ scope: 'cache.write' }, { skipped: 'no_binding' });
    return;
  }
  const target = targetOfSpec(spec);
  const toolVersion = extractToolVersion(value.scorecard) ?? '';
  const sourceSha = spec.pm === 'git-clone' ? value.source_sha : undefined;
  if (spec.pm === 'git-clone' && !sourceSha) {
    emitLog({ scope: 'cache.write' }, { skipped: 'no_source_sha', target });
    return;
  }
  if (spec.pm !== 'git-clone' && !toolVersion) {
    emitLog({ scope: 'cache.write' }, { skipped: 'no_tool_version', binary: spec.binary });
    return;
  }
  // SPEC_VERSION is the proxy for anc-version in the cache key. The
  // cached payload still carries the exec-captured anc_version as data;
  // the key vs. payload split is intentional. See cache.ts module
  // header for the full rationale.
  const key = cache.keyFor(target, SPEC_VERSION);
  let wrote = false;
  try {
    wrote = await cache.put(
      { SCORE_CACHE: env.SCORE_CACHE },
      key,
      value.scorecard,
      value.anc_version,
      toolVersion,
      SPEC_VERSION,
      sourceSha,
    );
  } catch (err) {
    // cache.put only throws on refusal-to-cache-half-state, which the
    // guards above already cover. Defense-in-depth: a future regression
    // that bypasses those guards still doesn't surface to the user.
    emitLog({ scope: 'cache.write' }, { error: err instanceof Error ? err.message : String(err) });
  }
  if (!wrote || !purge) return;
  const tags = [cliTargetTag(target)];
  try {
    await purge(tags);
  } catch (err) {
    emitLog({ scope: 'hit-min-purge' }, { error: err instanceof Error ? err.message : String(err), tags });
  }
}

// Pulls `scorecard.tool.version` if present. The shape is the anc
// JSON envelope; the field is populated by `anc audit` from whatever
// version flag the tool exposes. Unknown values bail out so cache.put's
// refusal-to-cache-half-state isn't reached at runtime. Exported for
// the same unit-test reason as writeCacheBestEffort.
export function extractToolVersion(scorecard: unknown): string | null {
  if (typeof scorecard !== 'object' || scorecard === null) return null;
  const tool = (scorecard as { tool?: unknown }).tool;
  if (typeof tool !== 'object' || tool === null) return null;
  const version = (tool as { version?: unknown }).version;
  if (typeof version !== 'string' || version.length === 0) return null;
  return version;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function json(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
