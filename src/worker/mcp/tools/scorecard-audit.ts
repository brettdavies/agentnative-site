// score_cli MCP tool — cache-miss-only fresh-audit path.
//
// Composes the shared /api/score orchestrator's lookupOnly + runFreshOnly
// intents so MCP and /api/score can never drift on cache semantics or
// DO dispatch. The tool's flow (per KTD-3, KTD-4, KTD-7 of the plan):
//
//   1. MCP_LIVE_SCORING_ENABLED kill switch. When falsy, returns
//      isError: false with content { audited: false, message: "...
//      disabled by the operator..." }. The read tier stays alive on
//      get_scorecard so the cached scorecards remain available.
//   2. validateInput on the raw input. Rejection returns isError: true
//      with the validator's typed error envelope (security gate).
//   3. lookupOnly first. Curated and cached hits return isError: false
//      with audited: false + next_tool: get_scorecard — cache state is
//      data, not failure. Miss continues to the audit path.
//   4. cf-connecting-ip presence check. Missing IP returns isError: true
//      with the -32099 envelope. No anon fallback at the audit tier:
//      container-run cost is non-trivial and a shared anon bucket would
//      be a DoS vector.
//   5. MCP_AUDIT_LIMITER burst gate. The CF binding enforces 5 per
//      60-second window (the longest period CF supports). Breach
//      returns isError: true with the -32099 envelope.
//   6. KV-backed per-hour window via SCORE_KV. The plan calls for "5
//      audits per 60 minutes per IP" but the CF binding's max period is
//      60 seconds, so this layer enforces the hourly ceiling explicitly.
//      Key shape: `mcp_audit:<ip>:<hour_bucket>` where hour_bucket =
//      floor(now / 3,600,000). TTL 7200 seconds so the bucket survives
//      the window plus a one-hour grace. There's a small TOCTOU window
//      between read and write but it's bounded by the burst gate above;
//      worst-case overshoot is a handful of audits per hour, not orders
//      of magnitude.
//   7. orchestrate.runFreshOnly. resolveSpec → post-discovery cache →
//      DO dispatch via getRandom(env.SCORE, MAX_INSTANCES). The DO
//      writes the cache itself via writeCacheBestEffort; the MCP layer
//      never touches R2 directly.
//   8. Map the discriminated kind to the typed-state response.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { loadHintsIndex, lookupOnly, type OrchestrateEnv, runFreshOnly } from '../../score/orchestrate';
import { type DiscoveryHintsIndex, loadRegistryIndex, type RegistryIndex } from '../../score/registry-lookup';
import { validateInput } from '../../score/validate';
import { SPEC_VERSION } from '../../spec-version.gen';
import type { Catalog } from '../catalog';

export interface ScorecardAuditEnv extends OrchestrateEnv {
  MCP_LIVE_SCORING_ENABLED?: string;
  MCP_AUDIT_LIMITER?: { limit(o: { key: string }): Promise<{ success: boolean }> };
  SCORE_KV?: KVNamespace;
  // Staging-only release-smoke escape hatch. When bound to "true" (env.staging.vars
  // in wrangler.jsonc), score_cli honors a caller's `bypass_cache: true` argument
  // and skips the R2 read tier so the live container DO path is always exercised.
  // Bound only on staging; absent on prod so the bypass arg is silently ignored
  // there. Defense in depth: all rate limiters (MCP_AUDIT_LIMITER burst gate,
  // SCORE_KV hourly ceiling) still apply, so the bypass cannot multiply audit cost.
  MCP_CACHE_BYPASS_ALLOWED?: string;
}

const SITE_URL = 'https://anc.dev';
const HOUR_MS = 3_600_000;
const HOURLY_AUDIT_CEILING = 5;
const HOURLY_KV_TTL_SECONDS = 7200;

function textContent(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  };
}

function jsonRpcError32099(message: string) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({ jsonrpc: '2.0', error: { code: -32099, message } }, null, 2),
      },
    ],
    isError: true,
  };
}

function rawFromInput(args: {
  binary?: string;
  slug?: string;
  install?: string;
  github_url?: string;
}): { raw: string } | { error: string } {
  if (args.slug !== undefined && args.slug !== '') return { raw: args.slug };
  if (args.binary !== undefined && args.binary !== '') return { raw: args.binary };
  if (args.install !== undefined && args.install !== '') return { raw: args.install };
  if (args.github_url !== undefined && args.github_url !== '') return { raw: args.github_url };
  return { error: 'one of {slug, binary, install, github_url} must be provided' };
}

async function sha256Hex(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const buf = await crypto.subtle.digest('SHA-256', encoder.encode(input));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function consumeHourlyBudget(
  kv: KVNamespace,
  ip: string,
): Promise<{ ok: true; remaining: number } | { ok: false; current: number }> {
  const bucket = Math.floor(Date.now() / HOUR_MS);
  const key = `mcp_audit:${ip}:${bucket}`;
  const currentRaw = await kv.get(key);
  const current = currentRaw ? Number.parseInt(currentRaw, 10) : 0;
  if (Number.isNaN(current) || current >= HOURLY_AUDIT_CEILING) {
    return { ok: false, current: Number.isNaN(current) ? HOURLY_AUDIT_CEILING : current };
  }
  await kv.put(key, String(current + 1), { expirationTtl: HOURLY_KV_TTL_SECONDS });
  return { ok: true, remaining: HOURLY_AUDIT_CEILING - (current + 1) };
}

export function registerScorecardAuditTool(server: McpServer, _catalog: Catalog, env: ScorecardAuditEnv): void {
  server.tool(
    'score_cli',
    'Run a fresh container audit for a CLI when no cached scorecard exists. Provide ONE of: slug, binary, install, ' +
      'github_url (same validator as get_scorecard). On registry or R2-cache hit, returns isError: false with ' +
      'next_tool: get_scorecard — cache state is data, not failure. On cache miss, runs a metered container audit ' +
      'gated by MCP_AUDIT_LIMITER (5 per 60-second burst) AND a KV-backed per-hour window (5 audits per 60 minutes ' +
      'per IP — the plan ceiling that the CF binding alone cannot express). No anon fallback at the audit tier: a ' +
      'request without cf-connecting-ip returns -32099 immediately. Disabled when MCP_LIVE_SCORING_ENABLED is not ' +
      '"true" — the read tier on get_scorecard stays alive serving cached scorecards.',
    {
      slug: z.string().optional().describe('Registry slug, e.g. "ripgrep".'),
      binary: z.string().optional().describe('CLI binary name.'),
      install: z.string().optional().describe('Full install command, e.g. "brew install ripgrep".'),
      github_url: z.string().optional().describe('GitHub URL (https://github.com/owner/repo).'),
      bypass_cache: z
        .boolean()
        .optional()
        .describe(
          'Release-smoke escape hatch: when true AND the operator has bound MCP_CACHE_BYPASS_ALLOWED="true" ' +
            '(staging env only), skip the R2 read tier so the live container DO path is always exercised. ' +
            'Silently ignored when the env binding is absent (prod). Rate limiters still apply.',
        ),
    },
    async (args, extra) => {
      // Step 1: MCP_LIVE_SCORING_ENABLED kill switch.
      if (env.MCP_LIVE_SCORING_ENABLED !== 'true') {
        return textContent({
          audited: false,
          message:
            'live scoring is currently disabled by the operator; cached scorecards remain available via ' +
            'get_scorecard.',
        });
      }

      // Step 2: validateInput security gate (HTTPS-only, github.com
      // exact match, homoglyph guard, branch-name regex, shell-
      // metacharacter exclusion, unsupported-PM rejection).
      const choice = rawFromInput(args);
      if ('error' in choice) {
        return { content: [{ type: 'text' as const, text: choice.error }], isError: true };
      }

      let registryIndex: RegistryIndex;
      let hintsIndex: DiscoveryHintsIndex;
      try {
        registryIndex = await loadRegistryIndex(env);
        hintsIndex = await loadHintsIndex(env);
      } catch (err) {
        return {
          content: [
            { type: 'text' as const, text: `infrastructure error loading registry indexes: ${(err as Error).message}` },
          ],
          isError: true,
        };
      }

      const validated = validateInput(choice.raw, registryIndex);
      if (validated.kind === 'unknown') {
        return {
          content: [
            { type: 'text' as const, text: JSON.stringify({ error: 'invalid_input', code: validated.error }, null, 2) },
          ],
          isError: true,
        };
      }

      // Step 3: lookupOnly — registry tier + R2 cache tier. A hit
      // short-circuits the entire audit path; cache state is data.
      //
      // Cache bypass: when the caller asks for bypass_cache and the env binding
      // MCP_CACHE_BYPASS_ALLOWED is "true" (staging only), skip the R2 read tier
      // so the live container path runs even on a cached binary. Curated registry
      // entries always win regardless; the bypass only affects the R2 cache tier.
      // Without the env binding, bypass_cache is silently ignored, so prod
      // behavior is unchanged even if the arg is forged in the request.
      const bypassCache = args.bypass_cache === true && env.MCP_CACHE_BYPASS_ALLOWED === 'true';
      const lookup = await lookupOnly(validated, env, registryIndex, hintsIndex, {
        specVersion: SPEC_VERSION,
        skipCache: bypassCache,
      });

      if (lookup.kind === 'curated') {
        const scorecardUrlPath = lookup.scorecard_url ?? `/score/${lookup.entry.name}`;
        const scorecard_url = scorecardUrlPath.startsWith('http') ? scorecardUrlPath : `${SITE_URL}${scorecardUrlPath}`;
        return textContent({
          audited: false,
          source: 'registry',
          next_tool: 'get_scorecard',
          scorecard_url,
          message:
            `a curated scorecard for "${lookup.entry.name}" already exists; call get_scorecard for the inline ` +
            'record.',
        });
      }

      if (lookup.kind === 'cached') {
        const scorecard = lookup.scorecard as { tool?: { binary?: string | null } } | null;
        const binary = scorecard?.tool?.binary ?? null;
        const scorecard_url = binary ? `${SITE_URL}/score/live/${binary}` : null;
        return textContent({
          audited: false,
          source: 'live-cache',
          next_tool: 'get_scorecard',
          scorecard_url,
          message: 'a cached live-score result already exists; call get_scorecard for the inline record.',
        });
      }

      // Step 4: cf-connecting-ip presence check (no anon fallback).
      const ip = extra?.requestInfo?.headers?.['cf-connecting-ip'];
      const ipString = typeof ip === 'string' ? ip : null;
      if (!ipString) {
        return jsonRpcError32099(
          'fresh audits require a source IP; missing cf-connecting-ip is not rate-limit-keyable on the audit tier.',
        );
      }

      // Step 5: MCP_AUDIT_LIMITER burst gate.
      if (env.MCP_AUDIT_LIMITER) {
        const { success } = await env.MCP_AUDIT_LIMITER.limit({ key: ipString });
        if (!success) {
          return jsonRpcError32099('audit rate limit exceeded — burst window (5 per 60 seconds per source).');
        }
      }

      // Step 6: KV-backed per-hour window. The CF binding's max period
      // is 60 seconds; this layer enforces the plan's "5 per 60 minutes"
      // ceiling.
      if (env.SCORE_KV) {
        const budget = await consumeHourlyBudget(env.SCORE_KV, ipString);
        if (!budget.ok) {
          return jsonRpcError32099('audit rate limit exceeded — fresh audits limited to 5 per hour per source.');
        }
      }

      // Step 7: orchestrate.runFreshOnly — resolveSpec + DO dispatch.
      // The DO calls writeCacheBestEffort itself; MCP never writes R2.
      //
      // Cache bypass also covers the post-discovery cache tier (orchestrate.ts
      // tier 3); otherwise a github-url input whose discovered binary IS in cache
      // would short-circuit at step 6.5 and produce kind=cache_post_hit, which
      // again does not exercise the DO. Same gating: caller arg + staging-only
      // env binding.
      const inputHash = await sha256Hex(choice.raw);
      const result = await runFreshOnly(validated, env, hintsIndex, {
        specVersion: SPEC_VERSION,
        inputHash,
        skipCachePost: bypassCache,
      });

      // Step 8: map kind to typed-state response.
      switch (result.kind) {
        case 'cache_post_hit': {
          const scorecard_url = `${SITE_URL}/score/live/${result.spec.binary}`;
          return textContent({
            audited: false,
            source: 'live-cache',
            next_tool: 'get_scorecard',
            scorecard_url,
            scorecard: result.scorecard,
            anc_version: result.anc_version,
            spec_version: SPEC_VERSION,
            message: 'post-discovery cache hit; the next get_scorecard call will return this inline.',
          });
        }
        case 'fresh': {
          const scorecard_url = `${SITE_URL}/score/live/${result.spec.binary}`;
          return textContent({
            audited: true,
            source: 'fresh-audit',
            scorecard_url,
            scorecard: result.scorecard,
            anc_version: result.anc_version,
            spec_version: SPEC_VERSION,
          });
        }
        case 'resolution_error': {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(
                  { error: result.error, details: result.details ?? null, stage: 'resolution' },
                  null,
                  2,
                ),
              },
            ],
            isError: true,
          };
        }
        case 'sandbox_unavailable': {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'sandbox binding unavailable; the container scoring tier is offline.',
              },
            ],
            isError: true,
          };
        }
        case 'sandbox_stub_until_u6': {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'sandbox returned a stub envelope; the container scoring tier is mid-rollback.',
              },
            ],
            isError: true,
          };
        }
        case 'do_error': {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(
                  { error: result.error, details: result.details ?? null, stage: 'sandbox' },
                  null,
                  2,
                ),
              },
            ],
            isError: true,
          };
        }
        case 'incomplete_response_contract': {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(
                  { error: 'incomplete_response_contract', reason: result.reason, stage: 'sandbox' },
                  null,
                  2,
                ),
              },
            ],
            isError: true,
          };
        }
      }
    },
  );
}
