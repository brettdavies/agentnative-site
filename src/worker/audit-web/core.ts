// The website lane core: everything a website audit does that is not a
// gate. Both inbound transact surfaces compose it: the legacy
// `POST /api/audit-web` route and the unified `POST /api/score` endpoint.
//
//   prepareWebTarget ....... server-normalized https origin + the SSRF gate
//   readWebTier ............ the unmetered cache decision (serve, patch, audit)
//   patchWebListing ........ the listing-only write, scored_at preserved
//   runWebAuditStream ...... the engine as shared events, R2 write, purge,
//                            aggregate rebuild, one terminal event; a run
//                            that does not follow declared hosts, or one a
//                            declared domain's spent budget held back,
//                            writes nothing and ends on a transient envelope
//
// The core never reads a token, a session, or a limiter; admission is the
// caller's. It keeps stale-serve-when-disabled (a caller decides to serve
// a stale hit as data when the kill switch is off), the listing patch, and
// the per-domain flip budget.

import { type AuditEnvelope, buildWebEnvelope, transientWebEnvelope } from '../../shared/audit-envelope';
import { type AuditEvent, CTA_RETRY } from '../../shared/audit-events';
import { type NotifyEnv, notifyFailure } from '../notify';
import { SPEC_VERSION } from '../spec-version.gen';
import { rebuildAggregatesIfSeeded } from './aggregate';
import { type AuditLogEnv, instrumentAuditEvents, logAuditError } from './audit-log';
import {
  type CachedWebAudit,
  get as cacheGet,
  put as cachePut,
  canonicalTargetOf,
  isStale,
  keyFor,
  patchStoredPublicListing,
  scorecardWithPublicListing,
  WEB_AUDIT_STALE_AFTER_MS,
} from './cache';
import { enrichWebScorecardForDisplay } from './display';
import { type DomainBudgetEnv, declaredDomainBudget, domainBudgetRefusal } from './domain-budget';
import { runWebAudit } from './engine';
import { effectiveFollow, type FollowSwitchEnv } from './follow-switch';
import { queueHitMinPurge, webDomainTag, webTag } from './hit-min-purge';
import { hourWindowEndsAt } from './limiter';
import { rowHostFields } from './provenance';
import {
  decidePublicListingWrite,
  enforcePublicListingFlipLimit,
  type PublicListingWrite,
  resolveAuditListing,
  standingPublicListing,
} from './public-listing';
import { loadWebAuditRegistry, type WebAuditRegistry, type WebSiteType, withRegistryFingerprint } from './registry';
import { loadWebRemediationCatalog, type WebRemediationCatalog } from './remediation';
import type { EngineResult, WebScorecard } from './scorecard';
import { validatePublicUrl } from './ssrf';
import type { WebScorecardShape } from './summary-model';
import { buildWebSummaryBody } from './summary-render';
import type { TransientReason } from './summary-transient';

export interface WebCoreEnv extends AuditLogEnv, NotifyEnv, FollowSwitchEnv, DomainBudgetEnv {
  ASSETS: Fetcher;
  SCORE_CACHE: R2Bucket;
  SCORE_KV?: KVNamespace;
}

export type WebTarget = {
  /** The host the result route serves, with a non-default port. */
  host: string;
  /** The canonical `https://<host>/` origin the cache is keyed by. */
  canonical: string;
};

/**
 * The website lane's server-side target: the shared classifier's host,
 * fixed to the https scheme, then the SSRF gate on that origin before any
 * cache read. A refused origin returns the gate's reason.
 */
export function prepareWebTarget(host: string): { ok: true; target: WebTarget } | { ok: false; reason: string } {
  let url: URL;
  try {
    url = new URL(`https://${host}/`);
  } catch {
    return { ok: false, reason: 'invalid host' };
  }
  const canonical = canonicalTargetOf(url);
  const validation = validatePublicUrl(canonical);
  if (!validation.ok) return { ok: false, reason: validation.reason };
  return { ok: true, target: { host: url.host, canonical } };
}

export type WebTier =
  | { kind: 'serve'; cached: CachedWebAudit; fresh: boolean }
  | { kind: 'patch'; write: Extract<PublicListingWrite, { path: 'patch' }>; cached: CachedWebAudit }
  | { kind: 'audit'; cached: CachedWebAudit | null; listing: boolean; write: PublicListingWrite };

/** The target's stored audit, or null when none was ever saved. */
async function readStoredWebAudit(env: WebCoreEnv, target: WebTarget): Promise<CachedWebAudit | null> {
  return cacheGet(env, await keyFor(target.canonical, SPEC_VERSION));
}

/** The listing a run that saves nothing carries: the target's stored choice, unlisted when it has none. */
export async function readStandingListing(env: WebCoreEnv, target: WebTarget): Promise<boolean> {
  return standingPublicListing(await readStoredWebAudit(env, target));
}

/**
 * The unmetered read tier. A fresh hit with no differing listing choice
 * serves; a fresh hit with a differing explicit choice patches; a stale
 * hit or a miss audits. `cached` rides on the audit decision so a caller
 * with the kill switch off can still serve the stale record as data.
 */
export async function readWebTier(
  env: WebCoreEnv,
  target: WebTarget,
  publicListing: boolean | undefined,
): Promise<WebTier> {
  const cached = await readStoredWebAudit(env, target);
  const write = decidePublicListingWrite({ explicit: publicListing, cached });
  const fresh = cached !== null && !isStale(cached.scored_at, WEB_AUDIT_STALE_AFTER_MS);
  if (cached && fresh && write.path === 'serve-cached') return { kind: 'serve', cached, fresh: true };
  if (write.path === 'patch') return { kind: 'patch', write, cached: write.cached };
  return { kind: 'audit', cached, listing: resolveAuditListing(write, publicListing, cached), write };
}

/**
 * The registry and remediation catalog the read-time enrichment needs.
 * Either load failing degrades that half of the enrichment rather than the
 * result: a stored scorecard is still a scorecard without its current
 * category split or its fix prompts.
 */
async function displayInputs(
  env: WebCoreEnv,
): Promise<{ registry: WebAuditRegistry | null; catalog: WebRemediationCatalog }> {
  const [registry, catalog] = await Promise.allSettled([loadWebAuditRegistry(env), loadWebRemediationCatalog(env)]);
  return {
    registry: registry.status === 'fulfilled' ? registry.value : null,
    catalog: catalog.status === 'fulfilled' ? catalog.value : {},
  };
}

/**
 * The one website result envelope. Every surface that hands back a website
 * result composes it: the endpoint's terminal event and its cache reads,
 * the result route's three representations, and both MCP web tools.
 *
 * The scorecard inside it is the stored run put through the read-time
 * display enrichment, so the current category split and each row's result
 * line and remediation reach every surface from one place. Storage stays
 * raw; deriving on read is what lets a registry or catalog change reach
 * records that were cached before it.
 */
export async function webEnvelope(
  env: WebCoreEnv,
  input: {
    tier: 'cache' | 'live';
    host: string;
    record: CachedWebAudit;
    origin: string;
    /** Why the result was not saved; set, the envelope carries no URLs and its body in their place. */
    transient?: TransientReason;
  },
): Promise<AuditEnvelope> {
  const { registry, catalog } = await displayInputs(env);
  const scorecard = enrichWebScorecardForDisplay(input.record.scorecard, {
    registry,
    catalog,
    origin: input.origin,
  });
  const envelope = buildWebEnvelope({
    tier: input.tier,
    target: input.host,
    record: { ...input.record, scorecard },
    origin: input.origin,
  });
  if (!input.transient) return envelope;
  const summaryHtml = buildWebSummaryBody({
    scorecard: scorecard as WebScorecardShape,
    domain: input.host,
    targetUrl: input.record.target_url,
    remediation: catalog,
    registry: registry ?? undefined,
    origin: input.origin,
    freshness: envelope.freshness,
    transient: input.transient,
  });
  return transientWebEnvelope(envelope, summaryHtml);
}

export type PatchOutcome =
  | { ok: true; cached: CachedWebAudit }
  | { ok: false; reason: 'flip_rate_limited' | 'patch_failed' };

/**
 * The listing-only write: meter the per-domain flip budget, rewrite the
 * stored record with the new flag and its scored_at preserved, and queue
 * the board purge. The returned record is what the caller wraps.
 */
export async function patchWebListing(
  env: WebCoreEnv,
  target: WebTarget,
  tier: Extract<WebTier, { kind: 'patch' }>,
): Promise<PatchOutcome> {
  const budget = await enforcePublicListingFlipLimit({ write: tier.write, kv: env.SCORE_KV, domain: target.host });
  if (budget === 'rate-limited') return { ok: false, reason: 'flip_rate_limited' };
  const wrote = await patchStoredPublicListing(env, tier.cached, tier.write.value);
  if (!wrote) return { ok: false, reason: 'patch_failed' };
  queueHitMinPurge([webTag()]);
  return {
    ok: true,
    cached: { ...tier.cached, scorecard: scorecardWithPublicListing(tier.cached.scorecard, tier.write.value) },
  };
}

/** Meter a re-audit whose resolved listing changes the stored flag. */
export async function meterWebAuditFlip(
  env: WebCoreEnv,
  target: WebTarget,
  write: PublicListingWrite,
): Promise<boolean> {
  return (await enforcePublicListingFlipLimit({ write, kv: env.SCORE_KV, domain: target.host })) === 'allowed';
}

export type RunWebAuditInput = {
  env: WebCoreEnv;
  target: WebTarget;
  siteType: WebSiteType | null;
  listing: boolean;
  /**
   * The caller's follow choice; the operator's switch can still turn
   * following off. A caller that opts out gets a result that is never saved.
   */
  followDeclarations: boolean;
  origin: string;
  probeFetch?: typeof fetch;
  surface: 'stream' | 'mcp';
};

function checkEvent(result: EngineResult): AuditEvent {
  const { host, hosts } = rowHostFields(result.raw_evidence);
  return {
    type: 'check',
    id: result.id,
    principle: result.principle,
    keyword: result.keyword,
    status: result.status,
    evidence: result.evidence,
    ...(host !== undefined ? { host } : {}),
    ...(hosts.length > 1 ? { hosts } : {}),
    ...(result.na_reason !== undefined ? { na_reason: result.na_reason } : {}),
  };
}

/**
 * Why a followed run is not saved: a declared domain's spent hourly budget
 * left rows unevaluated, so the site's saved scorecard stands. A site with
 * none saved gets this run saved like any audit; the one-minute reuse
 * window then bounds how long the budget-limited result is served.
 */
async function domainBudgetHold(
  env: WebCoreEnv,
  target: WebTarget,
  scorecard: WebScorecard,
): Promise<TransientReason | undefined> {
  const domain = domainBudgetRefusal(scorecard);
  if (domain === null) return undefined;
  const saved = await readStoredWebAudit(env, target);
  if (saved === null) return undefined;
  return {
    kind: 'domain-budget',
    domain,
    host: target.host,
    savedScoredAt: saved.scored_at ?? null,
    retryAt: hourWindowEndsAt(Date.now()),
  };
}

/**
 * Run the engine and yield shared events: `discovery`, one `check` per
 * result, then one terminal event. A complete run is written to R2, the
 * board tags are queued for purge, the seeded aggregates are rebuilt, and
 * the terminal is `complete` carrying the live envelope; a complete run the
 * caller opted out of following, or one a declared domain's spent hourly
 * budget held back from replacing a saved scorecard, writes, purges, and
 * rebuilds nothing and ends on the transient envelope; a deadline-bound run
 * yields `incomplete` and is never persisted; an unreachable target or a
 * thrown engine yields `error`.
 */
export async function* runWebAuditStream(input: RunWebAuditInput): AsyncGenerator<AuditEvent> {
  const { env, target } = input;
  let scorecard: WebScorecard | null = null;
  let complete = false;
  const followDeclarations = effectiveFollow(env, input.followDeclarations);
  try {
    const registry = await loadWebAuditRegistry(env);
    for await (const event of instrumentAuditEvents(
      runWebAudit({
        url: target.canonical,
        registry,
        siteType: input.siteType,
        publicListing: input.listing,
        specVersion: SPEC_VERSION,
        followDeclarations,
        domainBudget: declaredDomainBudget(env),
        fetchOptions: input.probeFetch ? { fetchImpl: input.probeFetch } : undefined,
      }),
      env,
      { target: target.canonical, surface: input.surface, followDeclarations },
    )) {
      if (event.type === 'discovery') {
        yield { type: 'discovery', mcp_endpoint: event.endpoint };
      } else if (event.type === 'result') {
        yield checkEvent(event.result);
      } else if (event.type === 'unreachable') {
        yield {
          type: 'error',
          error: { code: 'unreachable', message: event.reason, cta: 'Check the address and try again.' },
        };
        return;
      } else if (event.type === 'complete') {
        scorecard = event.scorecard;
        complete = event.complete;
      }
    }
    // One scoring instant per run, spent on both persistence and the
    // terminal envelope, so the cache read that follows can never report
    // a different clock for the same audit.
    const scoredAt = complete && scorecard ? new Date().toISOString() : null;
    if (scorecard && scoredAt) {
      const stamped = await withRegistryFingerprint(scorecard, registry);
      const transient: TransientReason | undefined = input.followDeclarations
        ? await domainBudgetHold(env, target, stamped)
        : { kind: 'opt-out' };
      if (!transient) {
        const wrote = await cachePut(env, target.canonical, stamped, SPEC_VERSION, scoredAt);
        if (wrote) queueHitMinPurge([webTag(), webDomainTag(target.host)]);
        await rebuildAggregatesIfSeeded(env, target.host, SPEC_VERSION);
      }
      const record: CachedWebAudit = {
        spec_version: SPEC_VERSION,
        target_url: target.canonical,
        scorecard: stamped,
        scored_at: scoredAt,
      };
      yield {
        type: 'complete',
        ...(await webEnvelope(env, { tier: 'live', host: target.host, record, origin: input.origin, transient })),
      };
      return;
    }
    yield { type: 'incomplete', scorecard };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logAuditError(target.canonical, input.surface, err);
    yield { type: 'error', error: { code: 'unreachable', message, cta: CTA_RETRY } };
    await notifyFailure(env, {
      key: `web-audit-${input.surface}`,
      subject: `web-audit ${input.surface} task failed`,
      text: `The ${input.surface} audit task threw for ${target.canonical}: ${message}`,
    });
  }
}
