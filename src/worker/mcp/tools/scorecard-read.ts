// get_scorecard MCP tool — cheap read-only lookup over the registry and the
// R2 live-score cache.
//
// Composes the CLI lane's shared read tier, so this tool and the result
// route's JSON representation build the same envelope from the same record:
// an agent that calls get_scorecard and an agent that fetches the result's
// `json_url` see byte-equal `scorecard` and `freshness`. The composition is
// upstream of the cache; this tool ONLY reads. The matching write path is
// score_cli (sibling file).
//
// Cache state is data, not failure — every outcome returns isError: false:
//
//   curated  -> { found: true, ...envelope }  tier registry, scorecard attached
//   cached   -> { found: true, ...envelope }  tier cache
//   running  -> { found: false, in_progress: true, started_at }
//   miss     -> { found: false, next_tool: "score_cli", message }
//
// The in-flight answer precedes the miss for the same reason the result
// route answers 202 before its R2 read: a run that has not written yet is
// not an absence, and telling an agent to start a second one would double
// the work the job already has in hand.
//
// isError: true is reserved for genuine tool-execution failures: validator
// rejection (security gate) or an infrastructure error loading the indexes.

import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { normalizeTarget } from '../../../shared/audit-routes';
import { readInFlight } from '../../audit/inflight';
import { type CliCoreEnv, loadCliIndexes, readCliTier, readCuratedEnvelope, validateCliInput } from '../../score/core';
import { SPEC_VERSION } from '../../spec-version.gen';
import type { Catalog } from '../catalog';
import { siteOrigin } from '../site-origin';

export interface ScorecardReadEnv extends CliCoreEnv {
  SCORE_KV?: KVNamespace;
}

function textContent(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
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

export function registerScorecardReadTool(server: McpServer, _catalog: Catalog, env: ScorecardReadEnv): void {
  server.registerTool(
    'get_scorecard',
    {
      title: 'Get a cached CLI scorecard',
      description:
        'Cheap read-only lookup over the agent-native CLI scorecard surface. Composes the shared CLI read tier, so a ' +
        'hit returns the same result envelope the scorecard page serves at its json_url. Provide ONE of: slug ' +
        '(registry slug), binary (CLI binary name), install (full install command, e.g. "brew install ripgrep"), or ' +
        'github_url (https://github.com/owner/repo, branch URLs accepted). Returns isError: false for all cache-state ' +
        'outcomes: a hit returns { found: true, kind, tier, target, scorecard_url, markdown_url, json_url, freshness, ' +
        'spec_version, scorecard }; a target already being audited returns { found: false, in_progress: true, ' +
        'started_at }; a miss returns { found: false, next_tool: "score_cli" }. isError: true is reserved for ' +
        'validator rejection or an infrastructure error. The companion tool score_cli runs a fresh container audit on ' +
        'a miss.',
      inputSchema: {
        slug: z.string().optional().describe('Registry slug, e.g. "ripgrep".'),
        binary: z.string().optional().describe('CLI binary name. Treated as a slug for the registry lookup.'),
        install: z.string().optional().describe('Full install command, e.g. "brew install ripgrep".'),
        github_url: z.string().optional().describe('GitHub URL (https://github.com/owner/repo, branch URLs accepted).'),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const origin = siteOrigin();
      const choice = rawFromInput(args);
      if ('error' in choice) {
        return { content: [{ type: 'text' as const, text: choice.error }], isError: true };
      }

      let indexes: Awaited<ReturnType<typeof loadCliIndexes>>;
      try {
        indexes = await loadCliIndexes(env);
      } catch (err) {
        return {
          content: [
            { type: 'text' as const, text: `infrastructure error loading registry indexes: ${(err as Error).message}` },
          ],
          isError: true,
        };
      }

      const validated = validateCliInput(choice.raw, indexes);
      if (validated.kind === 'unknown') {
        return {
          content: [
            { type: 'text' as const, text: JSON.stringify({ error: 'invalid_input', code: validated.error }, null, 2) },
          ],
          isError: true,
        };
      }

      const tier = await readCliTier(env, validated, indexes, { origin, skipCache: false });

      if (tier.kind === 'registry') {
        // The committed scorecard rides along when the build emitted it; a
        // metadata-only entry still answers with its registry projection.
        const withScorecard = await readCuratedEnvelope(env, tier.entry, origin);
        return textContent({ found: true, ...(withScorecard ?? tier.envelope) });
      }

      if (tier.kind === 'cache') {
        return textContent({ found: true, ...tier.envelope });
      }

      const running = await readInFlight(env, 'cli', normalizeTarget(choice.raw) ?? choice.raw);
      if (running) {
        return textContent({
          found: false,
          in_progress: true,
          started_at: running.started_at,
          message: 'an audit for this target is already running; poll this tool or read the result page shortly.',
        });
      }

      return textContent({
        found: false,
        next_tool: 'score_cli',
        spec_version: SPEC_VERSION,
        message:
          'no cached scorecard for this input. Call score_cli with the same arguments to run a fresh audit (subject ' +
          'to the audit rate limit and the operator-controlled live-scoring kill switch).',
      });
    },
  );
}
