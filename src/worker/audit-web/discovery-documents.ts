// Pure logic for the documents MCP discovery reads: parsing and shape
// classification for server cards of both generations, the AI catalog
// entries that name cards, and the API catalog; what a card declares; and
// the evidence row each read leaves. No I/O in this module.

import type { RetainedDocumentKey } from '../../shared/web-audit-documents';
import type { ProbeResponse } from './assert';
import { resolveUrl } from './handlers/shared';
import type { EvidenceItem } from './handlers/types';

export const MCP_SERVER_CARD_TYPE = 'application/mcp-server-card+json';

// Bounds the card reads one catalog can cause, whatever it lists.
const MAX_CATALOG_CARDS = 4;

// The extension schema's remote URL template variable: `{name}`.
const URL_TEMPLATE_VARIABLE = /\{[A-Za-z_][A-Za-z0-9_]*\}/;

export type JsonObject = Record<string, unknown>;

/** A card with `remotes[]` is SEP-2127; one with `transport`, `mcp_endpoint`, or `url` is SEP-1649. */
export type CardShape = 'sep-2127' | 'sep-1649' | 'unrecognized' | 'unparseable';

export type DocumentShape = CardShape | 'ai-catalog' | 'linkset';

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The body as a JSON object; a body cut at its byte cap never parses. */
export function parseJsonObject(resp: ProbeResponse): JsonObject | null {
  if (resp.truncated) return null;
  try {
    const parsed: unknown = JSON.parse(resp.body);
    return isJsonObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function cardShape(card: JsonObject | null): CardShape {
  if (card === null) return 'unparseable';
  if (Array.isArray(card.remotes)) return 'sep-2127';
  if ('transport' in card || 'mcp_endpoint' in card || 'url' in card) return 'sep-1649';
  return 'unrecognized';
}

export function aiCatalogShape(catalog: JsonObject | null): DocumentShape {
  if (catalog === null) return 'unparseable';
  return Array.isArray(catalog.entries) ? 'ai-catalog' : 'unrecognized';
}

export function apiCatalogShape(catalog: JsonObject | null): DocumentShape {
  if (catalog === null) return 'unparseable';
  return Array.isArray(catalog.linkset) ? 'linkset' : 'unrecognized';
}

/**
 * The endpoint a card declares, as written: a SEP-2127 card's first
 * `streamable-http` remote, else the first SEP-1649 endpoint field present.
 */
function cardEndpoint(card: JsonObject): string | null {
  if (Array.isArray(card.remotes)) {
    for (const remote of card.remotes) {
      if (isJsonObject(remote) && remote.type === 'streamable-http' && typeof remote.url === 'string') {
        return remote.url;
      }
    }
    return null;
  }
  const transport = isJsonObject(card.transport) ? card.transport : {};
  for (const value of [card.mcp_endpoint, card.url, transport.url, transport.endpoint]) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

/** A card declares authentication the way SEP-1649 cards spell it. */
export function cardHasAuthField(card: JsonObject): boolean {
  return card.authentication !== undefined || card.auth !== undefined;
}

/** A URL carrying a `{variable}` needs values the auditor does not have, so it is never requested. */
function isTemplatedUrl(url: string): boolean {
  return URL_TEMPLATE_VARIABLE.test(url);
}

export type CatalogCardEntry = { index: number; data: JsonObject } | { index: number; url: string } | { index: number };

/** The first MCP server-card entries of an AI catalog, inline `data` preferred over `url`. */
export function catalogCardEntries(catalog: JsonObject): CatalogCardEntry[] {
  const entries = Array.isArray(catalog.entries) ? catalog.entries : [];
  const out: CatalogCardEntry[] = [];
  for (const [index, entry] of entries.entries()) {
    if (out.length === MAX_CATALOG_CARDS) break;
    if (!isJsonObject(entry) || entry.type !== MCP_SERVER_CARD_TYPE) continue;
    if (isJsonObject(entry.data)) out.push({ index, data: entry.data });
    else if (typeof entry.url === 'string') out.push({ index, url: entry.url });
    else out.push({ index });
  }
  return out;
}

/** An MCP endpoint or a card document that a discovery document names. */
export interface McpDeclaration {
  kind: 'mcp-endpoint' | 'card-document';
  url: string;
  /** Where it was declared: a path on the audited origin, or an AI catalog entry as a JSON Pointer. */
  source: string;
  not_followed?: 'templated-url';
}

/** A document discovery read and keeps for later checks. */
export interface RetainedDocument {
  /** Where it was read; an inline catalog card is the catalog URL with a JSON Pointer fragment. */
  url: string;
  response: ProbeResponse;
  /** Server cards only. */
  shape?: CardShape;
}

/** A card discovery read, with the endpoint it declares. */
export interface CardRead {
  source: string;
  url: string;
  response: ProbeResponse;
  /** An AI catalog's inline card: read in place, with no request of its own. */
  inline: boolean;
  card: JsonObject | null;
  shape: CardShape | null;
  declaration: McpDeclaration | null;
  /** The declared endpoint when it is on the audited origin and not a template. */
  endpoint: string | null;
}

export function sameOrigin(candidate: string, base: string): boolean {
  try {
    return new URL(candidate).origin === new URL(base).origin;
  } catch {
    return false;
  }
}

export function readCard(
  source: string,
  url: string,
  response: ProbeResponse,
  inline: boolean,
  base: string,
): CardRead {
  const answered = inline || response.status === 200;
  const card = answered ? parseJsonObject(response) : null;
  const read: CardRead = {
    source,
    url,
    response,
    inline,
    card,
    shape: answered ? cardShape(card) : null,
    declaration: null,
    endpoint: null,
  };
  const declared = card === null ? null : cardEndpoint(card);
  if (declared === null) return read;
  if (isTemplatedUrl(declared)) {
    return { ...read, declaration: { kind: 'mcp-endpoint', url: declared, source, not_followed: 'templated-url' } };
  }
  const resolved = resolveUrl(base, declared);
  return {
    ...read,
    declaration: { kind: 'mcp-endpoint', url: resolved, source },
    endpoint: sameOrigin(resolved, base) ? resolved : null,
  };
}

/** The card that names an audited-origin endpoint, else the first that parses. */
export function preferredCard(reads: readonly CardRead[]): CardRead | null {
  return reads.find((r) => r.endpoint !== null) ?? reads.find((r) => r.card !== null) ?? null;
}

function responseFields(resp: ProbeResponse): EvidenceItem {
  return {
    status: resp.status,
    ...(resp.error !== null ? { error: resp.error } : {}),
    ...(resp.truncated ? { truncated: true } : {}),
  };
}

export function documentItem(
  source: string,
  key: RetainedDocumentKey,
  resp: ProbeResponse,
  shape: DocumentShape | null,
): EvidenceItem {
  return { source, document: key, ...responseFields(resp), ...(shape !== null ? { shape } : {}) };
}

export function cardItem(read: CardRead, isRecord: boolean, authentication: boolean): EvidenceItem {
  const item: EvidenceItem = { source: read.source };
  if (isRecord) item.document = 'server-card';
  if (!read.inline) Object.assign(item, responseFields(read.response));
  if (read.shape !== null) item.shape = read.shape;
  if (read.declaration !== null) {
    item.endpoint = read.declaration.url;
    if (authentication) item.authentication = true;
    if (read.declaration.not_followed !== undefined) item.not_followed = 'templated url';
    else if (read.endpoint === null) item.blocked = 'off-origin endpoint declaration';
  } else if (read.card !== null) {
    item.note = 'card present, no endpoint field';
  }
  return item;
}
