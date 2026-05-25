// Live-scoring Sandbox Durable Object — install + anc check inside an
// Alpine + musl Container, with two-phase egress (R7) enforced via the
// CF Sandbox SDK's named outbound handlers (Pattern Y). The class
// extends `@cloudflare/sandbox` and inherits the runtime egress control
// + container exec surface from `@cloudflare/containers`.
//
// 2026-05-20 discovery-move: the DO used to own the full
// ValidatedInput → InstallSpec resolution (including the brew/go
// fallbacks + the discoverBinary chain). That layer moved upstream to
// the Worker (src/worker/score/resolve-spec.ts) so chain_no_resolve
// requests bounce without spinning up a container. The DO's surface
// now starts at "given an InstallSpec, install + score" — the
// orchestration in sandbox-exec.ts is unchanged, but the request body
// crossing the DO boundary is `{spec: InstallSpec, hash: string}`
// instead of the pre-move `{input: ValidatedInput, hash: string}`.
// `loadHintsIndex` is no longer needed here either (the Worker loads
// hints once and threads them through resolveSpec).
//
// Test-mode importability:
//
//   `@cloudflare/containers` does a top-level `import { DurableObject }
//   from 'cloudflare:workers'` (workerd virtual module). Bun's test
//   runtime can't resolve `cloudflare:workers` natively; tests/bun-setup.ts
//   registers a virtual-module shim so do.ts loads inside `bun test`
//   without bringing in real DO state machinery. The shim provides no-op
//   base classes — enough for `import { Sandbox } from '@cloudflare/sandbox'`
//   to succeed at module load. Tests that exercise real DO behavior
//   (state, alarms, container exec) require a workerd-backed runtime.

import type { OutboundHandler } from '@cloudflare/containers';
import { Sandbox as BaseSandbox } from '@cloudflare/sandbox';
import { SPEC_VERSION } from '../spec-version.gen';
import * as cache from './cache';
import type { InstallSpec } from './discover-binary';
import { score as runSandboxScore, type ScoreResult } from './sandbox-exec';

// ---------------------------------------------------------------------------
// Env contract
// ---------------------------------------------------------------------------

// Wrangler injects all Worker bindings into the DO's env at construction.
// We declare only what this DO uses so tests can pass a minimal stub.
// SCORE_CACHE is optional because the DO functions correctly without it
// (the cache write is best-effort by design — failure logs but never
// blocks the user response), and tests that exercise the install + score
// flow without exercising the cache write don't need to stub it.
//
// ASSETS stays in the env shape because @cloudflare/sandbox + the
// Worker binding plumbing inject it regardless; the DO no longer
// uses it now that the hints index lives entirely in the Worker tier.
export type ScoreSandboxEnv = {
  ASSETS: Fetcher;
  SCORE_CACHE?: R2Bucket;
};

// Request body the Worker sends to the DO after 2026-05-20:
//
//   stub.fetch(new Request('https://do.internal/score', {
//     method: 'POST',
//     body: JSON.stringify({ spec: InstallSpec, hash: string }),
//   }))
//
// Pre-move shape was `{ input: ValidatedInput, hash }`; the rename to
// `spec` is the signal that resolution has already happened upstream.
// `hash` is unused in the install+score path today; it stays on the
// wire for telemetry alignment with the Worker's per-request log line.
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
  console.log(JSON.stringify({ phase: 'install', host, allowed }));
  if (allowed) return fetch(req);
  return new Response(null, { status: 403 });
};

const noHttp: OutboundHandler = async (req) => {
  const host = new URL(req.url).hostname;
  console.log(JSON.stringify({ phase: 'noHttp', host, blocked: true }));
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
  // IP. Phase 2 lockdown is lost while this flag is false — must revert
  // before merge.
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

    const result = await this.score(parsed.spec);
    if (!result.ok) {
      return json({ error: result.error, details: result.details }, statusFor(result.error));
    }

    // Write the successful scorecard to R2 so the next request for the
    // same binary short-circuits at the handler's lookupScorecard cache
    // tier. Best-effort: the cache helpers swallow R2 failures
    // (logged, never thrown). The await delays the response by one R2
    // round-trip (~30-100 ms typical); the latency cost is paid once per
    // tool per anc bump and saves a full sandbox spawn (~3-20 s) on the
    // next request. The trade is intentional and bounded.
    //
    // Branch-scoped clones skip the cache write: the cache key is
    // `scores/<binary>/<spec-version>.json` which doesn't include the
    // branch. Caching a branch-scored result would clobber the
    // default-branch scorecard for any subsequent request that hits
    // the same binary. Branch-scoring is intentionally one-off.
    if (parsed.spec.pm !== 'git-clone') {
      await writeCacheBestEffort(this.env, parsed.spec, result.value);
    }

    return json(result.value, 200);
  }

  // RPC entry point — used by tests that want to invoke the score flow
  // without round-tripping a Request. Also makes the orchestration unit
  // independently exercisable from a server-side caller (e.g. a future
  // batch-scoring cron Worker).
  async score(spec: InstallSpec): Promise<ScoreResult> {
    return runSandboxScore(this, spec);
  }
}

// Wire named handlers on the class. Done at module load so a wrangler
// binding-resolution pass picks up the static map before any handler
// invocation.
Sandbox.outboundHandlers = { allowedInstall, noHttp };

// ---------------------------------------------------------------------------
// Cache write
// ---------------------------------------------------------------------------

// Best-effort R2 write after a successful score. Skipped (with a log) when
// SCORE_CACHE isn't bound on the DO env, or when the scorecard doesn't
// carry an extractable tool version (cache.put refuses half-state, so we
// short-circuit at the surface to avoid the throw). All write paths
// inside cache.put already swallow R2 failures — this wrapper handles
// the precondition layer above that.
//
// Exported for unit tests (tests/score-do-cache-write.test.ts) since the
// Sandbox class itself isn't directly instantiable under bun:test without
// the workerd shim. The wrapper carries the full precondition + write
// flow that fetch() invokes, so testing it directly pins the cache-write
// contract without touching DO boilerplate.
export async function writeCacheBestEffort(
  env: ScoreSandboxEnv,
  spec: InstallSpec,
  value: { scorecard: unknown; anc_version: string },
): Promise<void> {
  if (!env.SCORE_CACHE) {
    console.log(JSON.stringify({ scope: 'cache.write', skipped: 'no_binding' }));
    return;
  }
  const toolVersion = extractToolVersion(value.scorecard);
  if (!toolVersion) {
    console.log(JSON.stringify({ scope: 'cache.write', skipped: 'no_tool_version', binary: spec.binary }));
    return;
  }
  // SPEC_VERSION is the proxy for anc-version in the cache key. The
  // cached payload still carries the exec-captured anc_version as data
  // — the key vs. payload split is intentional. See cache.ts module
  // header for the full rationale.
  const key = cache.keyFor(spec.binary, SPEC_VERSION);
  try {
    await cache.put(
      { SCORE_CACHE: env.SCORE_CACHE },
      key,
      value.scorecard,
      value.anc_version,
      toolVersion,
      SPEC_VERSION,
    );
  } catch (err) {
    // cache.put only throws on refusal-to-cache-half-state (missing
    // version), which the guards above already cover. Defense-in-depth:
    // a future regression that bypasses those guards still doesn't
    // surface to the user.
    console.log(JSON.stringify({ scope: 'cache.write', error: err instanceof Error ? err.message : String(err) }));
  }
}

// Pulls `scorecard.tool.version` if present. The shape is the anc
// JSON envelope; the field is populated by `anc check` from whatever
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

function statusFor(error: string): number {
  switch (error) {
    case 'chain_resolved_install_failed':
    case 'chain_resolved_no_binary_produced':
    case 'install_unsupported':
    case 'anc_check_failed':
      return 502;
    case 'timeout':
      return 504;
    case 'chain_no_resolve':
      return 404;
    case 'anc_version_unreadable':
      return 500;
    default:
      return 500;
  }
}
