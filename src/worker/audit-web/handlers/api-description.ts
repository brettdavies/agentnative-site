// api-description eval rule, the OpenAPI row. With no API anchor in the
// API catalog, the row probes the audited origin's well-known paths as an
// `http` check does. With API anchors, it scores the description each
// anchor declares instead, wherever it is hosted: one the follow slice
// read off the audited origin, or one on the audited origin, read here.
// Presence is the check's own `expect`, so a YAML description passes as a
// JSON one does, and one cut at OPENAPI_MAX_BODY_BYTES still counts as
// present, its evidence marked truncated.

import type { ApiDescriptionTarget } from '../api-targets';
import type { WebCheck } from '../registry';
import { guardedFetch, OPENAPI_MAX_BODY_BYTES } from '../ssrf';
import { assessResponse, classifyMiss, type HttpWith, runHttp } from './http';
import { aggregateTargets, type TargetOutcome, timeoutMsFor } from './shared';
import type { EvidenceItem, HandlerContext, ProbeOutcome } from './types';

async function describe(
  target: ApiDescriptionTarget,
  w: HttpWith,
  ctx: HandlerContext,
  timeoutMs: number,
): Promise<TargetOutcome> {
  if ('unmet' in target) {
    const { reason, host, url } = target.unmet;
    return { status: 'na', na_reason: reason, evidence: [{ host, description: target.url, why: [url] }] };
  }
  const read =
    'fetched' in target
      ? target.fetched
      : {
          url: target.url,
          response: await guardedFetch(
            target.url,
            {},
            { ...ctx.fetchOptions, timeoutMs, maxBodyBytes: OPENAPI_MAX_BODY_BYTES },
          ),
        };
  const { ok, item } = assessResponse(read.url, read.response, w, ctx.base);
  const evidence: EvidenceItem[] = [{ ...item, description: target.url }];
  return { status: ok ? 'pass' : classifyMiss(read.response, w.expect ?? {}, w.timeout !== undefined), evidence };
}

export async function runApiDescription(check: WebCheck, ctx: HandlerContext): Promise<ProbeOutcome> {
  const targets = ctx.apiTargets;
  if (targets === undefined || targets === null) return runHttp(check, ctx);
  if (targets.descriptions.length === 0) {
    return { status: 'na', evidence: [{ why: ['no OpenAPI description the audit can request'] }] };
  }
  const w = check.with as HttpWith;
  const timeoutMs = timeoutMsFor(w.timeout, ctx.defaultTimeoutMs);
  return aggregateTargets(await Promise.all(targets.descriptions.map((target) => describe(target, w, ctx, timeoutMs))));
}

/** The descriptions the OpenAPI row retained, by the URL the catalog declared each at. */
export function apiDescriptionBodies(evidence: readonly EvidenceItem[]): Map<string, string> {
  const bodies = new Map<string, string>();
  for (const item of evidence) {
    if (typeof item.description === 'string' && typeof item.body === 'string') bodies.set(item.description, item.body);
  }
  return bodies;
}
