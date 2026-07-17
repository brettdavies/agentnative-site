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

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { SPEC_VERSION } from '../spec-version.gen';
import { rebuildWebAggregates, type WebAggregateEnv } from './aggregate';
import { get as cacheGet, put as cachePut, canonicalTargetOf, isStale, keyFor } from './cache';
import { runWebAudit } from './engine';
import { loadWebAuditRegistry } from './registry';
import { loadWebSeed, type WebSeedEntry } from './seed';

export type WebRescoreEnv = WebAggregateEnv;

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
  /** Audits per cycle before a board rebuild; defaults to RESCORE_BATCH_SIZE. */
  batchSize?: number;
  /** Injectable clock for deterministic eligibility tests. */
  now?: () => number;
}

// One audit is ~30s of fan-out probes; two retries cover transient target
// flakiness without letting one dead domain stall the batch.
const AUDIT_STEP_CONFIG = {
  retries: { limit: 2, delay: '30 seconds', backoff: 'exponential' },
  timeout: '2 minutes',
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

/** Run one seeded domain's audit to completion and cache the scorecard. */
export async function auditDomainToCache(env: WebRescoreEnv, targetUrl: string): Promise<void> {
  const registry = await loadWebAuditRegistry(env);
  let scorecard: unknown = null;
  let complete = false;
  for await (const event of runWebAudit({ url: targetUrl, registry, siteType: null, specVersion: SPEC_VERSION })) {
    if (event.type === 'complete') {
      scorecard = event.scorecard;
      complete = event.complete;
    }
  }
  if (!complete || !scorecard) {
    throw new Error(`audit did not complete within the deadline for ${targetUrl}`);
  }
  await cachePut(env, targetUrl, scorecard, SPEC_VERSION);
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
): Promise<BatchItem[]> {
  const rows: Array<{ domain: string; target: string; scoredAtMs: number }> = [];
  for (const entry of seed) {
    if (attempted.has(entry.domain)) continue;
    const target = canonicalTargetOf(new URL(entry.url));
    const cached = await cacheGet(env, await keyFor(target, SPEC_VERSION));
    if (!isStale(cached?.scored_at, RESCORE_ELIGIBLE_AFTER_MS, now)) continue;
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
  const audited: string[] = [];
  const skipped: string[] = [];
  const attempted = new Set<string>();
  let cycle = 0;

  for (; cycle < RESCORE_MAX_CYCLES; cycle++) {
    const batch = await step.do(`select:${cycle}`, async () =>
      selectStaleBatch(env, seed, attempted, batchSize, clock()),
    );
    if (batch.length === 0) break;
    for (const { domain, target } of batch) {
      attempted.add(domain);
      try {
        await step.do(`audit:${domain}`, AUDIT_STEP_CONFIG, async () => {
          await audit(env, target);
        });
        audited.push(domain);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.log(JSON.stringify({ scope: 'web-rescore', domain, error: message }));
        skipped.push(domain);
      }
    }
    await step.do(`rebuild:${cycle}`, async () => {
      await rebuild(env, SPEC_VERSION);
    });
  }

  // Nothing eligible (e.g., a redeploy right after a full run): still refresh
  // the board once so a rescore always leaves a current aggregate.
  if (cycle === 0) {
    await step.do('rebuild:idle', async () => {
      await rebuild(env, SPEC_VERSION);
    });
  }
  return { audited, skipped, cycles: cycle };
}

export class WebRescoreWorkflow extends WorkflowEntrypoint<WebRescoreEnv> {
  async run(_event: Readonly<WorkflowEvent<unknown>>, step: WorkflowStep): Promise<unknown> {
    return runWebRescore(this.env, step);
  }
}
