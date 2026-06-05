// get_scorecard MCP tool — cheap read-only lookup over the registry
// (via the in-isolate catalog projection) and the R2 live-score cache.
//
// Composes the shared /api/score orchestrator's lookup_only intent so
// MCP and /api/score can never drift on registry-fast-path semantics
// or cache key shapes. The composition is upstream of the cache: this
// tool ONLY reads. The matching write path (a fresh container audit) is
// score_cli (sibling file). Cache state is data, not failure — every
// outcome here returns isError: false with a typed-state body per
// KTD-3 of the plan:
//
//   curated  -> { found: true, scorecard, scorecard_url, source: "registry",   spec_version }
//   cached   -> { found: true, scorecard, scorecard_url, source: "live-cache", spec_version }
//   miss     -> { found: false, next_tool: "score_cli", message }
//
// isError: true is reserved for genuine tool-execution failures:
// validator rejection (security gate), infrastructure error fetching
// the registry/hints indexes, or an asset-fetch failure on the curated
// JSON path.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { loadHintsIndex, lookupOnly, type OrchestrateEnv } from '../../score/orchestrate';
import { type DiscoveryHintsIndex, loadRegistryIndex, type RegistryIndex } from '../../score/registry-lookup';
import { validateInput } from '../../score/validate';
import { SPEC_VERSION } from '../../spec-version.gen';
import type { Catalog } from '../catalog';

export interface ScorecardReadEnv extends OrchestrateEnv {}

const SITE_URL = 'https://anc.dev';

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
}): { raw: string; provided: 'binary' | 'slug' | 'install' | 'github_url' } | { error: string } {
  if (args.slug !== undefined && args.slug !== '') return { raw: args.slug, provided: 'slug' };
  if (args.binary !== undefined && args.binary !== '') return { raw: args.binary, provided: 'binary' };
  if (args.install !== undefined && args.install !== '') return { raw: args.install, provided: 'install' };
  if (args.github_url !== undefined && args.github_url !== '') return { raw: args.github_url, provided: 'github_url' };
  return { error: 'one of {slug, binary, install, github_url} must be provided' };
}

export function registerScorecardReadTool(server: McpServer, _catalog: Catalog, env: ScorecardReadEnv): void {
  server.tool(
    'get_scorecard',
    'Cheap read-only lookup over the agent-native CLI scorecard surface. Composes the shared /api/score orchestrator ' +
      'so the cache semantics match the human form on anc.dev/. Provide ONE of: slug (registry slug), binary (CLI ' +
      'binary name), install (full install command, e.g. "brew install ripgrep"), or github_url ' +
      '(https://github.com/owner/repo, branch URLs accepted). Returns isError: false for all cache-state outcomes ' +
      '(hit returns the inline scorecard plus source; miss returns next_tool: score_cli). isError: true is reserved ' +
      'for validator rejection, infrastructure errors, or asset-fetch failure. The companion tool score_cli runs a ' +
      'fresh container audit on cache miss.',
    {
      slug: z.string().optional().describe('Registry slug, e.g. "ripgrep".'),
      binary: z.string().optional().describe('CLI binary name. Treated as a slug for the registry lookup.'),
      install: z.string().optional().describe('Full install command, e.g. "brew install ripgrep".'),
      github_url: z.string().optional().describe('GitHub URL (https://github.com/owner/repo, branch URLs accepted).'),
    },
    async (args) => {
      const choice = rawFromInput(args);
      if ('error' in choice) {
        return {
          content: [{ type: 'text' as const, text: choice.error }],
          isError: true,
        };
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
            {
              type: 'text' as const,
              text: JSON.stringify({ error: 'invalid_input', code: validated.error }, null, 2),
            },
          ],
          isError: true,
        };
      }

      const result = await lookupOnly(validated, env, registryIndex, hintsIndex, {
        specVersion: SPEC_VERSION,
      });

      if (result.kind === 'curated') {
        const scorecardUrlPath = result.scorecard_url ?? `/score/${result.entry.name}`;
        const scorecard_url = scorecardUrlPath.startsWith('http') ? scorecardUrlPath : `${SITE_URL}${scorecardUrlPath}`;
        return textContent({
          found: true,
          source: 'registry',
          scorecard_url,
          entry: result.entry,
          spec_version: SPEC_VERSION,
        });
      }

      if (result.kind === 'cached') {
        const scorecard = result.scorecard as { tool?: { binary?: string | null } } | null;
        const binary = scorecard?.tool?.binary ?? null;
        const scorecard_url = binary ? `${SITE_URL}/score/live/${binary}` : null;
        return textContent({
          found: true,
          source: 'live-cache',
          scorecard_url,
          scorecard: result.scorecard,
          anc_version: result.anc_version,
          spec_version: SPEC_VERSION,
        });
      }

      return textContent({
        found: false,
        next_tool: 'score_cli',
        message:
          'no cached scorecard for this input. Call score_cli with the same arguments to run a fresh audit (subject ' +
          'to the audit rate limit and the operator-controlled live-scoring kill switch).',
      });
    },
  );
}
