// The CLI lane core: everything a CLI audit does that is not a gate.
// Both inbound transact surfaces compose it: the legacy `POST /api/score`
// handler and the unified endpoint.
//
//   validateCliInput ....... the worker validator over the raw input
//   readCliTier ............ the unmetered registry and cache tiers
//   runCliAudit ............ resolve the spec, the post-discovery cache
//                            tier, the Durable Object run, one result
//
// The core never reads a token, a session, or a limiter; admission is the
// caller's. It keeps the GitHub accessibility probe ahead of resolution.

import { type AuditEnvelope, buildCliEnvelope, buildRegistryEnvelope } from '../../shared/audit-envelope';
import { targetOfSpec } from '../../shared/audit-routes';
import { SPEC_VERSION } from '../spec-version.gen';
import type { CacheEnv } from './cache';
import type { InstallSpec, ResolvedStep } from './discover-binary';
import { checkGithubAccessibility } from './github-accessibility';
import { loadHintsIndex, lookupOnly, type OrchestrateEnv, type RunFreshResult, runFreshOnly } from './orchestrate';
import {
  type DiscoveryHintsIndex,
  deriveShareBinary,
  deriveShareBinaryFromSpec,
  loadRegistryIndex,
  lookupRegistry,
  type RegistryIndex,
} from './registry-lookup';
import { CTA, type ScoreError } from './response-shape';
import { type ValidatedInput, validateInput } from './validate';

export type CliCoreEnv = OrchestrateEnv & CacheEnv;

export type CliIndexes = { registryIndex: RegistryIndex; hintsIndex: DiscoveryHintsIndex };

export async function loadCliIndexes(env: CliCoreEnv): Promise<CliIndexes> {
  const [registryIndex, hintsIndex] = await Promise.all([loadRegistryIndex(env), loadHintsIndex(env)]);
  return { registryIndex, hintsIndex };
}

export type CliValidated = Exclude<ValidatedInput, { kind: 'unknown' }>;

export function validateCliInput(raw: string, indexes: CliIndexes): ValidatedInput {
  return validateInput(raw, indexes.registryIndex);
}

/** True for a `/tree/<branch>` URL or an `owner/repo@branch`; such a target is a snapshot and never serves from cache. */
export function isBranchScoped(validated: CliValidated): boolean {
  return validated.kind === 'github-url' && typeof validated.branch === 'string';
}

export type CliTier =
  | {
      kind: 'registry';
      envelope: AuditEnvelope;
      entry: RegistryIndex['by_slug'][string];
      scorecardUrl: string;
      ancVersion: string;
    }
  | {
      kind: 'cache';
      envelope: AuditEnvelope;
      binary: string;
      shareUrl: string | null;
      ancVersion: string;
      toolVersion: string;
      scorecard: unknown;
    }
  | { kind: 'miss' };

/**
 * The unmetered read tier: the curated registry first, then the R2 cache
 * when the binary is cheaply derivable. A branch-scoped target and a
 * `skipCache` request skip the cache tier; the registry is always
 * consulted.
 */
export async function readCliTier(
  env: CliCoreEnv,
  validated: CliValidated,
  indexes: CliIndexes,
  opts: { origin: string; skipCache: boolean },
): Promise<CliTier> {
  const lookup = isBranchScoped(validated)
    ? ({ kind: 'miss' } as const)
    : await lookupOnly(validated, env, indexes.registryIndex, indexes.hintsIndex, {
        specVersion: SPEC_VERSION,
        skipCache: opts.skipCache,
      });
  if (lookup.kind === 'curated') {
    const envelope = buildRegistryEnvelope({ entry: lookup.entry, origin: opts.origin, specVersion: SPEC_VERSION });
    return {
      kind: 'registry',
      envelope,
      entry: lookup.entry,
      scorecardUrl: lookup.scorecard_url,
      ancVersion: lookup.anc_version,
    };
  }
  if (lookup.kind === 'cached') {
    const binary = deriveShareBinary(validated, indexes.hintsIndex);
    const target = binary ?? cachedBinaryOf(lookup.scorecard) ?? 'unknown';
    const record = {
      spec_version: SPEC_VERSION,
      anc_version: lookup.anc_version,
      tool_version: lookup.tool_version,
      scorecard: lookup.scorecard,
    };
    const envelope = buildCliEnvelope({
      tier: 'cache',
      target,
      record,
      registry: indexes.registryIndex,
      origin: opts.origin,
    });
    return {
      kind: 'cache',
      envelope,
      binary: target,
      shareUrl: binary ? `/score/live/${binary}` : null,
      ancVersion: lookup.anc_version,
      toolVersion: lookup.tool_version,
      scorecard: lookup.scorecard,
    };
  }
  return { kind: 'miss' };
}

function cachedBinaryOf(scorecard: unknown): string | null {
  const binary = (scorecard as { tool?: { binary?: unknown } } | null)?.tool?.binary;
  return typeof binary === 'string' && binary ? binary : null;
}

export type CliRunOutcome =
  | {
      kind: 'cache';
      envelope: AuditEnvelope;
      spec: InstallSpec;
      resolvedStep: ResolvedStep | null;
      shareUrl: string | null;
      ancVersion: string;
      scorecard: unknown;
    }
  | {
      kind: 'live';
      envelope: AuditEnvelope;
      spec: InstallSpec;
      resolvedStep: ResolvedStep | null;
      shareUrl: string | null;
      ancVersion: string;
      scorecard: unknown;
      installMs: number | null;
      ancAuditMs: number | null;
    }
  | { kind: 'bounce'; error: ScoreError; spec?: InstallSpec; resolvedStep?: ResolvedStep | null; tier: string };

export type RunCliAuditInput = {
  env: CliCoreEnv;
  validated: CliValidated;
  indexes: CliIndexes;
  inputHash: string;
  origin: string;
  skipCachePost: boolean;
  sourceSha?: string;
};

const CTA_INSTALL_ANC = CTA.installAnc;

// The package managers the user-facing `install_unsupported` variant names;
// any other pm in a bounce's details collapses to a generic install failure.
type UnsupportedPm = Extract<ScoreError, { code: 'install_unsupported' }>['pm'];

function unsupportedPmOf(details: string | undefined): UnsupportedPm | null {
  const pm = details?.match(/^pm=(\w+)/)?.[1];
  return pm === 'brew_only' || pm === 'brew' || pm === 'bun' || pm === 'go_no_binary' ? pm : null;
}

/**
 * Resolve the spec and run the audit. A non-hint, non-branch GitHub
 * repository is probed for accessibility first so a private or missing
 * repository bounces before the discovery fan-out; anything but a clean
 * 404 fails open.
 */
export async function runCliAudit(input: RunCliAuditInput): Promise<CliRunOutcome> {
  const { env, validated, indexes } = input;
  if (validated.kind === 'github-url' && !validated.branch) {
    const registryHit = lookupRegistry(validated, indexes.registryIndex, indexes.hintsIndex);
    if (registryHit.kind !== 'hint') {
      const accessibility = await checkGithubAccessibility(validated.owner, validated.repo);
      if (accessibility.state === 'not_accessible') {
        return {
          kind: 'bounce',
          tier: 'error_github_repo_not_accessible',
          error: { code: 'github_repo_not_accessible', cta_text: CTA_INSTALL_ANC },
        };
      }
    }
  }
  const result = await runFreshOnly(validated, env, indexes.hintsIndex, {
    specVersion: SPEC_VERSION,
    inputHash: input.inputHash,
    skipCachePost: input.skipCachePost,
  });
  return outcomeOf(result, input);
}

function envelopeFor(
  tier: 'cache' | 'live',
  spec: InstallSpec,
  scorecard: unknown,
  ancVersion: string,
  toolVersion: string,
  input: RunCliAuditInput,
): AuditEnvelope {
  const record = { spec_version: SPEC_VERSION, anc_version: ancVersion, tool_version: toolVersion, scorecard };
  return buildCliEnvelope({
    tier,
    target: targetOfSpec(spec),
    record,
    registry: input.indexes.registryIndex,
    origin: input.origin,
    sourceSha: spec.pm === 'git-clone' ? input.sourceSha : undefined,
  });
}

function toolVersionOf(scorecard: unknown): string {
  const version = (scorecard as { tool?: { version?: unknown } } | null)?.tool?.version;
  return typeof version === 'string' ? version : '';
}

function shareUrlFor(spec: InstallSpec): string | null {
  const binary = deriveShareBinaryFromSpec(spec);
  return binary ? `/score/live/${binary}` : null;
}

function outcomeOf(result: RunFreshResult, input: RunCliAuditInput): CliRunOutcome {
  switch (result.kind) {
    case 'cache_post_hit':
      return {
        kind: 'cache',
        envelope: envelopeFor('cache', result.spec, result.scorecard, result.anc_version, result.tool_version, input),
        spec: result.spec,
        resolvedStep: result.resolved_step,
        shareUrl: shareUrlFor(result.spec),
        ancVersion: result.anc_version,
        scorecard: result.scorecard,
      };
    case 'fresh':
      return {
        kind: 'live',
        envelope: envelopeFor(
          'live',
          result.spec,
          result.scorecard,
          result.anc_version,
          toolVersionOf(result.scorecard),
          input,
        ),
        spec: result.spec,
        resolvedStep: result.resolved_step,
        shareUrl: shareUrlFor(result.spec),
        ancVersion: result.anc_version,
        scorecard: result.scorecard,
        installMs: result.install_ms,
        ancAuditMs: result.anc_audit_ms,
      };
    case 'resolution_error':
      return { kind: 'bounce', tier: `error_${result.error}`, error: resolutionError(result.error, result.details) };
    case 'sandbox_unavailable':
      return {
        kind: 'bounce',
        tier: 'error_sandbox_unavailable',
        spec: result.spec,
        resolvedStep: result.resolved_step,
        error: { code: 'sandbox_unavailable', cta_text: CTA_INSTALL_ANC },
      };
    case 'sandbox_stub_until_u6':
      return {
        kind: 'bounce',
        tier: 'error_sandbox_stub_until_u6',
        spec: result.spec,
        resolvedStep: result.resolved_step,
        error: { code: 'sandbox_stub_until_u6', cta_text: CTA_INSTALL_ANC },
      };
    case 'do_error':
      return {
        kind: 'bounce',
        tier: `error_${result.error}`,
        spec: result.spec,
        resolvedStep: result.resolved_step,
        error: doError(result.error, result.details),
      };
    case 'incomplete_response_contract':
      return {
        kind: 'bounce',
        tier: 'error_incomplete_response_contract',
        spec: result.spec,
        resolvedStep: result.resolved_step,
        error: {
          code: 'incomplete_response_contract',
          details:
            result.reason === 'non_json_body' ? 'DO returned non-JSON' : 'DO returned unrecognized envelope shape',
          cta_text: CTA_INSTALL_ANC,
        },
      };
  }
}

// A resolution failure is one of three: no spec discoverable, an
// unsupported package manager after the fallbacks, or a branch shape that
// slipped past validation. The pm extraction mirrors doError so the error
// object is identical whichever tier bounced.
export function resolutionError(
  error: 'chain_no_resolve' | 'install_unsupported' | 'invalid_url_path',
  details?: string,
): ScoreError {
  if (error === 'chain_no_resolve') return { code: 'chain_no_resolve', cta_text: CTA_INSTALL_ANC };
  if (error === 'invalid_url_path') {
    return {
      code: 'invalid_url_path',
      cta_text: 'Paste the repo root URL (e.g. https://github.com/owner/repo), not a branch or release link.',
    };
  }
  const pm = unsupportedPmOf(details);
  if (pm) return { code: 'install_unsupported', pm, cta_text: CTA_INSTALL_ANC };
  return { code: 'chain_resolved_install_failed', details: details ?? '', cta_text: CTA_INSTALL_ANC };
}

// The Durable Object's error codes onto the user-facing union; a code the
// union does not know collapses to incomplete_response_contract so the
// triad rule holds.
export function doError(error: string, rawDetails?: string): ScoreError {
  const details = rawDetails ?? '';
  switch (error) {
    case 'chain_no_resolve':
      return { code: 'chain_no_resolve', cta_text: CTA_INSTALL_ANC };
    case 'chain_resolved_install_failed':
      return { code: 'chain_resolved_install_failed', details, cta_text: CTA_INSTALL_ANC };
    case 'chain_resolved_no_binary_produced':
      return { code: 'chain_resolved_no_binary_produced', details, cta_text: CTA_INSTALL_ANC };
    case 'install_unsupported': {
      const pm = unsupportedPmOf(details);
      if (pm) return { code: 'install_unsupported', pm, cta_text: CTA_INSTALL_ANC };
      return { code: 'chain_resolved_install_failed', details, cta_text: CTA_INSTALL_ANC };
    }
    case 'timeout':
      // The sandbox budget covers install and audit together; the audit is
      // the long pole, so a timeout is reported as the score phase.
      return { code: 'timeout', phase: 'score', cta_text: CTA_INSTALL_ANC };
    default:
      return {
        code: 'incomplete_response_contract',
        details: `${error}${details ? `: ${details.slice(0, 160)}` : ''}`,
        cta_text: CTA_INSTALL_ANC,
      };
  }
}
