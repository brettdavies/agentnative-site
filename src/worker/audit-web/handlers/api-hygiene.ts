// API hygiene probes: JSON error bodies and rate-limit headers, at the URL
// api-probe-url.ts derives on a host. With no API anchor in the API
// catalog, the one host is the audited origin and each row sends its own
// GET. With anchors, each anchor host receives one GET, which both rows
// read, and each row aggregates its hosts, so when every anchor is off the
// audited origin no probe reaches it. A GET to an anchor host off the
// audited origin takes no redirect to another origin, since nothing
// admitted that origin. SSRF-guarded.

import type { ApiHostTarget } from '../api-targets';
import type { ProbeResponse } from '../assert';
import type { WebCheck } from '../registry';
import {
  AUDIT_PROBE_MAX_BODY_BYTES,
  type GuardedFetchOptions,
  guardedFetch,
  STATUS_ONLY_BODY_BYTES,
  validatePublicUrl,
} from '../ssrf';
import { deriveApiProbeUrl, deriveHostProbeUrl, type ProbeUrl } from './api-probe-url';
import { aggregateTargets, plaintextItem, type TargetOutcome, timeoutMsFor } from './shared';
import type { HandlerContext, ProbeOutcome } from './types';

const CLIENT_ERROR = (status: number) => status >= 400 && status < 500;
const RATE_LIMIT_HEADERS = [
  'ratelimit-limit',
  'ratelimit-remaining',
  'ratelimit-reset',
  'ratelimit-policy',
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'x-ratelimit-reset',
  'retry-after',
];

type HygieneOp = 'json-errors' | 'rate-limit';

function isHtml(resp: ProbeResponse): boolean {
  const ct = resp.headers['content-type'] ?? '';
  if (/html/i.test(ct)) return true;
  return /^\s*<(!doctype|html|head|body)\b/i.test(resp.body ?? '');
}

function isJsonBody(resp: ProbeResponse): boolean {
  if (isHtml(resp)) return false;
  try {
    const value = JSON.parse(resp.body ?? '');
    return value !== null && typeof value === 'object';
  } catch {
    return false;
  }
}

function rateLimitHeader(resp: ProbeResponse): string | null {
  for (const name of RATE_LIMIT_HEADERS) {
    if (name in resp.headers && resp.headers[name] !== undefined) return name;
  }
  return null;
}

type HostGet = (url: string) => Promise<ProbeResponse>;

async function probeOnce(op: HygieneOp, derived: ProbeUrl, get: HostGet): Promise<ProbeOutcome> {
  const validation = validatePublicUrl(derived.url);
  if (!validation.ok) {
    return { status: 'error', evidence: [{ url: derived.url, blocked: validation.reason, source: derived.source }] };
  }

  const resp = await get(derived.url);
  if (resp.error !== null || resp.status === null) {
    return {
      status: 'error',
      evidence: [{ url: derived.url, status: resp.status, error: resp.error, source: derived.source }],
    };
  }

  if (op === 'rate-limit') {
    const header = rateLimitHeader(resp);
    return {
      status: header ? 'pass' : 'absent',
      evidence: [
        {
          url: derived.url,
          status: resp.status,
          ok: header !== null,
          source: derived.source,
          why: [header ? `rate-limit header ${header}` : 'no rate-limit header'],
        },
      ],
    };
  }

  if (CLIENT_ERROR(resp.status) && isJsonBody(resp)) {
    return {
      status: 'pass',
      evidence: [
        {
          url: derived.url,
          status: resp.status,
          ok: true,
          source: derived.source,
          why: ['client-error JSON body'],
        },
      ],
    };
  }

  const html = isHtml(resp);
  const why = [
    `status ${resp.status}`,
    html ? 'HTML error body' : isJsonBody(resp) ? 'JSON body but not a client error' : 'non-JSON error body',
  ];
  const status = resp.status >= 500 || html || CLIENT_ERROR(resp.status) ? 'broken' : 'absent';
  return { status, evidence: [{ url: derived.url, status: resp.status, ok: false, source: derived.source, why }] };
}

/** The anchor host's one GET, shared by both rows: the first row to ask sends it. */
function anchorHostGet(target: ApiHostTarget, timeoutMs: number, ctx: HandlerContext): HostGet {
  const redirects: Pick<GuardedFetchOptions, 'crossOriginRedirects'> = target.declared
    ? { crossOriginRedirects: 'return' }
    : {};
  const send = (url: string) =>
    guardedFetch(
      url,
      { method: 'GET' },
      { ...ctx.fetchOptions, ...redirects, timeoutMs, maxBodyBytes: AUDIT_PROBE_MAX_BODY_BYTES },
    );
  return (url) => {
    const sent = ctx.apiHostProbes;
    if (sent === undefined) return send(url);
    let response = sent.get(url);
    if (response === undefined) {
      response = send(url);
      sent.set(url, response);
    }
    return response;
  };
}

async function probeHost(
  op: HygieneOp,
  target: ApiHostTarget,
  timeoutMs: number,
  ctx: HandlerContext,
): Promise<TargetOutcome> {
  if (target.unmet !== undefined) {
    const { reason, host, url } = target.unmet;
    return { status: 'na', na_reason: reason, evidence: [{ host, why: [url] }] };
  }
  if (target.plaintext !== undefined) {
    return { status: 'absent', evidence: [{ url: target.anchors[0]?.url, ...plaintextItem(target.plaintext) }] };
  }
  const derived = deriveHostProbeUrl(target, ctx.apiDescriptionBodies ?? new Map());
  return probeOnce(op, derived, anchorHostGet(target, timeoutMs, ctx));
}

export async function runApiHygiene(check: WebCheck, ctx: HandlerContext): Promise<ProbeOutcome> {
  const w = check.with as { op?: HygieneOp; timeout?: number };
  const op = w.op ?? 'json-errors';
  const timeoutMs = timeoutMsFor(w.timeout, ctx.defaultTimeoutMs);
  const targets = ctx.apiTargets;
  if (targets === undefined || targets === null) {
    const maxBodyBytes = op === 'rate-limit' ? STATUS_ONLY_BODY_BYTES : AUDIT_PROBE_MAX_BODY_BYTES;
    const get: HostGet = (url) =>
      guardedFetch(url, { method: 'GET' }, { ...ctx.fetchOptions, timeoutMs, maxBodyBytes });
    return probeOnce(op, deriveApiProbeUrl(ctx.retainedBodies?.get('openapi') ?? '', ctx.base), get);
  }
  if (targets.hosts.length === 0) {
    return { status: 'na', evidence: [{ why: ['no API anchor host the audit can probe'] }] };
  }
  return aggregateTargets(await Promise.all(targets.hosts.map((target) => probeHost(op, target, timeoutMs, ctx))));
}
