// The declared-hosts trail as a reader sees it: one entry per declared URL
// with human surface and outcome labels, or one line when there is no list
// to show. The scorecard JSON and the MCP reads keep the machine values;
// only the page and its twin read this.

import { hostOf } from '../../shared/url-host';
import { cardSuffixUrl } from './discovery-documents';
import { resolveUrl } from './handlers/shared';
import type { DeclaredHostEntry, FollowState } from './provenance';
import {
  admittedByWhy,
  budgetOutcome,
  confirmGuidance,
  DECLARED_HOSTS_LINES,
  type DeclaredHostsState,
  declaredHostsLede,
  notConfirmedOutcome,
  notFollowedOutcome,
  OPENAPI_FOUND,
  OUTCOME_WORDS,
  redirectSurface,
  SURFACE_LABELS,
} from './provenance-copy';
import { normalizeEndpointUrl, protectedResourceMetadataUrls } from './reciprocity';
import type { Rich } from './rich-text';

export type TrailEntryView = {
  surface: Rich;
  /** The declared host, the entry's leading token. */
  host: string;
  /** The declared URL, shown only when it names more than the host's root. */
  url: string | null;
  redirectedTo: string | null;
  outcome: string;
  /** The outcomes a reader has to act on read in the mid band. */
  attention: boolean;
  why: Rich | null;
  guidance: Rich | null;
};

export type DeclaredHostsView =
  | { kind: 'list'; lede: string; entries: TrailEntryView[] }
  | { kind: 'line'; state: DeclaredHostsState; line: string };

/** Where reciprocity looks for an artifact naming an endpoint, from the registry's discovery block. */
type ConfirmLocations = { card_suffix: string; ai_catalog: string };

export interface TrailInput {
  domain: string;
  follow: FollowState;
  trail: DeclaredHostEntry[] | null;
  /** The result renders in place of a page, so a follow state of off was this run's choice. */
  transient: boolean;
  /** The scorecard's stored discovery evidence, which records each card's shape by its path. */
  discovery: unknown;
  /** Hosts whose OpenAPI description the audit read and scored as present. */
  openapiHosts: ReadonlySet<string>;
  /** When the audit ran, for the hour a domain's probe budget frees. */
  scoredAt: string | null;
  locations: ConfirmLocations | null;
}

function text(entry: DeclaredHostEntry, key: string): string | null {
  const value = entry[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** The host the audit reached for an entry: where a redirect led, else the one declared. */
function effectiveHostOf(entry: DeclaredHostEntry): string | null {
  const finalUrl = text(entry, 'final_url');
  return (finalUrl !== null ? hostOf(finalUrl) : null) ?? text(entry, 'host') ?? hostOf(text(entry, 'url') ?? '');
}

/** The distinct hosts the audit evaluated, in trail order. */
export function evaluatedHosts(trail: readonly DeclaredHostEntry[] | null): string[] {
  const hosts: string[] = [];
  for (const entry of trail ?? []) {
    const host = entry.outcome === 'followed' ? effectiveHostOf(entry) : null;
    if (host !== null && !hosts.includes(host)) hosts.push(host);
  }
  return hosts;
}

function discoveryItem(discovery: unknown, source: string): Record<string, unknown> | null {
  if (!Array.isArray(discovery)) return null;
  const found = discovery.find(
    (item: unknown) => typeof item === 'object' && item !== null && (item as { source?: unknown }).source === source,
  );
  return (found as Record<string, unknown> | undefined) ?? null;
}

/** What declared an entry, as a reader names it. */
function surfaceOf(entry: DeclaredHostEntry, discovery: unknown): Rich {
  const surface = text(entry, 'surface') ?? '';
  switch (entry.kind) {
    case 'api-anchor':
      return SURFACE_LABELS.apiAnchor;
    case 'api-description':
      return SURFACE_LABELS.apiDescription;
    case 'card-document':
      return SURFACE_LABELS.aiCatalog;
  }
  if (surface.includes('#/entries/')) return SURFACE_LABELS.aiCatalog;
  const item = discoveryItem(discovery, surface);
  if (item !== null && typeof item.redirect === 'string') return redirectSurface(surface);
  if (item?.shape === 'sep-2127') return SURFACE_LABELS.cardRemotes;
  if (item?.shape === 'sep-1649') return SURFACE_LABELS.cardTransport;
  return SURFACE_LABELS.card;
}

/** The trail entry that led the audit to `host`, as the category line names it. */
export function declarerOf(host: string, input: Pick<TrailInput, 'trail' | 'discovery' | 'domain'>): Rich | null {
  const entry = (input.trail ?? []).find((e) => e.outcome === 'followed' && effectiveHostOf(e) === host);
  return entry === undefined ? null : [`${input.domain}'s `, ...surfaceOf(entry, input.discovery)];
}

function namesMoreThanRoot(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.pathname !== '/' || parsed.search !== '';
  } catch {
    return true;
  }
}

/** The hour after `scoredAt`, as HH, when the hourly budget that refused a probe frees. */
function nextHour(scoredAt: string | null): string | null {
  const at = scoredAt === null ? Number.NaN : Date.parse(scoredAt);
  if (Number.isNaN(at)) return null;
  return new Date(Math.floor(at / 3_600_000) * 3_600_000 + 3_600_000).toISOString().slice(11, 13);
}

function endpointOf(entry: DeclaredHostEntry): string | null {
  return normalizeEndpointUrl(text(entry, 'final_url') ?? text(entry, 'url') ?? '');
}

function guidanceFor(entry: DeclaredHostEntry, input: TrailInput): Rich | null {
  const endpoint = entry.kind === 'mcp-endpoint' ? endpointOf(entry) : null;
  const host = endpoint === null ? null : hostOf(endpoint);
  if (endpoint === null || host === null || input.locations === null) return null;
  return confirmGuidance(host, endpoint, {
    card: cardSuffixUrl(endpoint, input.locations.card_suffix),
    catalog: resolveUrl(new URL(endpoint).origin, input.locations.ai_catalog),
    metadata: protectedResourceMetadataUrls(endpoint)[0],
  });
}

function whyFor(entry: DeclaredHostEntry, input: TrailInput, trail: readonly DeclaredHostEntry[]): Rich | null {
  if (entry.outcome !== 'followed') return null;
  if (entry.kind === 'mcp-endpoint') {
    const endpoint = endpointOf(entry);
    const by = entry.admitted_by;
    if (endpoint === null || (by !== 'card' && by !== 'ai-catalog' && by !== 'metadata')) return null;
    if (by === 'card' && input.locations === null) return null;
    return admittedByWhy(by, cardSuffixUrl(endpoint, input.locations?.card_suffix ?? ''), hostOf(endpoint) ?? '');
  }
  if (entry.kind !== 'api-anchor') return null;
  const anchor = text(entry, 'surface');
  const described = trail.some((d) => {
    if (d.kind !== 'api-description' || d.outcome !== 'followed' || anchor === null) return false;
    const host = effectiveHostOf(d);
    return (
      text(d, 'surface')?.startsWith(`${anchor}/service-desc/`) === true &&
      host !== null &&
      input.openapiHosts.has(host)
    );
  });
  return described ? OPENAPI_FOUND : null;
}

function outcomeOf(entry: DeclaredHostEntry, input: TrailInput): { outcome: string; attention: boolean } {
  const outcome = String(entry.outcome ?? '');
  switch (outcome) {
    case 'followed':
    case 'blocked':
      return { outcome: OUTCOME_WORDS[outcome], attention: false };
    case 'unreachable':
      return { outcome: OUTCOME_WORDS.unreachable, attention: true };
    case 'reciprocity-refused':
      return { outcome: notConfirmedOutcome(effectiveHostOf(entry) ?? ''), attention: true };
    case 'not-followed':
      return { outcome: notFollowedOutcome(text(entry, 'reason') ?? ''), attention: false };
    case 'budget-exceeded':
      return { outcome: budgetOutcome(text(entry, 'cause') ?? '', nextHour(input.scoredAt)), attention: false };
    default:
      return { outcome, attention: false };
  }
}

function entryView(entry: DeclaredHostEntry, input: TrailInput, trail: readonly DeclaredHostEntry[]): TrailEntryView {
  const url = text(entry, 'url') ?? '';
  const { outcome, attention } = outcomeOf(entry, input);
  return {
    surface: surfaceOf(entry, input.discovery),
    host: text(entry, 'host') ?? hostOf(url) ?? url,
    url: url !== '' && namesMoreThanRoot(url) ? url : null,
    redirectedTo: text(entry, 'final_url'),
    outcome,
    attention,
    why: whyFor(entry, input, trail),
    guidance: entry.outcome === 'reciprocity-refused' ? guidanceFor(entry, input) : null,
  };
}

/**
 * The Declared hosts slot. A follow state of off says why in one line
 * whatever the site declared, because every entry would only repeat it; a
 * scorecard that recorded no follow state or no trail says so, which is not
 * the same as a site that declared nothing.
 */
export function declaredHostsView(input: TrailInput): DeclaredHostsView {
  const line = (state: DeclaredHostsState): DeclaredHostsView => ({
    kind: 'line',
    state,
    line: DECLARED_HOSTS_LINES[state],
  });
  if (input.follow === 'not-evaluated' || input.trail === null) return line('not-recorded');
  if (input.follow === 'off') return line(input.transient ? 'this-run' : 'paused');
  const trail = input.trail;
  if (trail.length === 0) return line('none');
  return {
    kind: 'list',
    lede: declaredHostsLede(input.domain),
    entries: trail.map((entry) => entryView(entry, input, trail)),
  };
}
