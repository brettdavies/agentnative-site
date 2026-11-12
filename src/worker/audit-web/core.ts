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
//                            saves no scorecard and ends on a transient
//                            envelope
//
// The core never reads a token, a session, or a limiter; admission is the
// caller's. It keeps stale-serve-when-disabled (a caller decides to serve
// a stale hit as data when the kill switch is off), the listing patch, and
// the per-domain flip budget.

import { type AuditEnvelope, buildWebEnvelope, transientWebEnvelope } from '../../shared/audit-envelope';
import { type AuditEvent, CTA_RETRY } from '../../shared/audit-events';
import { type NotifyEnv, notifyFailure } from '../notify';
import { type OgVideoEnv, requestRender } from '../og/render-request';
import { SPEC_VERSION } from '../spec-version.gen';
import { rebuildAggregatesIfSeeded } from './aggregate';
import { type AuditLogEnv, instrumentAuditEvents, logAuditError } from './audit-log';
import {
  type CachedWebAudit,
  get as cacheGet,
  put as cachePut,
  isStale,
  keyFor,
  patchStoredPublicListing,
  scorecardWithPublicListing,
  WEB_AUDIT_STALE_AFTER_MS,
} from './cache';
import { enrichWebScorecardForDisplay } from './display';
import { type DomainBudgetEnv, declaredDomainBudget } from './domain-budget';
import { runWebAudit } from './engine';
import type { DomainRefusal } from './follow-requests';
import { effectiveFollow, type FollowSwitchEnv } from './follow-switch';
import { heldRun } from './held-run';
import { queueAfterHitMinPurge, queueHitMinPurge, webDomainTag, webTag } from './hit-min-purge';
import { rowHostFields } from './provenance';
import {
  decidePublicListingWrite,
  enforcePublicListingFlipLimit,
  meterListingFlip,
  type PublicListingWrite,
  resolveAuditListing,
  standingPublicListing,
  storedPublicListing,
} from './public-listing';
import { loadWebAuditRegistry, type WebAuditRegistry, type WebSiteType, withRegistryFingerprint } from './registry';
import { loadWebRemediationCatalog, type WebRemediationCatalog } from './remediation';
import type { EngineResult, WebScorecard } from './scorecard';
import type { PairReport } from './site-pair';
import { planSiteRecord, settleSiteRecord } from './site-record';
import type { WebScorecardShape } from './summary-model';
import { buildWebSummaryBody } from './summary-render';
import type { TransientReason } from './summary-transient';
import type { WebTarget } from './web-target';

export interface WebCoreEnv extends AuditLogEnv, NotifyEnv, FollowSwitchEnv, DomainBudgetEnv, OgVideoEnv {
  ASSETS: Fetcher;
  SCORE_CACHE: R2Bucket;
  SCORE_KV?: KVNamespace;
}

export { prepareWebTarget, type WebTarget } from './web-target';

export type WebTier =
  | { kind: 'serve'; cached: CachedWebAudit; fresh: boolean }
  | { kind: 'patch'; write: Extract<PublicListingWrite, { path: 'patch' }>; cached: CachedWebAudit }
  | { kind: 'audit'; cached: CachedWebAudit | null; listing: boolean; write: PublicListingWrite };

/**
 * The target's stored audit, or null when none was ever saved. `known` is a
 * read the caller already made of this target: a record, a miss, or undefined
 * when it made none.
 */
async function readStoredWebAudit(
  env: WebCoreEnv,
  target: WebTarget,
  known?: CachedWebAudit | null,
): Promise<CachedWebAudit | null> {
  return known !== undefined ? known : cacheGet(env, await keyFor(target.canonical, SPEC_VERSION));
}

/** The listing a run that saves nothing carries: the target's stored choice, unlisted when it has none. */
export async function readStandingListing(
  env: WebCoreEnv,
  target: WebTarget,
  known?: CachedWebAudit | null,
): Promise<boolean> {
  return standingPublicListing(await readStoredWebAudit(env, target, known));
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
  known?: CachedWebAudit | null,
): Promise<WebTier> {
  const cached = await readStoredWebAudit(env, target, known);
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
  | { ok: true; cached: CachedWebAudit; written: boolean }
  | { ok: false; reason: 'flip_rate_limited' | 'patch_failed' };

/**
 * The listing-only write: meter the per-domain flip budget, then patch the
 * record as it stands at that moment with the new flag and its scored_at
 * preserved, and queue the board purge. The record is read after the budget
 * because the rate-limit windows before it can take over a second, and an
 * audit saved meanwhile must not be replaced by an older scorecard. A record
 * that already stores the flag is returned unwritten (`written: false`) with
 * the budget unit spent.
 */
export async function patchWebListing(env: WebCoreEnv, target: WebTarget, value: boolean): Promise<PatchOutcome> {
  if ((await meterListingFlip(env.SCORE_KV, target.host)) === 'rate-limited') {
    return { ok: false, reason: 'flip_rate_limited' };
  }
  const current = await cacheGet(env, await keyFor(target.canonical, SPEC_VERSION));
  if (current === null) return { ok: false, reason: 'patch_failed' };
  if (storedPublicListing(current) === value) return { ok: true, cached: current, written: false };
  if (!(await patchStoredPublicListing(env, current, value))) return { ok: false, reason: 'patch_failed' };
  queueHitMinPurge([webTag()]);
  return {
    ok: true,
    cached: { ...current, scorecard: scorecardWithPublicListing(current.scorecard, value) },
    written: true,
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
  /** The site the request named, which keys admission and the job; the scorecard is stored under the site the audit finds. */
  target: WebTarget;
  /** The host the audit starts at, when the request typed a different host than `target`. */
  requested?: WebTarget;
  siteType: WebSiteType | null;
  /** The listing resolved against `target`'s stored record. */
  listing: boolean;
  /** The caller's explicit listing choice; undefined for a blank request. */
  explicitListing?: boolean;
  /**
   * The caller's follow choice; the operator's switch can still turn
   * following off. A caller that opts out gets a result that is never saved.
   */
  followDeclarations: boolean;
  origin: string;
  probeFetch?: typeof fetch;
  surface: 'stream' | 'mcp';
};

/** A streamed row names its hosts only when one lies outside the audited site; a row from the site itself names none. */
function checkEvent(result: EngineResult, siteHosts: readonly string[]): AuditEvent {
  const fields = rowHostFields(result.raw_evidence);
  const onSite = fields.hosts.length > 0 && fields.hosts.every((entry) => siteHosts.includes(entry.host));
  const { host, hosts } = onSite ? { host: undefined, hosts: [] } : fields;
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
 * Run the engine and yield shared events: `discovery`, one `check` per
 * result, then one terminal event. A complete run is written to R2, the
 * board tags are queued for purge, the seeded aggregates are rebuilt, and
 * the terminal is `complete` carrying the live envelope; a complete run the
 * caller opted out of following, or one a declared domain's spent hourly
 * budget held back from replacing a saved scorecard, saves no scorecard,
 * rebuilds nothing, and ends on the transient envelope, though a held run
 * still writes the listing it resolved onto the saved scorecard; a
 * deadline-bound run yields `incomplete` and is never persisted; an
 * unreachable target or a thrown engine yields `error`.
 */
export async function* runWebAuditStream(input: RunWebAuditInput): AsyncGenerator<AuditEvent> {
  const { env, target } = input;
  const requested = input.requested ?? target;
  let scorecard: WebScorecard | null = null;
  let complete = false;
  let pair: PairReport | null = null;
  let refusals: Readonly<Record<string, DomainRefusal>> = {};
  let siteHosts: readonly string[] = [];
  const followDeclarations = effectiveFollow(env, input.followDeclarations);
  try {
    const registry = await loadWebAuditRegistry(env);
    for await (const event of instrumentAuditEvents(
      runWebAudit({
        url: requested.canonical,
        registry,
        siteType: input.siteType,
        publicListing: input.listing,
        specVersion: SPEC_VERSION,
        followDeclarations,
        domainBudget: declaredDomainBudget(env),
        fetchOptions: input.probeFetch ? { fetchImpl: input.probeFetch } : undefined,
      }),
      env,
      { target: requested.canonical, surface: input.surface, followDeclarations },
    )) {
      if (event.type === 'discovery') {
        siteHosts = event.siteHosts ?? [];
        yield { type: 'discovery', mcp_endpoint: event.endpoint };
      } else if (event.type === 'result') {
        yield checkEvent(event.result, siteHosts);
      } else if (event.type === 'unreachable') {
        yield {
          type: 'error',
          error: {
            code: 'unreachable',
            message: event.reason,
            cta: event.sibling === undefined ? 'Check the address and try again.' : `Audit ${event.sibling} instead.`,
          },
        };
        return;
      } else if (event.type === 'complete') {
        scorecard = event.scorecard;
        complete = event.complete;
        pair = event.pair ?? null;
        refusals = event.follow.budgetRefusals;
      }
    }
    // One scoring instant per run, spent on both persistence and the
    // terminal envelope, so the cache read that follows can never report
    // a different clock for the same audit.
    const scoredAt = complete && scorecard ? new Date().toISOString() : null;
    if (scorecard && scoredAt) {
      const stamped = await withRegistryFingerprint(scorecard, registry);
      const site = await planSiteRecord(env, {
        target,
        requested,
        pair,
        scorecard: stamped,
        explicit: input.explicitListing,
        listing: input.listing,
      });
      const held = input.followDeclarations
        ? await heldRun(env, site.target, site.scorecard, site.listing, refusals)
        : null;
      const transient: TransientReason | undefined = input.followDeclarations ? held?.reason : { kind: 'opt-out' };
      if (!transient) {
        const wrote = await cachePut(env, site.target.canonical, site.scorecard, SPEC_VERSION, scoredAt);
        if (wrote) {
          await settleSiteRecord(env, site);
          queueHitMinPurge([webTag(), webDomainTag(site.target.host), ...site.alsoPurge.map(webDomainTag)]);
          queueAfterHitMinPurge(`render:${site.target.host}`, () => requestRender(env, site.target.host));
        }
        await rebuildAggregatesIfSeeded(env, site.target.host, SPEC_VERSION);
      }
      const record: CachedWebAudit = {
        spec_version: SPEC_VERSION,
        target_url: site.target.canonical,
        scorecard: held ? scorecardWithPublicListing(site.scorecard, held.listing) : site.scorecard,
        scored_at: scoredAt,
      };
      yield {
        type: 'complete',
        ...(await webEnvelope(env, { tier: 'live', host: site.target.host, record, origin: input.origin, transient })),
      };
      return;
    }
    yield { type: 'incomplete', scorecard };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logAuditError(requested.canonical, input.surface, err);
    yield { type: 'error', error: { code: 'unreachable', message, cta: CTA_RETRY } };
    await notifyFailure(env, {
      key: `web-audit-${input.surface}`,
      subject: `web-audit ${input.surface} task failed`,
      text: `The ${input.surface} audit task threw for ${requested.canonical}: ${message}`,
    });
  }
}
