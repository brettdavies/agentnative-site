// api-description eval rule, the OpenAPI row. With no API anchor in the
// API catalog, the row probes the audited origin's well-known paths as an
// `http` check does. With API anchors, it scores the description each
// anchor declares instead, wherever it is hosted: one the follow slice
// read off the audited origin, or one on the audited origin, read here.
// Presence is the check's own `expect`, so a YAML description passes as a
// JSON one does. A description cut at OPENAPI_MAX_BODY_BYTES can hold its
// marker past the bytes read (Stripe's spec3.json puts `openapi` after its
// components), so a cut body shaped like a description that meets every
// expectation but the marker still counts as present, its evidence marked
// truncated. Evidence from a host other than the audited origin is marked
// `off_origin`, so the antecedents that read this row as the site's own
// OpenAPI leave it out.

import type { ApiDescriptionTarget } from '../api-targets';
import type { ProbeResponse } from '../assert';
import { sameOrigin } from '../discovery-documents';
import type { WebCheck } from '../registry';
import { guardedFetch, OPENAPI_MAX_BODY_BYTES } from '../ssrf';
import { assessResponse, classifyMiss, type HttpWith, runHttp } from './http';
import { aggregateTargets, type TargetOutcome, timeoutMsFor } from './shared';
import type { EvidenceItem, HandlerContext, ProbeOutcome } from './types';

const READ_IN_PART_WHY = `description larger than ${OPENAPI_MAX_BODY_BYTES / 1024} KiB; read in part, presence counted`;
const DESCRIPTION_TYPE_RE = /json|yaml|vnd\.oai\.openapi/i;
const HTML_TYPE_RE = /html/i;
const MARKUP_START_RE = /^\s*</;
const JSON_OBJECT_START_RE = /^\s*\{/;
// Service descriptions that are not OpenAPI, named in their opening bytes.
const OTHER_FORMAT_RE = /^\s*asyncapi\s*:|"asyncapi"\s*:|"__schema"\s*:|"_postman_id"\s*:|^#%RAML/m;

/**
 * A JSON or YAML document by its content type, or a body that opens a JSON
 * object; never an HTML page or a description in another format.
 */
function descriptionShaped(response: ProbeResponse): boolean {
  const type = response.headers['content-type'] ?? '';
  if (HTML_TYPE_RE.test(type) || MARKUP_START_RE.test(response.body)) return false;
  if (OTHER_FORMAT_RE.test(response.body)) return false;
  return DESCRIPTION_TYPE_RE.test(type) || JSON_OBJECT_START_RE.test(response.body);
}

function assessDescription(url: string, response: ProbeResponse, w: HttpWith, base: string) {
  const whole = assessResponse(url, response, w, base);
  if (whole.ok || response.truncated !== true || !descriptionShaped(response)) return whole;
  const unmarked = assessResponse(url, response, { ...w, expect: { ...w.expect, body_regex: undefined } }, base);
  if (!unmarked.ok) return whole;
  return { ok: true, item: { ...unmarked.item, why: [...unmarked.item.why, READ_IN_PART_WHY] } };
}

async function describe(
  target: ApiDescriptionTarget,
  w: HttpWith,
  ctx: HandlerContext,
  timeoutMs: number,
): Promise<TargetOutcome> {
  if ('unmet' in target) {
    const { reason, host, url } = target.unmet;
    return {
      status: 'na',
      na_reason: reason,
      evidence: [{ host, description: target.url, why: [url], off_origin: true }],
    };
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
  const { ok, item } = assessDescription(read.url, read.response, w, ctx.base);
  const evidence: EvidenceItem[] = [
    { ...item, description: target.url, ...(sameOrigin(read.url, ctx.base) ? {} : { off_origin: true }) },
  ];
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
