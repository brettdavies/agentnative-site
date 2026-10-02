// Where the API rows evaluate when the API catalog lists API anchors: the
// OpenAPI row at each anchor's description, and the hygiene rows at each
// anchor host, in declaration order. A target off the audited origin is
// evaluated only when the follow slice settled it followed; otherwise it
// carries the reason its rows read, or is left out when the trail names
// none (a templated URL, a path in the auditor's own zone). A target
// declared only over plaintext is left out beside any other target, and
// stands alone as a miss when there is none, so declaring an API over http
// never scores above declaring nothing.

import { type CatalogAnchor, isApiAnchor } from './api-catalog';
import { sameOrigin } from './discovery-documents';
import { type DeclaredHostReason, declaredHostReason } from './endpoint-of-record';
import type { ApiFollowResult } from './follow-api';
import type { Fetched } from './follow-requests';
import { declarationKey, type TrailEntry } from './follow-trail';
import type { PlaintextReason } from './handlers/shared';

/**
 * An OpenAPI description the catalog declares, by its declared URL: one
 * the follow slice read off the audited origin, one on the audited origin
 * that the row reads itself, or one not evaluated and why.
 */
export type ApiDescriptionTarget = { url: string } & (
  | { fetched: Fetched }
  | { onOrigin: true }
  | { unmet: DeclaredHostReason }
  | { plaintext: PlaintextReason }
);

/** One API anchor host, where the hygiene probes go. */
export interface ApiHostTarget {
  origin: string;
  /** The anchors on this host and the description each declares, in declaration order. */
  anchors: Array<{ url: string; description: string }>;
  /** The host is off the audited origin, so a probe of it takes no redirect to another origin. */
  declared: boolean;
  /** Why the host was not evaluated. */
  unmet?: DeclaredHostReason;
  /** The host is declared only over plaintext, so nothing was requested from it. */
  plaintext?: PlaintextReason;
}

export interface ApiTargets {
  descriptions: ApiDescriptionTarget[];
  hosts: ApiHostTarget[];
}

/**
 * How a target is evaluated: on the audited origin, at a declared host the
 * slice followed, left out with no reason the trail names, not requested
 * over plaintext, or not evaluated for a reason.
 */
type Reach = 'audited-origin' | 'evaluate' | 'omit' | PlaintextReason | DeclaredHostReason;

function isPlaintext(reach: Reach): reach is PlaintextReason {
  return reach === 'not https' || reach === 'redirects to http';
}

function plaintextReason(entry: TrailEntry): PlaintextReason | null {
  if (entry.outcome !== 'not-followed' || entry.reason !== 'insecure-scheme') return null;
  return entry.final_url === undefined ? 'not https' : 'redirects to http';
}

/** Plaintext targets only when there is nothing else to evaluate. */
function plaintextAlone<T>(targets: T[], plaintext: (target: T) => boolean): T[] {
  return targets.every(plaintext) ? targets : targets.filter((target) => !plaintext(target));
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function descriptionTarget(url: string, reached: Reach, fetched: Fetched | undefined): ApiDescriptionTarget | null {
  if (reached === 'omit') return null;
  if (reached === 'audited-origin') return { url, onOrigin: true };
  if (reached === 'evaluate') return fetched !== undefined ? { url, fetched } : null;
  if (isPlaintext(reached)) return { url, plaintext: reached };
  return { url, unmet: reached };
}

/** The API rows' targets, or null when the catalog lists no API anchor and the rows evaluate the audited origin. */
export function apiTargets(
  base: string,
  anchors: readonly CatalogAnchor[],
  follow: ApiFollowResult,
): ApiTargets | null {
  const api = anchors.filter(isApiAnchor);
  if (api.length === 0) return null;
  const settled = new Map(follow.entries.map((entry) => [declarationKey(entry), entry]));
  const reach = (kind: 'api-anchor' | 'api-description', url: string): Reach => {
    if (sameOrigin(url, base)) return 'audited-origin';
    const entry = settled.get(declarationKey({ kind, url }));
    if (entry === undefined) return 'omit';
    if (entry.outcome === 'followed') return 'evaluate';
    return plaintextReason(entry) ?? declaredHostReason(entry) ?? 'omit';
  };

  const descriptions = new Map<string, ApiDescriptionTarget>();
  const origins = new Map<string, { declared: boolean; reaches: Reach[]; anchors: ApiHostTarget['anchors'] }>();
  for (const anchor of api) {
    const declared = anchor.description.url;
    const key = declarationKey({ kind: 'api-description', url: declared });
    if (!descriptions.has(key)) {
      const target = descriptionTarget(declared, reach('api-description', declared), follow.descriptions.get(key));
      if (target !== null) descriptions.set(key, target);
    }
    const origin = originOf(anchor.url);
    if (origin === null) continue;
    const group = origins.get(origin) ?? { declared: !sameOrigin(anchor.url, base), reaches: [], anchors: [] };
    group.reaches.push(reach('api-anchor', anchor.url));
    group.anchors.push({ url: anchor.url, description: declared });
    origins.set(origin, group);
  }

  const hosts = [...origins].flatMap(([origin, group]): ApiHostTarget[] => {
    const target = { origin, anchors: group.anchors, declared: group.declared };
    if (group.reaches.some((r) => r === 'evaluate' || r === 'audited-origin')) return [target];
    const unmet = group.reaches.find((r): r is DeclaredHostReason => typeof r === 'object');
    if (unmet !== undefined) return [{ ...target, unmet }];
    const plaintext = group.reaches.find(isPlaintext);
    return plaintext === undefined ? [] : [{ ...target, plaintext }];
  });
  return {
    descriptions: plaintextAlone([...descriptions.values()], (target) => 'plaintext' in target),
    hosts: plaintextAlone(hosts, (target) => target.plaintext !== undefined),
  };
}
