// API antecedents: whether the site exposes a REST/HTTP API surface, and
// whether it references JSON Schemas.

import type { AntecedentToken } from '../registry';
import {
  type AntecedentContext,
  type AntecedentResolver,
  anyEvidenceStatus,
  retainedBody,
  sourceEvidence,
  sourcePassed,
} from './context';

const SCHEMAS_RE = /application\/schema\+json|json-?schema|\/schema\.json/i;

// A link to an actual OpenAPI/Swagger *document* (a .json/.yaml/.yml
// descriptor), as opposed to a page whose URL merely contains the word
// (e.g. a documentation page like /web-audit/skill/openapi). Scans the
// retained llms.txt and sitemap.xml bodies; a bare-word match would flag
// every doc page whose path contains "openapi". The openapi probe covers
// the standard paths; this catches a descriptor served at a non-standard
// path that either index advertises.
const API_DOC_URL_RE = /\b(?:openapi|swagger)[\w./-]*\.(?:json|ya?ml)\b/i;

// A curated /api/ link in llms.txt. llms.txt is hand-authored, so an /api/
// path there is an intentional pointer at an API surface (unlike a
// generated sitemap, which is not scanned for it).
const API_PATH_RE = /\/api\//i;

// service-desc / service-doc (RFC 8631) advertise a machine-readable service
// description. A REST site points them at an OpenAPI/Swagger doc; an MCP-first
// site points them at its MCP server card or usage doc, which is not a REST
// surface. So the rel signals an API surface only when its target is not an
// MCP surface. Matching a bare "openapi"/"swagger" word in the page body is
// deliberately not a signal: a site that only names OpenAPI in prose (e.g. as
// a standard it documents) has no REST API of its own, and a live OpenAPI doc
// is caught by the openapi probe.
const SERVICE_DESC_REL_RE = /rel\s*=\s*["']?(?:service-desc|service-doc)\b/i;
const MCP_TARGET_RE = /\.well-known\/mcp|server-card|mcp-skill|\/mcp\b/i;

/** A service-desc/doc link (Link header or <link> tag) to a non-MCP target. */
function restServiceDescLink(ctx: AntecedentContext): boolean {
  const root = ctx.root;
  if (root === null) return false;
  const entries = [...(root.headers.link ?? '').split(','), ...(root.body.match(/<link\b[^>]*>/gi) ?? [])];
  return entries.some((entry) => SERVICE_DESC_REL_RE.test(entry) && !MCP_TARGET_RE.test(entry));
}

/** Any one signal makes the api-surface antecedent hold. */
function apiSurfaceHolds(ctx: AntecedentContext): boolean {
  if (ctx.siteType === 'api') return true;
  if (anyEvidenceStatus(sourceEvidence(ctx, 'openapi'), 200)) return true;
  if (restServiceDescLink(ctx)) return true;
  const llms = retainedBody(ctx, 'llms-txt');
  if (API_DOC_URL_RE.test(llms) || API_PATH_RE.test(llms)) return true;
  if (API_DOC_URL_RE.test(retainedBody(ctx, 'sitemap'))) return true;
  return false;
}

const apiSurface: AntecedentResolver = (ctx) => (apiSurfaceHolds(ctx) ? 'apply' : 'n_a');

const schemasRef: AntecedentResolver = (ctx) => {
  if (sourcePassed(ctx, 'openapi')) return 'apply';
  const root = ctx.root;
  if (root && SCHEMAS_RE.test(root.body)) return 'apply';
  return 'n_a';
};

export const apiResolvers = {
  'api-surface': apiSurface,
  'schemas-ref': schemasRef,
} satisfies Partial<Record<AntecedentToken, AntecedentResolver>>;

export const apiEvidence = {
  'api-surface': 'no API surface detected',
  'schemas-ref': 'no JSON Schema references detected',
} satisfies Partial<Record<AntecedentToken, string>>;
