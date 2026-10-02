// The API catalog's declarations in the follow slice. An anchor host is
// admitted to the slice (a host slot and its domain's reservation), which
// is what lets wave 2 send it the hygiene probes; it gets no request here.
// What reaches it later is one GET, at a path a description declared for
// it documents, else a nonsense path (handlers/api-probe-url.ts). Since
// the audited site names the host and, through the description, the path,
// that GET has the reach a card-document GET already has: one bodiless
// request through the SSRF guard that takes no redirect to another
// origin, bounded by the host slot and the domain's hourly reservation.
// Reciprocity gates wire probes, which act on an MCP server rather than
// read it, so an anchor host is not asked to name itself first. A
// service-desc target is read once through the same gate as a card
// document and kept for the OpenAPI row to score. A description host that
// gives no response at all records unreachable; any answer records
// followed, and the row scores what came back.

import type { ApiDeclaration } from './api-catalog';
import {
  budgetExceeded,
  type Fetched,
  type ReadOptions,
  readDeclaredDocuments,
  type SliceRequests,
  stopped,
} from './follow-requests';
import { declarationKey, type Settled, type TrailEntry, trailEntry } from './follow-trail';
import { isEdgeErrorStatus, OPENAPI_MAX_BODY_BYTES } from './ssrf';

const DESCRIPTION_TIMEOUT_MS = 3_000;

const DESCRIPTION_READ: ReadOptions = { maxBodyBytes: OPENAPI_MAX_BODY_BYTES, timeoutCapMs: DESCRIPTION_TIMEOUT_MS };

export interface ApiFollowResult {
  /** Trail entries in declaration order: the anchors, then the descriptions. */
  entries: TrailEntry[];
  /** The descriptions the slice read, by declaration key. */
  descriptions: ReadonlyMap<string, Fetched>;
}

export const NO_API_FOLLOW: ApiFollowResult = { entries: [], descriptions: new Map() };

const ADMITTED: Settled = { outcome: 'followed' };

function described(fetched: Fetched | Settled, declared: string): Settled {
  if (!('response' in fetched)) return fetched;
  const finalUrl = fetched.url === declared ? undefined : fetched.url;
  const silent = fetched.response.status === null || isEdgeErrorStatus(fetched.response.status);
  return { final_url: finalUrl, outcome: silent ? 'unreachable' : 'followed' };
}

/** Admits the anchor hosts in declaration order, then reads the descriptions side by side. */
export async function settleApiDeclarations(
  requests: SliceRequests,
  declarations: readonly ApiDeclaration[],
  upfront: (declaration: ApiDeclaration) => Settled | null,
): Promise<ApiFollowResult> {
  const entries: TrailEntry[] = [];
  for (const anchor of declarations.filter((d) => d.kind === 'api-anchor')) {
    const settled =
      upfront(anchor) ??
      (await stopped(async () => {
        await requests.enter(anchor.url);
        return ADMITTED;
      }, budgetExceeded));
    entries.push(trailEntry(anchor, settled));
  }
  const wanted = declarations.filter((d) => d.kind === 'api-description');
  const read = await readDeclaredDocuments(requests, wanted, upfront, DESCRIPTION_READ);
  const descriptions = new Map<string, Fetched>();
  for (const [i, declaration] of wanted.entries()) {
    const fetched = read[i];
    const settled = described(fetched, declaration.url);
    if ('response' in fetched && settled.outcome === 'followed') descriptions.set(declarationKey(declaration), fetched);
    entries.push(trailEntry(declaration, settled));
  }
  return { entries, descriptions };
}
