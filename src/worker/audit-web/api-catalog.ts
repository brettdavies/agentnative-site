// The RFC 9727 API catalog as the API category reads it: which linkset
// anchors are API hosts, and which description each declares.
//
// An anchor is an API host when one of its `service-desc` targets is a
// description other than an MCP surface: an MCP-first site points
// service-desc at its server card, which describes no REST API.

import { isJsonObject, isTemplatedUrl, parseJsonObject, type RetainedDocument } from './discovery-documents';
import { resolveUrl } from './handlers/shared';

// RFC 9727 fixes the API catalog's location.
export const API_CATALOG_PATH = '/.well-known/api-catalog';

/** A link target that is an MCP surface (a card, the endpoint, its usage doc) rather than an API description. */
export const MCP_TARGET_RE = /\.well-known\/mcp|server-card|mcp-skill|\/mcp\b/i;

// Bounds the declarations one catalog can add to the trail, whatever it lists.
const MAX_CATALOG_ANCHORS = 8;

/** A URL the catalog declares, with the JSON Pointer into the catalog where it does. */
export interface CatalogLink {
  url: string;
  source: string;
}

export interface CatalogAnchor extends CatalogLink {
  /** The anchor's first `service-desc` target that is not an MCP surface; absent when it has none. */
  description?: CatalogLink;
}

/** An anchor the API category evaluates. */
export type ApiAnchor = CatalogAnchor & { description: CatalogLink };

export function isApiAnchor(anchor: CatalogAnchor): anchor is ApiAnchor {
  return anchor.description !== undefined;
}

function catalogUrl(raw: unknown, base: string): string {
  if (typeof raw !== 'string' || raw.length === 0) return '';
  return isTemplatedUrl(raw) ? raw : resolveUrl(base, raw);
}

function apiDescription(links: unknown, base: string, pointer: string): CatalogLink | undefined {
  if (!Array.isArray(links)) return undefined;
  for (const [index, link] of links.entries()) {
    if (!isJsonObject(link) || typeof link.href !== 'string' || MCP_TARGET_RE.test(link.href)) continue;
    const url = catalogUrl(link.href, base);
    if (url !== '') return { url, source: `${pointer}/service-desc/${index}` };
  }
  return undefined;
}

/** The anchors a retained API catalog lists, in linkset order; none unless it answered 200 with a linkset. */
export function catalogAnchors(catalog: RetainedDocument | undefined): CatalogAnchor[] {
  if (catalog === undefined || catalog.response.status !== 200) return [];
  const linkset = parseJsonObject(catalog.response)?.linkset;
  if (!Array.isArray(linkset)) return [];
  const anchors: CatalogAnchor[] = [];
  for (const [index, context] of linkset.slice(0, MAX_CATALOG_ANCHORS).entries()) {
    if (!isJsonObject(context)) continue;
    const url = catalogUrl(context.anchor, catalog.url);
    if (url === '') continue;
    const pointer = `${API_CATALOG_PATH}#/linkset/${index}`;
    const description = apiDescription(context['service-desc'], catalog.url, pointer);
    anchors.push({ url, source: pointer, ...(description !== undefined ? { description } : {}) });
  }
  return anchors;
}
