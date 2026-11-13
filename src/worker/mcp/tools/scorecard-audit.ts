// score_cli MCP tool — cache-miss-only fresh-audit path.
//
// Composes the CLI lane core's read tier and the shared orchestrator's
// fresh run, so this tool, the transact endpoint, and the result route
// cannot drift on cache semantics, DO dispatch, or the envelope they hand
// back. Every scorecard-bearing answer here is that one envelope. The flow:
//
//   1. Kill switches: MCP_LIVE_SCORING_ENABLED, then SCORE_KV
//      `scoring_disabled`, the switch that stops every live CLI audit.
//      Either one off returns isError: false with content
//      { audited: false, message: "...disabled by the operator...",
//      next_tool: "get_scorecard" }.
//      The read tier stays alive on get_scorecard so the cached
//      scorecards remain available.
//   2. validateInput on the raw input. Rejection returns isError: true
//      with the validator's typed error envelope (security gate).
//   3. readCliTier first. Curated and cached hits return isError: false
//      with audited: false + next_tool: get_scorecard beside the envelope
//      — cache state is data, not failure. Miss continues to the audit path.
//   4. cf-connecting-ip presence check. Missing IP returns isError: true
//      with the -32099 envelope. No anon fallback at the audit tier:
//      container-run cost is non-trivial and a shared anon bucket would
//      be a DoS vector.
//   5. MCP_AUDIT_LIMITER burst gate. The CF binding enforces 5 per
//      60-second window (the longest period CF supports). Breach
//      returns isError: true with the -32099 envelope.
//   6. KV-backed per-hour window via SCORE_KV. The plan calls for "5
//      audits per 60 minutes per IP" but the CF binding's max period is
//      60 seconds, so this layer enforces the hourly ceiling explicitly,
//      on the shared counter in audit-web/limiter.ts. Key shape:
//      `mcp_audit:<ip>:<hour_bucket>` where hour_bucket =
//      floor(now / 3,600,000). TTL 7200 seconds so the bucket survives
//      the window plus a one-hour grace. There's a small TOCTOU window
//      between read and write but it's bounded by the burst gate above;
//      worst-case overshoot is a handful of audits per hour, not orders
//      of magnitude.
//   6.5 Claim the input's AuditJob and mark its in-flight flags, as the
//      transact endpoint does. A job another run holds is awaited and
//      answered from that run's terminal line, so one input runs one
//      container audit at a time; this run's own terminal line is appended
//      to its job for every caller attached to it.
//   7. orchestrate.runFreshOnly. resolveSpec → post-discovery cache →
//      dispatch to the target's own DO. The DO
//      writes the cache itself via writeCacheBestEffort; the MCP layer
//      never touches R2 directly.
//   8. Map the discriminated kind to the typed-state response.

import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { auditErrorFor, CTA_RETRY, type TerminalEvent } from '../../../shared/audit-events';
import { normalizeTarget, targetOfSpec } from '../../../shared/audit-routes';
import {
  awaitInFlightTerminal,
  awaitJobTerminal,
  claimJob,
  type InFlightEnv,
  InFlightFlags,
  RELAY_DEADLINE_SECONDS,
} from '../../audit/inflight';
import { consumeHourlyBucketBudget, HOURLY_CONTENTION_MESSAGE } from '../../audit-web/limiter';
import {
  branchResultTarget,
  type CliCoreEnv,
  cliRunEnvelope,
  outcomeOf,
  readCliTier,
  terminalEventOf,
} from '../../score/core';
import { isScoringDisabled } from '../../score/kill-switch';
import { loadHintsIndex, type OrchestrateEnv, type RunFreshResult, runFreshOnly } from '../../score/orchestrate';
import { type DiscoveryHintsIndex, loadRegistryIndex, type RegistryIndex } from '../../score/registry-lookup';
import { validateInput } from '../../score/validate';
import { SPEC_VERSION } from '../../spec-version.gen';
import type { Catalog } from '../catalog';
import { getMcpRequest } from '../request-context';
import { requestHeader } from '../request-header';
import { siteOrigin } from '../site-origin';

export interface ScorecardAuditEnv extends OrchestrateEnv, CliCoreEnv, InFlightEnv {
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

const HOURLY_AUDIT_CEILING = 5;

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

// The endpoint keys an in-flight run by the classifier's normalized target.
function inFlightKey(raw: string): string {
  return normalizeTarget(raw) ?? raw;
}

// The terminal line of a run this call attached to, in the shapes a fresh run returns.
function attachedResult(terminal: TerminalEvent) {
  if (terminal.type === 'complete') {
    const { type: _tag, ...envelope } = terminal;
    return textContent({ audited: true, source: 'fresh-audit', attached: true, ...envelope });
  }
  const failure =
    terminal.type === 'incomplete'
      ? { error: 'incomplete', details: terminal.reason ?? null }
      : { error: terminal.error.code, details: terminal.error.details ?? null };
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ ...failure, stage: 'attached' }, null, 2) }],
    isError: true,
  };
}

export function registerScorecardAuditTool(server: McpServer, _catalog: Catalog, env: ScorecardAuditEnv): void {
  server.registerTool(
    'score_cli',
    {
      title: 'Run a live CLI audit',
      description:
        'Run a fresh container audit for a CLI when no cached scorecard exists. Provide ONE of: slug, binary, install, ' +
        'github_url (same validator as get_scorecard). On registry or R2-cache hit, returns isError: false with ' +
        'next_tool: get_scorecard — cache state is data, not failure. On cache miss, runs a metered container audit ' +
        'gated by MCP_AUDIT_LIMITER (5 per 60-second burst) AND a KV-backed per-hour window (5 audits per 60 minutes ' +
        'per IP — the plan ceiling that the CF binding alone cannot express). No anon fallback at the audit tier: a ' +
        'request without cf-connecting-ip returns -32099 immediately. Disabled when MCP_LIVE_SCORING_ENABLED is not ' +
        '"true" or the operator sets scoring_disabled: the answer is then isError: false with audited: false and ' +
        'next_tool: get_scorecard, and the read tier on get_scorecard stays alive serving cached scorecards. A fresh ' +
        'audit whose ' +
        'scorecard reports summary.error above 0 is returned but not saved: its URLs and freshness.refresh_after ' +
        'are null, and the next call runs a fresh audit.',
      inputSchema: z.strictObject({
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
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args, extra) => {
      const siteUrl = siteOrigin();
      // Step 1: kill switches.
      if (
        env.MCP_LIVE_SCORING_ENABLED !== 'true' ||
        (env.SCORE_KV !== undefined && (await isScoringDisabled({ SCORE_KV: env.SCORE_KV })))
      ) {
        return textContent({
          audited: false,
          message:
            'live scoring is currently disabled by the operator; cached scorecards remain available via ' +
            'get_scorecard.',
          next_tool: 'get_scorecard',
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
      const indexes = { registryIndex, hintsIndex };
      const tier = await readCliTier(env, validated, indexes, { origin: siteUrl, skipCache: bypassCache });

      if (tier.kind === 'registry') {
        return textContent({
          audited: false,
          source: 'registry',
          next_tool: 'get_scorecard',
          ...tier.envelope,
          message: `a curated scorecard for "${tier.entry.name}" already exists; call get_scorecard for the inline record.`,
        });
      }

      if (tier.kind === 'cache') {
        return textContent({
          audited: false,
          source: 'live-cache',
          next_tool: 'get_scorecard',
          ...tier.envelope,
          message: 'a cached live-score result already exists; call get_scorecard for the inline record.',
        });
      }

      // Step 4: cf-connecting-ip presence check (no anon fallback).
      const ipString = requestHeader(extra, 'cf-connecting-ip');
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

      // Step 5.5: a run already in flight for this input is attached to
      // rather than run twice. Attaching spends no audit budget, but it holds
      // a request open for the rest of that run, so it passes the source
      // gates above first. A cache bypass forces its own run, which is the
      // whole purpose of the flag.
      if (!bypassCache) {
        const signal = getMcpRequest()?.signal;
        const attached = await awaitInFlightTerminal(env, 'cli', inFlightKey(choice.raw), signal);
        if (attached) return attachedResult(attached);
        // A null answer after the caller aborted means the wait ended, not
        // that nothing is running; dispatching now would audit for nobody.
        if (signal?.aborted) {
          return jsonRpcError32099('the caller went away while attaching to the audit already in flight.');
        }
      }

      // Step 6: KV-backed per-hour window. The CF binding's max period
      // is 60 seconds; this layer enforces the plan's "5 per 60 minutes"
      // ceiling.
      if (env.SCORE_KV) {
        const hourly = await consumeHourlyBucketBudget(env.SCORE_KV, 'mcp_audit', ipString, HOURLY_AUDIT_CEILING);
        if (hourly === 'full') {
          return jsonRpcError32099('audit rate limit exceeded — fresh audits limited to 5 per hour per source.');
        }
        if (hourly === 'contended') return jsonRpcError32099(HOURLY_CONTENTION_MESSAGE);
      }

      // Step 6.5: the job's claim is the single-flight gate. Two calls can
      // both pass the attach above before either one marks a flag. A cache
      // bypass runs beside a held job and owns none of its keys.
      const runKey = inFlightKey(choice.raw);
      const startedAt = new Date().toISOString();
      const job = await claimJob(env, 'cli', runKey, startedAt);
      if (job.kind === 'running' && !bypassCache) {
        const signal = getMcpRequest()?.signal;
        const attached = await awaitJobTerminal(env, job.name, signal);
        if (attached) return attachedResult(attached);
        if (signal?.aborted) {
          return jsonRpcError32099('the caller went away while attaching to the audit already in flight.');
        }
        return attachedResult({
          type: 'error',
          ...auditErrorFor('timeout', {
            cta: CTA_RETRY,
            details: 'The audit already in flight for this input did not finish in time.',
          }),
        });
      }
      const writer = job.kind === 'claimed' ? job.writer : null;
      const flags = new InFlightFlags(env, 'cli', startedAt, writer?.name ?? null, job.kind !== 'running');
      writer?.append({ type: 'accepted', lane: 'cli', target: runKey, started_at: startedAt });
      const branchTarget = branchResultTarget(validated);
      await flags.mark(runKey, ...(branchTarget ? [branchTarget] : []));

      // Step 7: orchestrate.runFreshOnly — resolveSpec + DO dispatch.
      // The DO calls writeCacheBestEffort itself; MCP never writes R2.
      //
      // Cache bypass also covers the post-discovery cache tier (orchestrate.ts
      // tier 3); otherwise a github-url input whose discovered binary IS in cache
      // would short-circuit at step 6.5 and produce kind=cache_post_hit, which
      // again does not exercise the DO. Same gating: caller arg + staging-only
      // env binding.
      const inputHash = await sha256Hex(choice.raw);
      // A run that throws still ends its job, so no attached caller waits out the deadline.
      let terminal: TerminalEvent = {
        type: 'error',
        ...auditErrorFor('incomplete_response_contract', { cta: CTA_RETRY }),
      };
      let result: RunFreshResult;
      // The job's claim lapses at the relay deadline. A read that outlived it
      // would end a run the job no longer holds and clear a newer run's flags.
      const deadline = AbortSignal.timeout(RELAY_DEADLINE_SECONDS * 1000);
      try {
        result = await runFreshOnly(validated, env, hintsIndex, {
          specVersion: SPEC_VERSION,
          inputHash,
          skipCachePost: bypassCache,
          onResolved: async (spec) => {
            if (spec.pm !== 'git-clone') await flags.mark(targetOfSpec(spec));
          },
          onPhase: (line) => writer?.append({ type: 'phase', phase: line.phase, at: line.at }),
          signal: deadline,
        });
        terminal = terminalEventOf(outcomeOf(result, { indexes, origin: siteUrl }));
      } catch (err) {
        if (deadline.aborted) {
          terminal = {
            type: 'error',
            ...auditErrorFor('timeout', {
              cta: CTA_RETRY,
              details: 'The relay deadline passed before the run answered.',
            }),
          };
        }
        throw err;
      } finally {
        writer?.append(terminal);
        await writer?.settled();
        await flags.clear();
      }

      // Step 8: map kind to typed-state response.
      switch (result.kind) {
        case 'cache_post_hit': {
          const envelope = cliRunEnvelope({
            tier: 'cache',
            spec: result.spec,
            scorecard: result.scorecard,
            ancVersion: result.anc_version,
            toolVersion: result.tool_version,
            registry: registryIndex,
            origin: siteUrl,
          });
          return textContent({
            audited: false,
            source: 'live-cache',
            next_tool: 'get_scorecard',
            ...envelope,
            message: 'post-discovery cache hit; the next get_scorecard call will return this inline.',
          });
        }
        case 'fresh': {
          const envelope = cliRunEnvelope({
            tier: 'live',
            spec: result.spec,
            scorecard: result.scorecard,
            ancVersion: result.anc_version,
            registry: registryIndex,
            origin: siteUrl,
            sourceSha: result.source_sha,
          });
          return textContent({ audited: true, source: 'fresh-audit', ...envelope });
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
