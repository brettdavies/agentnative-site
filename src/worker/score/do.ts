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
import { discoverBinary, type InstallSpec } from './discover-binary';
import type { DiscoveryHintsIndex } from './registry-lookup';
import { score as runSandboxScore, type ScoreResult } from './sandbox-exec';
import type { ValidatedInput } from './validate';

// ---------------------------------------------------------------------------
// Env contract
// ---------------------------------------------------------------------------

// Wrangler injects all Worker bindings into the DO's env at construction.
// We declare only what this DO uses so tests can pass a minimal stub.
export type ScoreSandboxEnv = {
  ASSETS: Fetcher;
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

const allowedInstall: OutboundHandler<unknown, AllowedInstallParams> = async (req, _env, ctx) => {
  const host = new URL(req.url).hostname;
  const allowed = ctx.params.allowedHostnames.includes(host);
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
  // TLS interception so HTTPS install hosts (crates.io, pypi.org, etc.)
  // flow through our outbound handlers. Default-on as of CF Sandbox 0.8.7
  // (PR #550), declared explicitly for grep-ability.
  override interceptHttps = true;

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
    if (!spec.ok) return json({ error: spec.error }, statusFor(spec.error));

    const result = await this.score(spec.value);
    if (!result.ok) {
      return json({ error: result.error, details: result.details }, statusFor(result.error));
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
  ): Promise<{ ok: true; value: InstallSpec } | { ok: false; error: string }> {
    if (input.kind === 'install-command') {
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

// Wire named handlers on the class. Done at module load so a wrangler
// binding-resolution pass picks up the static map before any handler
// invocation. Plan U6 test scenario (a) asserts both keys are present.
Sandbox.outboundHandlers = { allowedInstall, noHttp };

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
