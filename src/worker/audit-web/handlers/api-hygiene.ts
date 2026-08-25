// API hygiene probes: JSON error bodies and rate-limit headers. Derives one
// non-mutating GET URL from the retained wave-1 OpenAPI body (documented 4xx
// example, else first safe GET) and falls back to a well-known nonsense path
// when the body is missing or unusable. Same-origin only; SSRF-guarded.

import type { ProbeResponse } from '../assert';
import type { WebCheck } from '../registry';
import { AUDIT_PROBE_MAX_BODY_BYTES, guardedFetch, STATUS_ONLY_BODY_BYTES, validatePublicUrl } from '../ssrf';
import { timeoutMsFor } from './shared';
import type { HandlerContext, ProbeOutcome } from './types';

export const API_HYGIENE_FALLBACK_PATH = '/anc-web-audit-no-such-api';
const PATH_PARAM_RE = /\{[^}]+\}/g;
const SAFE_METHODS = new Set(['get', 'head']);
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

type OpenApiOp = {
  path: string;
  responses: string[];
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function fillPath(path: string): string {
  return path.replace(PATH_PARAM_RE, 'anc-web-audit-no-such');
}

function operationsFrom(spec: Record<string, unknown>): OpenApiOp[] {
  const paths = asRecord(spec.paths);
  if (!paths) return [];
  const out: OpenApiOp[] = [];
  for (const [path, item] of Object.entries(paths)) {
    const rec = asRecord(item);
    if (!rec || !path.startsWith('/')) continue;
    for (const [method, op] of Object.entries(rec)) {
      if (!SAFE_METHODS.has(method.toLowerCase())) continue;
      const opRec = asRecord(op);
      const responses = asRecord(opRec?.responses);
      out.push({ path, responses: responses ? Object.keys(responses) : [] });
    }
  }
  return out;
}

function hasClientErrorResponse(responses: string[]): boolean {
  return responses.some((code) => /^(4\d\d|4XX)$/i.test(code));
}

function resolveSameOrigin(base: string, path: string): string {
  return new URL(fillPath(path), base).toString();
}

/** Pure: pick the single GET URL both hygiene checks share. */
export function deriveApiProbeUrl(openapiBody: string, base: string): { url: string; source: string } {
  const fallback = resolveSameOrigin(base, API_HYGIENE_FALLBACK_PATH);
  if (openapiBody.length === 0) return { url: fallback, source: 'fallback' };
  let spec: unknown;
  try {
    spec = JSON.parse(openapiBody);
  } catch {
    return { url: fallback, source: 'fallback' };
  }
  const rec = asRecord(spec);
  if (!rec) return { url: fallback, source: 'fallback' };
  const ops = operationsFrom(rec);
  const documented4xx = ops.find((op) => hasClientErrorResponse(op.responses));
  const chosen = documented4xx ?? ops[0];
  if (!chosen) return { url: fallback, source: 'fallback' };
  const url = resolveSameOrigin(base, chosen.path);
  const validation = validatePublicUrl(url);
  if (!validation.ok) return { url: fallback, source: 'fallback' };
  try {
    if (new URL(url).origin !== new URL(base).origin) return { url: fallback, source: 'fallback' };
  } catch {
    return { url: fallback, source: 'fallback' };
  }
  return { url, source: documented4xx ? 'openapi-4xx' : 'openapi-get' };
}

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

export async function runApiHygiene(check: WebCheck, ctx: HandlerContext): Promise<ProbeOutcome> {
  const w = check.with as { op?: HygieneOp; timeout?: number };
  const op = w.op ?? 'json-errors';
  const timeoutMs = timeoutMsFor(w.timeout, ctx.defaultTimeoutMs);
  const derived = deriveApiProbeUrl(ctx.retainedBodies?.get('openapi') ?? '', ctx.base);
  const validation = validatePublicUrl(derived.url);
  if (!validation.ok) {
    return { status: 'error', evidence: [{ url: derived.url, blocked: validation.reason, source: derived.source }] };
  }

  const resp = await guardedFetch(
    derived.url,
    { method: 'GET' },
    {
      ...ctx.fetchOptions,
      timeoutMs,
      maxBodyBytes: op === 'rate-limit' ? STATUS_ONLY_BODY_BYTES : AUDIT_PROBE_MAX_BODY_BYTES,
    },
  );
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
