// The URL the API hygiene probes request on one host: derived from an
// OpenAPI description (a documented 4xx GET, else the first safe GET) when
// one parses as JSON, else a well-known nonsense path. Pure; no I/O.

import type { ApiHostTarget } from '../api-targets';
import { validatePublicUrl } from '../ssrf';

export const API_HYGIENE_FALLBACK_PATH = '/anc-web-audit-no-such-api';
const PATH_PARAM_RE = /\{[^}]+\}/g;
const SAFE_METHODS = new Set(['get', 'head']);

export type ProbeUrl = { url: string; source: string };

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
export function deriveApiProbeUrl(openapiBody: string, base: string): ProbeUrl {
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

/** The first probe URL a description on the host yields, else the host's nonsense path. */
export function deriveHostProbeUrl(target: ApiHostTarget, bodies: ReadonlyMap<string, string>): ProbeUrl {
  const base = `${target.origin}/`;
  for (const description of target.descriptions) {
    const derived = deriveApiProbeUrl(bodies.get(description) ?? '', base);
    if (derived.source !== 'fallback') return derived;
  }
  return deriveApiProbeUrl('', base);
}
