// Web-rescore Workflow: audits every seeded domain, one Workflow step per
// domain, then rebuilds both board aggregates in a final step. The final
// step is the completion barrier: per-domain entries land in R2 first,
// then a single rebuild reads them back and writes the board objects. A
// single scheduled() invocation cannot run the whole board itself (each
// audit is ~25-35 subrequests against a 25s deadline), which is why the
// fan-out lives in a Workflow: per-step retries, isolation, and durable
// sequencing. Single-flighting happens at the trigger (startWebRescore),
// not here — the run itself is idempotent and re-triggerable.

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { SPEC_VERSION } from '../spec-version.gen';
import { rebuildWebAggregates, type WebAggregateEnv } from './aggregate';
import { put as cachePut, canonicalTargetOf } from './cache';
import { runWebAudit } from './engine';
import { loadWebAuditRegistry } from './registry';
import { loadWebSeed } from './seed';

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
}

// One audit is ~30s of fan-out probes; two retries cover transient target
// flakiness without letting one dead domain stall the weekly batch.
const AUDIT_STEP_CONFIG = {
  retries: { limit: 2, delay: '30 seconds', backoff: 'exponential' },
  timeout: '2 minutes',
} as const;

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

/**
 * The Workflow body, extracted so tests can drive it with a fake step and
 * injected audit/rebuild. A per-domain failure (after step retries) is
 * logged and skipped — the domain drops off that board rebuild — and the
 * run always reaches the final rebuild step.
 */
export async function runWebRescore(
  env: WebRescoreEnv,
  step: RescoreStep,
  deps: RescoreDeps = {},
): Promise<{ audited: string[]; skipped: string[] }> {
  const audit = deps.audit ?? auditDomainToCache;
  const rebuild = deps.rebuild ?? rebuildWebAggregates;

  const seed = await step.do('load-seed', async () => loadWebSeed(env));
  const audited: string[] = [];
  const skipped: string[] = [];
  for (const entry of seed) {
    const target = canonicalTargetOf(new URL(entry.url));
    try {
      await step.do(`audit:${entry.domain}`, AUDIT_STEP_CONFIG, async () => {
        await audit(env, target);
      });
      audited.push(entry.domain);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(JSON.stringify({ scope: 'web-rescore', domain: entry.domain, error: message }));
      skipped.push(entry.domain);
    }
  }
  await step.do('rebuild-aggregate', async () => {
    await rebuild(env, SPEC_VERSION);
  });
  return { audited, skipped };
}

export class WebRescoreWorkflow extends WorkflowEntrypoint<WebRescoreEnv> {
  async run(_event: Readonly<WorkflowEvent<unknown>>, step: WorkflowStep): Promise<unknown> {
    return runWebRescore(this.env, step);
  }
}
