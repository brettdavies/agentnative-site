// MCP endpoint discovery on the audited origin, SEP-2127 first.
//
// Two phases. The document reads come first: one concurrent round of the
// SEP-1649 well-known cards, the AI catalog, and the API catalog, then the
// catalog's first MCP server-card entries: an inline card is read in place,
// a card URL on the audited origin is fetched, and a card URL anywhere else
// is returned as a declaration and never requested here. A card's endpoint
// on the audited origin, catalog cards first, is the endpoint. Without one,
// the endpoint probing that follows sends legacy `initialize` and modern
// `tools/list` POSTs to the common paths together under one timeout, and a
// legacy answer wins. The split lets the engine follow the declarations the
// documents name while the POSTs are in flight.
//
// A card's endpoint is attacker-controlled, so one off the audited origin,
// or one written as a URL template, is recorded as a declaration and never
// probed from discovery, the same way scoped-llms restricts llms.txt hrefs.
//
// The card of record is the first card that parses in SEP-2127 order: a
// catalog card, then the card at <endpoint> + card_suffix when it has a
// card's shape, then a SEP-1649 well-known card. It, the AI catalog, and
// the API catalog are kept for later checks, each read under
// DOCUMENT_MAX_BODY_BYTES. Every pass is bounded by both the per-audit
// deadline and the discovery budget, so the passes together cannot outrun
// the audit budget even against a target that never answers.

import type { RetainedDocumentKey } from '../../shared/web-audit-documents';
import { type ProbeResponse, parseJsonRpc } from './assert';
import {
  aiCatalogShape,
  apiCatalogShape,
  type CardRead,
  cardHasAuthField,
  cardItem,
  cardShape,
  cardSuffixUrl,
  catalogCardEntries,
  documentItem,
  MCP_SERVER_CARD_TYPE,
  type McpDeclaration,
  parseJsonObject,
  preferredCard,
  type RetainedDocument,
  readCard,
  sameOrigin,
} from './discovery-documents';
import { legacyInitializeBody, legacyProbeHeaders, modernProbeBody, modernProbeHeaders } from './handlers/mcp';
import { phaseBudget, resolveUrl } from './handlers/shared';
import type { EvidenceItem } from './handlers/types';
import type { WebAuditDiscoveryConfig } from './registry';
import { DOCUMENT_MAX_BODY_BYTES, type GuardedFetchInit, type GuardedFetchOptions, guardedFetch } from './ssrf';

export interface DiscoveryOptions {
  timeoutMs: number;
  fetchOptions?: Pick<GuardedFetchOptions, 'fetchImpl' | 'maxRedirects'>;
  /** Absolute per-audit deadline in ms; hops stop once it is spent. */
  deadlineAt?: number;
  /** Injectable clock, matching the engine's deterministic deadline tests. */
  now?: () => number;
}

export interface DiscoveryResult {
  endpoint: string | null;
  evidence: EvidenceItem[];
  /** In SEP-2127 order: the catalog's entries, the suffix card, then the well-known cards. */
  declarations: McpDeclaration[];
  documents: ReadonlyMap<RetainedDocumentKey, RetainedDocument>;
}

/** Discovery after its document reads, before any POST. */
export interface DiscoveryDocuments {
  /** What the documents declare so far, in SEP-2127 order; a suffix card read later can add more. */
  declarations: McpDeclaration[];
  /** An endpoint a card names on the audited origin, which no POST can displace. */
  cardEndpoint: string | null;
  /** The HTTP status of every document read; null where the request got no answer. */
  statuses: Array<number | null>;
  /** The common-path POSTs and the suffix-card read that finish discovery. */
  probeEndpoint(): Promise<DiscoveryResult>;
}

// Hard wall-clock cap on the whole discovery phase. Discovery is a
// prerequisite for the MCP checks, not the audit itself, so it must never
// starve the check waves: a target that tarpits unsolicited POSTs (drops
// them without responding until the socket times out) would otherwise eat
// one full per-check timeout per candidate path and spend the entire
// per-audit deadline before the first real check runs.
const DISCOVERY_BUDGET_MS = 12_000;

// RFC 9727 fixes the API catalog's location.
const API_CATALOG_PATH = '/.well-known/api-catalog';

// The extension's discovery flow asks for a card by its media type.
const CARD_REQUEST_HEADERS = { accept: MCP_SERVER_CARD_TYPE };

type FetchOptions = DiscoveryOptions['fetchOptions'];

type CatalogSlot =
  | { index: number; read: CardRead }
  | { index: number; declaration: McpDeclaration }
  | { index: number };

function pathOf(url: string): string {
  const u = new URL(url);
  return `${u.pathname}${u.search}`;
}

/** Legacy `initialize` and modern `tools/list` on every common path at once; a legacy answer wins. */
async function probeCommonPaths(
  candidates: ReadonlyArray<{ path: string; url: string }>,
  protocolVersion: string,
  timeoutMs: number,
  fetchOptions: FetchOptions,
): Promise<{ endpoint: string | null; items: EvidenceItem[] }> {
  const send = (init: GuardedFetchInit) =>
    Promise.all(candidates.map((c) => guardedFetch(c.url, init, { ...fetchOptions, timeoutMs })));
  const [legacy, modern] = await Promise.all([
    send({ method: 'POST', headers: legacyProbeHeaders(), body: legacyInitializeBody(protocolVersion) }),
    send({ method: 'POST', headers: modernProbeHeaders('tools/list'), body: modernProbeBody('tools/list') }),
  ]);
  const items: EvidenceItem[] = [];
  for (const [i, resp] of legacy.entries()) {
    const { path, url } = candidates[i];
    const rpc = parseJsonRpc(resp);
    const result = rpc?.result as { serverInfo?: unknown } | undefined;
    if (rpc && result && typeof result === 'object' && result.serverInfo) {
      items.push({ source: path, endpoint: url, probed: 'initialize' });
      return { endpoint: url, items };
    }
    items.push({ source: path, status: resp.status, probed: 'initialize (no serverInfo)' });
  }
  for (const [i, resp] of modern.entries()) {
    const { path, url } = candidates[i];
    const result = parseJsonRpc(resp)?.result as { tools?: unknown } | undefined;
    if (result && Array.isArray(result.tools)) {
      items.push({ source: path, endpoint: url, probed: 'modern-tools-list' });
      return { endpoint: url, items };
    }
    items.push({ source: path, status: resp.status, probed: 'modern-tools-list (no tools)' });
  }
  return { endpoint: null, items };
}

export async function discoverMcpEndpoint(
  base: string,
  cfg: WebAuditDiscoveryConfig,
  opts: DiscoveryOptions,
): Promise<DiscoveryResult> {
  return (await readDiscoveryDocuments(base, cfg, opts)).probeEndpoint();
}

export async function readDiscoveryDocuments(
  base: string,
  cfg: WebAuditDiscoveryConfig,
  opts: DiscoveryOptions,
): Promise<DiscoveryDocuments> {
  const budget = phaseBudget(DISCOVERY_BUDGET_MS, opts.timeoutMs, {
    deadlineAt: opts.deadlineAt,
    now: opts.now ?? Date.now,
  });
  const passBudget = budget.slice;
  const readDocument = (url: string, timeoutMs: number, headers?: Record<string, string>) =>
    guardedFetch(url, headers === undefined ? {} : { headers }, {
      ...opts.fetchOptions,
      timeoutMs,
      maxBodyBytes: DOCUMENT_MAX_BODY_BYTES,
    });

  let wellKnown: CardRead[] = [];
  const documentItems: EvidenceItem[] = [];
  const documentResponses: ProbeResponse[] = [];
  const catalogSlots: CatalogSlot[] = [];
  let postItems: EvidenceItem[] = [];
  let postEndpoint: string | null = null;
  let suffix: CardRead | null = null;
  let deadlineHit = false;
  const documents = new Map<RetainedDocumentKey, RetainedDocument>();

  const catalogReads = (): CardRead[] => catalogSlots.flatMap((slot) => ('read' in slot ? [slot.read] : []));
  const cardWinner = (): CardRead | null =>
    catalogReads().find((r) => r.endpoint !== null) ?? wellKnown.find((r) => r.endpoint !== null) ?? null;

  const finish = (): DiscoveryResult => {
    const endpoint = cardWinner()?.endpoint ?? postEndpoint;
    // The suffix URL is a guess the site never published, and an MCP
    // handler can answer it with any JSON object, a JSON-RPC error included.
    const suffixCard = suffix?.shape === 'sep-2127' || suffix?.shape === 'sep-1649' ? suffix : null;
    const record = preferredCard(catalogReads()) ?? suffixCard ?? preferredCard(wellKnown);
    if (record !== null) {
      documents.set('server-card', { url: record.url, response: record.response, shape: cardShape(record.card) });
    }
    // SEP-2127 cards carry no auth field, so the declaration comes from
    // whichever card of either generation names the discovered endpoint.
    const authCard =
      endpoint === null
        ? null
        : ([...catalogReads(), ...(suffix !== null ? [suffix] : []), ...wellKnown].find(
            (r) => r.endpoint === endpoint && r.card !== null && cardHasAuthField(r.card),
          ) ?? null);
    const item = (read: CardRead) => cardItem(read, read === record, read === authCard);
    const catalogItem = (slot: CatalogSlot): EvidenceItem => {
      if ('read' in slot) return item(slot.read);
      if ('declaration' in slot) {
        return {
          source: slot.declaration.source,
          card_url: slot.declaration.url,
          blocked: 'off-origin card declaration',
        };
      }
      return { source: `${cfg.ai_catalog}#/entries/${slot.index}`, note: 'catalog entry names no card url or data' };
    };
    const evidence: EvidenceItem[] = [
      ...wellKnown.map(item),
      ...documentItems,
      ...catalogSlots.map(catalogItem),
      ...postItems,
      ...(suffix !== null ? [item(suffix)] : []),
      ...(deadlineHit ? [{ note: 'per-audit deadline exceeded during discovery' }] : []),
    ];
    return { endpoint, evidence, declarations: declared(), documents };
  };
  const declared = (): McpDeclaration[] => {
    const ofRead = (read: CardRead) => [read.declaration, ...read.others];
    return [
      ...catalogSlots.flatMap((slot) =>
        'read' in slot ? ofRead(slot.read) : 'declaration' in slot ? [slot.declaration] : [],
      ),
      ...(suffix !== null ? ofRead(suffix) : []),
      ...wellKnown.flatMap(ofRead),
    ].filter((d): d is McpDeclaration => d !== null);
  };
  const exhausted = (): DiscoveryResult => {
    deadlineHit = true;
    return finish();
  };
  const documentsRead = (probeEndpoint: () => Promise<DiscoveryResult>): DiscoveryDocuments => ({
    declarations: declared(),
    cardEndpoint: cardWinner()?.endpoint ?? null,
    statuses: [
      ...wellKnown.map((read) => read.response.status),
      ...documentResponses.map((response) => response.status),
      ...catalogReads()
        .filter((read) => !read.inline)
        .map((read) => read.response.status),
    ],
    probeEndpoint,
  });
  const spent = () => documentsRead(async () => exhausted());

  // Document reads: the SEP-1649 cards, the AI catalog, the API catalog.
  const wellKnownTargets = cfg.well_known
    .map((path) => ({ path, url: resolveUrl(base, path) }))
    .filter((t) => t.url.length > 0);
  const catalogUrl = resolveUrl(base, cfg.ai_catalog);
  const apiCatalogUrl = resolveUrl(base, API_CATALOG_PATH);
  const documentPass = passBudget();
  if (documentPass === null) return spent();
  const [cardResponses, catalogResp, apiCatalogResp] = await Promise.all([
    Promise.all(wellKnownTargets.map((t) => readDocument(t.url, documentPass))),
    readDocument(catalogUrl, documentPass),
    readDocument(apiCatalogUrl, documentPass),
  ]);
  wellKnown = wellKnownTargets.map((t, i) => readCard(t.path, t.url, cardResponses[i], false, base));
  const catalog = catalogResp.status === 200 ? parseJsonObject(catalogResp) : null;
  documentResponses.push(catalogResp, apiCatalogResp);
  documents.set('ai-catalog', { url: catalogUrl, response: catalogResp });
  documents.set('api-catalog', { url: apiCatalogUrl, response: apiCatalogResp });
  documentItems.push(
    documentItem(
      cfg.ai_catalog,
      'ai-catalog',
      catalogResp,
      catalogResp.status === 200 ? aiCatalogShape(catalog) : null,
    ),
    documentItem(
      API_CATALOG_PATH,
      'api-catalog',
      apiCatalogResp,
      apiCatalogResp.status === 200 ? apiCatalogShape(parseJsonObject(apiCatalogResp)) : null,
    ),
  );

  // The catalog's card entries: inline in place, same-origin URLs fetched.
  const entries = (catalog === null ? [] : catalogCardEntries(catalog)).map((entry) => {
    const url = 'url' in entry ? resolveUrl(catalogUrl, entry.url) : '';
    return { entry, url: url === '' ? null : url };
  });
  const fetchesCard = entries.some(({ url }) => url !== null && sameOrigin(url, base));
  const cardPass = fetchesCard ? passBudget() : 0;
  if (cardPass === null) return spent();
  const catalogSlot = async ({ entry, url }: (typeof entries)[number]): Promise<CatalogSlot> => {
    const pointer = `#/entries/${entry.index}`;
    if ('data' in entry) {
      const response = { ...catalogResp, body: JSON.stringify(entry.data) };
      const read = readCard(`${cfg.ai_catalog}${pointer}/data`, `${catalogUrl}${pointer}/data`, response, true, base);
      return { index: entry.index, read };
    }
    if (url === null) return { index: entry.index };
    if (!sameOrigin(url, base)) {
      return { index: entry.index, declaration: { kind: 'card-document', url, source: `${cfg.ai_catalog}${pointer}` } };
    }
    const response = await readDocument(url, cardPass, CARD_REQUEST_HEADERS);
    return { index: entry.index, read: readCard(pathOf(url), url, response, false, base) };
  };
  catalogSlots.push(...(await Promise.all(entries.map(catalogSlot))));

  return documentsRead(async () => {
    // POST probing, only when no card named an endpoint on the audited origin.
    const candidates = cfg.common_paths
      .map((path) => ({ path, url: resolveUrl(base, path) }))
      .filter((c) => c.url.length > 0);
    if (cardWinner() === null && candidates.length > 0) {
      const postPass = passBudget();
      if (postPass === null) return exhausted();
      const probed = await probeCommonPaths(candidates, cfg.protocol_version, postPass, opts.fetchOptions);
      postItems = probed.items;
      postEndpoint = probed.endpoint;
    }

    // With no catalog card, the endpoint's own card outranks a SEP-1649 card.
    const endpoint = cardWinner()?.endpoint ?? postEndpoint;
    if (endpoint !== null && preferredCard(catalogReads()) === null) {
      const suffixPass = passBudget();
      if (suffixPass === null) return exhausted();
      const url = cardSuffixUrl(endpoint, cfg.card_suffix);
      suffix = readCard(pathOf(url), url, await readDocument(url, suffixPass, CARD_REQUEST_HEADERS), false, base);
    }
    return finish();
  });
}
