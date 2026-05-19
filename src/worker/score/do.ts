// Live-scoring Sandbox Durable Object — install + anc check inside an
// Alpine + musl Container, with two-phase egress (R7) enforced via the
// CF Sandbox SDK's named outbound handlers (Pattern Y, plan K-decision).
//
// Plan U6 (docs/plans/2026-04-28-002-feat-live-scoring-cf-sandbox-plan.md
// lines 1817-1944). The U3 stub this replaces returned `{error:
// 'sandbox_stub_until_u6'}` from a placeholder fetch(); the real class
// here extends `@cloudflare/sandbox` and inherits the runtime egress
// control + container exec surface from `@cloudflare/containers`.
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
import { discoverBinary, type InstallSpec } from './discover-binary';
import type { DiscoveryHintsIndex } from './registry-lookup';
import { score as runSandboxScore, type ScoreResult } from './sandbox-exec';
import type { ValidatedInput } from './validate';

export type BrewFallbackResult =
  | { ok: true; value: InstallSpec }
  | { ok: false; error: 'install_unsupported'; details: 'pm=brew_only' };

// ---------------------------------------------------------------------------
// Env contract
// ---------------------------------------------------------------------------

// Wrangler injects all Worker bindings into the DO's env at construction.
// We declare only what this DO uses so tests can pass a minimal stub.
// SCORE_CACHE is optional because the DO functions correctly without it
// (the cache write is best-effort by design — failure logs but never
// blocks the user response), and tests that exercise the install + score
// flow without exercising the cache write don't need to stub it.
export type ScoreSandboxEnv = {
  ASSETS: Fetcher;
  SCORE_CACHE?: R2Bucket;
};

// Body shape U5's handler.ts sends:
//   stub.fetch(new Request('https://do.internal/score', {
//     method: 'POST',
//     body: JSON.stringify({ input: validated, hash: inputHash }),
//   }))
export type ScoreRequestBody = {
  input: ValidatedInput;
  hash: string;
};

// ---------------------------------------------------------------------------
// Outbound handlers (Pattern Y — named, runtime-swappable)
//
// Per-request egress observability is the design rationale for choosing
// named handlers (Pattern Y) over a static allowedHosts list (Pattern X)
// in the plan K-decision: every outbound attempt during install OR after
// the noHttp lockdown emits one structured log line so attempted-but-
// blocked egress surfaces as a security signal in Workers Logs.
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
      if (!body || typeof body !== 'object' || !body.input) {
        return json({ error: 'invalid_do_body' }, 400);
      }
      parsed = body;
    } catch {
      return json({ error: 'invalid_do_body' }, 400);
    }

    const spec = await this.resolveSpec(parsed.input);
    if (!spec.ok) {
      const body: { error: string; details?: string } = { error: spec.error };
      if (spec.details) body.details = spec.details;
      return json(body, statusFor(spec.error));
    }

    const result = await this.score(spec.value);
    if (!result.ok) {
      return json({ error: result.error, details: result.details }, statusFor(result.error));
    }

    // Plan U7: write the successful scorecard to R2 so the next request
    // for the same binary short-circuits at the handler's lookupScorecard
    // cache tier. Best-effort: the cache helpers swallow R2 failures
    // (logged, never thrown). The await delays the response by one R2
    // round-trip (~30-100 ms typical); the latency cost is paid once per
    // tool per anc bump and saves a full sandbox spawn (~3-20 s) on the
    // next request. The trade is intentional and bounded.
    await writeCacheBestEffort(this.env, spec.value, result.value);

    return json(result.value, 200);
  }

  // RPC entry point — used by tests that want to invoke the score flow
  // without round-tripping a Request. Also makes the orchestration unit
  // independently exercisable from a server-side caller (e.g. a future
  // batch-scoring cron Worker).
  async score(spec: InstallSpec): Promise<ScoreResult> {
    return runSandboxScore(this, spec);
  }

  // Hints index — cached per DO instance (one fetch per cold DO). DO
  // instance lifetime is bounded by container sleepAfter (5 min by
  // plan U6), so cold-fetches are amortized across reuse.
  private hintsPromise: Promise<DiscoveryHintsIndex> | null = null;
  private async loadHintsIndex(): Promise<DiscoveryHintsIndex> {
    if (!this.hintsPromise) {
      this.hintsPromise = this.env.ASSETS.fetch(new Request('https://assets.internal/discovery-hints-index.json'))
        .then((r) => {
          if (!r.ok) throw new Error(`hints fetch ${r.status}`);
          return r.json() as Promise<DiscoveryHintsIndex>;
        })
        .catch((err) => {
          this.hintsPromise = null;
          throw err;
        });
    }
    return this.hintsPromise;
  }

  private async resolveSpec(
    input: ValidatedInput,
  ): Promise<{ ok: true; value: InstallSpec } | { ok: false; error: string; details?: string }> {
    if (input.kind === 'install-command') {
      // Brew discovery-fallback (2026-05-18 rework). Linuxbrew on Linux
      // is too slow for the 60 s combined install+score budget; instead
      // of installing brew in the image, treat `brew install <pkg>`
      // user-input as a hint to find an alternative PM via the
      // discovery chain. If discovery succeeds, the substituted spec
      // runs through the normal install path; if it misses, the
      // request bounces as install_unsupported pm=brew_only so the
      // user-facing CTA distinguishes "brew has no peer for this tool"
      // from "we can't run brew at all". See the K-decision in the
      // 2026-05-18 handoff for the Linuxbrew-vs-fallback comparison.
      if (input.spec.pm === 'brew') {
        const hints = await this.loadHintsIndex();
        return await resolveBrewFallback(input.spec.package, hints);
      }
      if (input.spec.pm === 'go') {
        // `go install <module>@latest` would compile from source —
        // violating U2's binary-only premise. Redirect through the
        // discovery chain (parallel pattern to brew): if the module
        // path points at a github.com repo AND that repo ships a
        // GitHub release binary, install via `direct`. If not, bounce
        // as install_unsupported pm=go_no_binary so the user-facing
        // CTA surfaces the no-binary case rather than starting a
        // compile that would time out.
        const hints = await this.loadHintsIndex();
        return await resolveGoFallback(input.spec.package, hints);
      }
      return { ok: true, value: input.spec };
    }
    if (input.kind === 'github-url') {
      const hints = await this.loadHintsIndex();
      const result = await discoverBinary({
        owner: input.owner,
        repo: input.repo,
        hintsIndex: hints,
      });
      if (result.ok) return { ok: true, value: result.spec };
      return { ok: false, error: result.error };
    }
    // slug-miss path: registry didn't have a scorecard for the slug AND
    // U6 doesn't live-score slugs (deferred). Bounce with the same code
    // the GET path uses so the front-end can render the same CTA.
    return { ok: false, error: 'chain_no_resolve' };
  }
}

// ---------------------------------------------------------------------------
// Brew discovery-fallback
//
// `brew install <pkg>` user input is translated to an alternative PM
// via the discovery chain. brew_only bounces happen when:
//   - the formula isn't on formulae.brew.sh (404 or fetch error), OR
//   - the formula's homepage isn't a github.com URL, OR
//   - the discovery chain misses every distribution OR loops back to
//     brew (the chain's brew-last priority should prevent the loop,
//     but the guard catches a regression there).
//
// Fetcher injection lets tests pin behavior without touching
// globalThis.fetch.
// ---------------------------------------------------------------------------

export async function resolveBrewFallback(
  pkg: string,
  hintsIndex: DiscoveryHintsIndex,
  fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
): Promise<BrewFallbackResult> {
  const formula = await fetchBrewFormula(pkg, fetcher);
  if (!formula) {
    return { ok: false, error: 'install_unsupported', details: 'pm=brew_only' };
  }
  const ownerRepo = parseGithubOwnerRepo(formula.homepage);
  if (!ownerRepo) {
    return { ok: false, error: 'install_unsupported', details: 'pm=brew_only' };
  }
  const result = await discoverBinary({
    owner: ownerRepo.owner,
    repo: ownerRepo.repo,
    hintsIndex,
    fetcher,
  });
  if (result.ok && result.spec.pm !== 'brew') {
    return { ok: true, value: result.spec };
  }
  return { ok: false, error: 'install_unsupported', details: 'pm=brew_only' };
}

// ---------------------------------------------------------------------------
// Go discovery-fallback
//
// `go install <module>@latest` is source-compilation by design — Go
// modules don't ship binaries. Running it on the sandbox would either
// require a Go toolchain capable of compiling within the 60 s budget
// (impossible on CF Containers basic — see 2026-05-18 staging matrix)
// OR violate U2's binary-only premise. We redirect through the
// discovery chain: a module path of the form
// `github.com/<owner>/<repo>/...` is treated as a GitHub-URL input,
// and discoverBinary picks the GitHub Releases asset (Step 2) for
// tools that ship binaries (glow, lazygit, gh, fzf, etc.). Modules
// outside github.com OR github.com repos without release binaries
// bounce as install_unsupported pm=go_no_binary — fast-fail UX rather
// than a long compile that times out.
// ---------------------------------------------------------------------------

export type GoFallbackResult =
  | { ok: true; value: InstallSpec }
  | { ok: false; error: 'install_unsupported'; details: 'pm=go_no_binary' };

export async function resolveGoFallback(
  modulePath: string,
  hintsIndex: DiscoveryHintsIndex,
  fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
): Promise<GoFallbackResult> {
  const ownerRepo = parseGoModuleOwnerRepo(modulePath);
  if (!ownerRepo) {
    return { ok: false, error: 'install_unsupported', details: 'pm=go_no_binary' };
  }
  const result = await discoverBinary({
    owner: ownerRepo.owner,
    repo: ownerRepo.repo,
    hintsIndex,
    fetcher,
  });
  // Only accept a `direct` resolution (Step 2 GitHub Releases asset)
  // or a non-go cross-PM resolution. If discovery looped back to
  // `go` somehow (shouldn't — Step 3 picks brew last among PMs,
  // and Step 4 README parse won't return pm=go for a `go install`
  // input), bounce honestly to avoid infinite indirection.
  if (result.ok && result.spec.pm !== 'go') {
    return { ok: true, value: result.spec };
  }
  return { ok: false, error: 'install_unsupported', details: 'pm=go_no_binary' };
}

// Parse a Go module path of the form `github.com/<owner>/<repo>[/...]`
// into { owner, repo }. Subpath segments (e.g. `cmd/humanize`) are
// stripped — the GitHub release for the repo applies, regardless of
// which subpackage the module declares. Returns null for non-github
// module paths (rsc.io/quote, golang.org/x/..., etc.) — those have no
// GitHub release equivalent and bounce as go_no_binary.
function parseGoModuleOwnerRepo(modulePath: string): { owner: string; repo: string } | null {
  // Strip any @ version suffix the parser might have left in place,
  // defensively (parse-install already does this, but the fallback
  // shouldn't depend on the caller's hygiene).
  const cleaned = modulePath.split('@')[0];
  const segments = cleaned.split('/').filter(Boolean);
  if (segments.length < 3) return null;
  if (segments[0] !== 'github.com') return null;
  const owner = segments[1];
  const repo = segments[2];
  if (!owner || !repo) return null;
  return { owner, repo };
}

// ---------------------------------------------------------------------------
// Brew formula fetcher (discovery-fallback support)
// ---------------------------------------------------------------------------

type BrewFormulaShape = {
  homepage?: string;
};

// Short 2 s timeout: discovery already runs against 5+ registries with
// their own deadlines; stacking another long timeout here would hurt
// the worst-case latency more than the bounce itself.
async function fetchBrewFormula(pkg: string, fetcher: typeof fetch): Promise<BrewFormulaShape | null> {
  const url = `https://formulae.brew.sh/api/formula/${encodeURIComponent(pkg.toLowerCase())}.json`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 2_000);
  try {
    const res = await fetcher(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'anc-discovery/1.0 (+https://anc.dev)' },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as BrewFormulaShape;
    return data ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// Mirrors validate.ts's GITHUB_URL_RE shape so the same repo-root
// constraints apply — `tree/branch` paths in a formula's homepage
// field don't drift into resolveSpec.
export function parseGithubOwnerRepo(url: string | undefined): { owner: string; repo: string } | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.hostname !== 'github.com') return null;
  const segments = parsed.pathname.split('/').filter(Boolean);
  if (segments.length < 2) return null;
  const owner = segments[0];
  const repo = segments[1].replace(/\.git$/, '');
  if (!owner || !repo) return null;
  return { owner, repo };
}

// Wire named handlers on the class. Done at module load so a wrangler
// binding-resolution pass picks up the static map before any handler
// invocation. Plan U6 test scenario (a) asserts both keys are present.
Sandbox.outboundHandlers = { allowedInstall, noHttp };

// ---------------------------------------------------------------------------
// Cache write (plan U7)
// ---------------------------------------------------------------------------

// Best-effort R2 write after a successful score. Skipped (with a log) when
// SCORE_CACHE isn't bound on the DO env, or when the scorecard doesn't
// carry an extractable tool version (cache.put refuses half-state, so we
// short-circuit at the surface to avoid the throw). All write paths
// inside cache.put already swallow R2 failures — this wrapper handles
// the precondition layer above that.
async function writeCacheBestEffort(
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
  // SPEC_VERSION is the proxy for anc-version in the cache key
  // (handoff Decision 2 + gotcha 3). The cached payload still carries
  // the exec-captured anc_version as data — the key vs. payload split
  // is intentional. See cache.ts module header.
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
// refusal-to-cache-half-state isn't reached at runtime.
function extractToolVersion(scorecard: unknown): string | null {
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
