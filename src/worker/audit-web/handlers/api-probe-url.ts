// The URL the API hygiene probes request on one host: derived from an
// OpenAPI description (a documented 4xx GET, else the first safe GET) when
// one parses as JSON, else a well-known nonsense path. Either path is
// appended to a base path, as OpenAPI appends a path to its server URL: on
// an API anchor host, the description's first server when that is on the
// anchor's origin, else the anchor's own path. Pure; no I/O.

import type { ApiHostTarget } from '../api-targets';
import { isTemplatedUrl } from '../discovery-documents';
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

/** `path` under `base`'s path; a path that names another authority leaves the origin, which the caller refuses. */
function underBase(base: string, path: string): string {
  const prefix = new URL(base).pathname.replace(/\/+$/, '');
  return new URL(`${prefix}${fillPath(path)}`, base).toString();
}

function parseSpec(openapiBody: string): Record<string, unknown> | null {
  if (openapiBody.length === 0) return null;
  try {
    return asRecord(JSON.parse(openapiBody));
  } catch {
    return null;
  }
}

function probeUnder(spec: Record<string, unknown> | null, base: string): ProbeUrl {
  const fallback: ProbeUrl = { url: underBase(base, API_HYGIENE_FALLBACK_PATH), source: 'fallback' };
  if (spec === null) return fallback;
  const ops = operationsFrom(spec);
  const documented4xx = ops.find((op) => hasClientErrorResponse(op.responses));
  const chosen = documented4xx ?? ops[0];
  if (!chosen) return fallback;
  const url = underBase(base, chosen.path);
  const validation = validatePublicUrl(url);
  if (!validation.ok) return fallback;
  try {
    if (new URL(url).origin !== new URL(base).origin) return fallback;
  } catch {
    return fallback;
  }
  return { url, source: documented4xx ? 'openapi-4xx' : 'openapi-get' };
}

/** Pure: pick the single GET URL both hygiene checks share. */
export function deriveApiProbeUrl(openapiBody: string, base: string): ProbeUrl {
  return probeUnder(parseSpec(openapiBody), base);
}

/** The description's first server URL, resolved against where it is served, when it is a plain URL on `origin`. */
function serverBase(spec: Record<string, unknown> | null, description: string, origin: string): string | null {
  const servers = spec?.servers;
  const url = Array.isArray(servers) ? asRecord(servers[0])?.url : undefined;
  if (typeof url !== 'string' || isTemplatedUrl(url)) return null;
  try {
    const resolved = new URL(url, description);
    return resolved.origin === origin ? resolved.toString() : null;
  } catch {
    return null;
  }
}

/** The first probe URL an anchor's description on the host yields, else the nonsense path under the first anchor's base. */
export function deriveHostProbeUrl(target: ApiHostTarget, bodies: ReadonlyMap<string, string>): ProbeUrl {
  let fallback: ProbeUrl | null = null;
  for (const anchor of target.anchors) {
    const spec = parseSpec(bodies.get(anchor.description) ?? '');
    const anchorBase = isTemplatedUrl(anchor.url) ? `${target.origin}/` : anchor.url;
    const derived = probeUnder(spec, serverBase(spec, anchor.description, target.origin) ?? anchorBase);
    if (derived.source !== 'fallback') return derived;
    fallback ??= derived;
  }
  return fallback ?? deriveApiProbeUrl('', `${target.origin}/`);
}
