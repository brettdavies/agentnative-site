// Web-rescore Workflow: staleness-batched, self-draining. Each cycle
// selects the seeded domains whose cached audit is oldest and older than
// the eligibility window (or never audited), takes up to RESCORE_BATCH_SIZE
// of them oldest-first, audits each in its own step, then rebuilds both
// board aggregates. It loops cycles until no eligible domain remains, so
// the board list is dynamic: a single run drains the whole queue in bounded
// batches regardless of board size, and anything a run cannot reach stays
// stale and is picked up by the next run.
//
// The eligibility window doubles as a debounce: a domain an on-demand audit
// refreshed within the window is skipped, and a domain audited earlier in
// the same run is fresh on the next cycle's read, so the queue shrinks each
// cycle. Termination does not depend on that alone: an attempted-set drops
// each domain after one attempt per run, so a domain whose audit keeps
// failing (its scored_at never advances) cannot re-fill every batch and
// spin forever. Single-flighting happens at the trigger (startWebRescore),
// not here — the run is idempotent and re-triggerable.
//
// A registry-shape change (a check retiered, a category split, a new check)
// or a flip of the follow kill switch is detected against what KV recorded
// on the last run and forces one full reflow, so every cached scorecard is
// re-scored under the new shape and follow state; see
// REGISTRY_FINGERPRINT_KEY and FOLLOW_STATE_KEY.

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { SPEC_VERSION } from '../spec-version.gen';
import { emitLog } from '../telemetry/log';
import { rebuildWebAggregates, type WebAggregateEnv } from './aggregate';
import { type AuditLogEnv, instrumentAuditEvents } from './audit-log';
import { get as cacheGet, put as cachePut, canonicalTargetOf, isStale, keyFor } from './cache';
import { type DomainBudgetEnv, declaredDomainBudget } from './domain-budget';
import { runWebAudit } from './engine';
import { effectiveFollow, type FollowSwitchEnv } from './follow-switch';
import { homeTag, invokeCachedPurge, webDomainTag, webTag } from './hit-min-purge';
import { loadWebAuditRegistry, registryFingerprint, withRegistryFingerprint } from './registry';
import type { WebScorecard } from './scorecard';
import { isSeededDomain, loadWebSeed, type WebSeedEntry } from './seed';

// The Workflow shares the Worker's bindings; SCORE_KV is optional so the
// registry-change gate degrades to plain staleness batching when it is
// absent (e.g. a minimal test env).
export type WebRescoreEnv = WebAggregateEnv &
  AuditLogEnv &
  FollowSwitchEnv &
  DomainBudgetEnv & { SCORE_KV?: KVNamespace };

// Narrow structural view of the Workflow binding (mirrors the RateLimit
// pattern): enough surface for the trigger helper and its tests.
export type WebRescoreWorkflowBinding = {
  get(id: string): Promise<{ status(): Promise<{ status: string }> }>;
  create(options?: { id?: string; params?: unknown }): Promise<{ id: string }>;
};

export type RescoreStep = Pick<WorkflowStep, 'do'>;

export interface RescoreDeps {
  /** Audits one canonical target to completion and caches it; throws on failure. */
  audit?: (env: WebRescoreEnv, targetUrl: string) => Promise<void>;
  rebuild?: (env: WebRescoreEnv, specVersion: string) => Promise<unknown>;
  /** One HIT-min purge after a rebuild cycle. Receives the union of tags. */
  purgeTags?: (tags: string[]) => Promise<void>;
  /** Audits per cycle before a board rebuild; defaults to RESCORE_BATCH_SIZE. */
  batchSize?: number;
  /** Injectable clock for deterministic eligibility tests. */
  now?: () => number;
  /** Override the staleness eligibility window (ms). Defaults to the 2h
   * rotation window; the registry-change gate drops it to 0 for a full
   * reflow. Setting it also bypasses the gate (tests drive the window
   * directly). */
  eligibleAfterMs?: number;
  /** Injectable registry fingerprint for the change gate; defaults to the
   * fingerprint of the registry the audits load. */
  fingerprint?: (env: WebRescoreEnv) => Promise<string>;
}

// Background rescore of arbitrary external sites is patient: the interactive
// 25s engine default trips the deadline on slower Worker-runtime egress
// (leaving the domain unscored), so give each audit a longer budget that
// still fits inside one step.
const RESCORE_AUDIT_DEADLINE_MS = 90_000;

// One audit runs up to RESCORE_AUDIT_DEADLINE_MS of fan-out probes; two
// retries cover transient target flakiness without letting one dead domain
// stall the batch, and the step timeout leaves headroom over the deadline.
const AUDIT_STEP_CONFIG = {
  retries: { limit: 2, delay: '30 seconds', backoff: 'exponential' },
  timeout: '3 minutes',
} as const;

// Audits per cycle before the board is rebuilt. Bounds one Workflow
// segment's step count and gives the board a progressive refresh as a large
// queue drains.
const RESCORE_BATCH_SIZE = 20;

// A domain audited more recently than this is not re-audited by a rescore.
// It is the oldest-first rotation key and the on-demand debounce window.
const RESCORE_ELIGIBLE_AFTER_MS = 2 * 60 * 60_000;

// Backstop against an unbounded loop. The attempted-set already guarantees
// progress (one attempt per domain per run); this only bounds a seed larger
// than MAX_CYCLES * batchSize, whose tail waits for the next run.
const RESCORE_MAX_CYCLES = 200;

// KV marker for the registry shape the last rescore ran against. A check
// retiered, a category split, or a new check changes the fingerprint; the
// next rescore then reflows every cached scorecard (eligibility window 0)
// so each re-renders under the new shape, and records the new fingerprint
// to return to incremental staleness batching. This closes the gap where a
// display-only registry change (which does not rotate the SPEC_VERSION cache
// key) leaves cached scorecards grouped under the old shape until they
// age out.
const REGISTRY_FINGERPRINT_KEY = 'web_rescore:registry_fp';

// KV marker for the follow state the last rescore ran with: "true" or
// "false", the switch as audits read it, so "TRUE" and an unset secret
// record one state rather than minting a reflow between them. A flip
// changes what every seed's declared-host rows can hold, so it forces a
// reflow as a registry change does. It is kept apart from the fingerprint
// so staging and production, whose switches differ, agree on that.
const FOLLOW_STATE_KEY = 'web_rescore:follow_enabled';

/** Run one seeded domain's audit to completion and cache the scorecard. */
export async function auditDomainToCache(env: WebRescoreEnv, targetUrl: string): Promise<void> {
  const registry = await loadWebAuditRegistry(env);
  // Curated seeds are always listed; deriving the flag here keeps a rescore
  // or reflow re-audit from resetting the stored opt-in to the default in
  // the envelope and the R2 board metadata.
  const publicListing = await isSeededDomain(env, new URL(targetUrl).host);
  const followDeclarations = effectiveFollow(env, true);
  let scorecard: WebScorecard | null = null;
  let complete = false;
  for await (const event of instrumentAuditEvents(
    runWebAudit({
      url: targetUrl,
      registry,
      siteType: null,
      publicListing,
      specVersion: SPEC_VERSION,
      followDeclarations,
      domainBudget: declaredDomainBudget(env),
      perAuditDeadlineMs: RESCORE_AUDIT_DEADLINE_MS,
    }),
    env,
    { target: targetUrl, surface: 'rescore', followDeclarations },
  )) {
    if (event.type === 'complete') {
      scorecard = event.scorecard;
      complete = event.complete;
    } else if (event.type === 'unreachable') {
      throw new Error(`target unreachable for ${targetUrl}: ${event.reason}`);
    }
  }
  if (!complete || !scorecard) {
    throw new Error(`audit did not complete within the deadline for ${targetUrl}`);
  }
  await cachePut(env, targetUrl, await withRegistryFingerprint(scorecard, registry), SPEC_VERSION);
}

async function currentRegistryFingerprint(env: WebRescoreEnv): Promise<string> {
  return registryFingerprint(await loadWebAuditRegistry(env));
}

type BatchItem = { domain: string; target: string };

/**
 * The eligible seeded domains for the next cycle: never audited or audited
 * before the eligibility window, excluding any already attempted this run,
 * sorted oldest-first and capped at `batchSize`. A never-audited or
 * unparseable-stamp entry sorts first (treated as epoch-old).
 */
async function selectStaleBatch(
  env: WebRescoreEnv,
  seed: readonly WebSeedEntry[],
  attempted: ReadonlySet<string>,
  batchSize: number,
  now: number,
  eligibleAfterMs: number,
): Promise<BatchItem[]> {
  const rows: Array<{ domain: string; target: string; scoredAtMs: number }> = [];
  for (const entry of seed) {
    if (attempted.has(entry.domain)) continue;
    const target = canonicalTargetOf(new URL(entry.url));
    const cached = await cacheGet(env, await keyFor(target, SPEC_VERSION));
    if (!isStale(cached?.scored_at, eligibleAfterMs, now)) continue;
    const parsed = cached?.scored_at ? Date.parse(cached.scored_at) : 0;
    rows.push({ domain: entry.domain, target, scoredAtMs: Number.isNaN(parsed) ? 0 : parsed });
  }
  rows.sort((a, b) => a.scoredAtMs - b.scoredAtMs);
  return rows.slice(0, batchSize).map(({ domain, target }) => ({ domain, target }));
}

/**
 * The Workflow body, extracted so tests can drive it with a fake step and
 * injected audit/rebuild. A per-domain failure (after step retries) is
 * logged and skipped — the domain drops off that board rebuild and, because
 * its scored_at never advanced, is retried by the next run.
 */
export async function runWebRescore(
  env: WebRescoreEnv,
  step: RescoreStep,
  deps: RescoreDeps = {},
): Promise<{ audited: string[]; skipped: string[]; cycles: number }> {
  const audit = deps.audit ?? auditDomainToCache;
  const rebuild = deps.rebuild ?? rebuildWebAggregates;
  const batchSize = deps.batchSize ?? RESCORE_BATCH_SIZE;
  const clock = deps.now ?? Date.now;

  const seed = await step.do('load-seed', async () => loadWebSeed(env));

  // Registry-change gate: when the current registry fingerprint or follow
  // state differs from the one KV recorded on the last run, reflow every
  // cached scorecard (eligibility 0) so the board re-renders under the new
  // shape, then record both below. An explicit deps.eligibleAfterMs (tests)
  // bypasses the gate; a missing SCORE_KV degrades to plain staleness batching.
  let eligibleAfterMs = deps.eligibleAfterMs ?? RESCORE_ELIGIBLE_AFTER_MS;
  let shapeToRecord: { fingerprint: string; follow: string } | null = null;
  if (deps.eligibleAfterMs === undefined && env.SCORE_KV) {
    const kv = env.SCORE_KV;
    const compute = deps.fingerprint ?? currentRegistryFingerprint;
    const currentFp = await step.do('registry-fingerprint', async () => compute(env));
    const currentFollow = await step.do('follow-switch', async () => String(effectiveFollow(env, true)));
    const priorFp = await step.do('registry-fingerprint:prior', async () =>
      kv.get(REGISTRY_FINGERPRINT_KEY).catch(() => null),
    );
    const priorFollow = await step.do('follow-switch:prior', async () => kv.get(FOLLOW_STATE_KEY).catch(() => null));
    if (priorFp !== currentFp || priorFollow !== currentFollow) {
      eligibleAfterMs = 0;
      shapeToRecord = { fingerprint: currentFp, follow: currentFollow };
    }
  }

  const audited: string[] = [];
  const skipped: string[] = [];
  const attempted = new Set<string>();
  let cycle = 0;

  for (; cycle < RESCORE_MAX_CYCLES; cycle++) {
    const batch = await step.do(`select:${cycle}`, async () =>
      selectStaleBatch(env, seed, attempted, batchSize, clock(), eligibleAfterMs),
    );
    if (batch.length === 0) break;
    const cycleAudited: string[] = [];
    for (const { domain, target } of batch) {
      attempted.add(domain);
      try {
        await step.do(`audit:${domain}`, AUDIT_STEP_CONFIG, async () => {
          await audit(env, target);
        });
        audited.push(domain);
        cycleAudited.push(domain);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        emitLog({ scope: 'web-rescore' }, { domain, error: message });
        skipped.push(domain);
      }
    }
    await step.do(`rebuild:${cycle}`, async () => {
      await rebuild(env, SPEC_VERSION);
    });
    if (deps.purgeTags) {
      await deps.purgeTags([homeTag(), webTag(), ...cycleAudited.map(webDomainTag)]);
    }
  }

  // Nothing eligible (e.g., a redeploy right after a full run): still refresh
  // the board once so a rescore always leaves a current aggregate.
  if (cycle === 0) {
    await step.do('rebuild:idle', async () => {
      await rebuild(env, SPEC_VERSION);
    });
    if (deps.purgeTags) await deps.purgeTags([homeTag(), webTag()]);
  }

  // Record the new fingerprint and follow state only after the reflow
  // drains, so a run that dies partway re-forces on the next trigger instead
  // of stranding the remaining domains under the old shape.
  if (shapeToRecord !== null && env.SCORE_KV) {
    const kv = env.SCORE_KV;
    const { fingerprint, follow } = shapeToRecord;
    await step.do('registry-fingerprint:record', async () => {
      await kv.put(REGISTRY_FINGERPRINT_KEY, fingerprint);
      await kv.put(FOLLOW_STATE_KEY, follow);
    });
  }
  return { audited, skipped, cycles: cycle };
}

export class WebRescoreWorkflow extends WorkflowEntrypoint<WebRescoreEnv> {
  async run(_event: Readonly<WorkflowEvent<unknown>>, step: WorkflowStep): Promise<unknown> {
    return runWebRescore(this.env, step, {
      purgeTags: (tags) => invokeCachedPurge(this.ctx, tags),
    });
  }
}
