// The one result envelope every read surface returns: the JSON
// representation, the `complete` event, the MCP read tools, and the HTML
// and markdown renderers all build it from the same stored record through
// the builders here, so `scorecard` and `freshness` are byte-equal across
// surfaces.
//
// The stored R2 objects are never rewritten; the envelope wraps them at
// read time. Only named fields cross from a record into the envelope, so
// a record that carries sandbox paths, stderr, or session data cannot
// leak them.
//
// URL policy for a CLI result (the curated-slug shadow rule lives here so
// no consumer can mint a URL that serves a different tool's page):
//
//   target contains `@`  ......... branch-scoped: /score/<owner>/<repo>@<branch>
//   a curated tool's binary ...... registry hit: /score/<slug>, tier registry
//   a curated slug, other binary . collision: no URL, summary_html instead
//   a binary the route refuses ... no URL, summary_html instead (a reserved
//                                   name, or a dotted name the classifier
//                                   would read as a website host)
//   anything else ................ live: /score/<binary>
//
// A curated entry counts only with a committed scorecard; a metadata-only
// registry entry owns no page, so its slug is neither a hit nor a shadow.

import { isResultTarget, type Lane, laneOf, scoreJsonPath, scoreMarkdownPath, scorePath } from './audit-routes';
import { buildScorecardBody, escHtml } from './scorecard-format.mjs';

export type AuditTier = 'registry' | 'cache' | 'live';

export type AuditFreshness = { cached: boolean; scored_at: string | null; refresh_after: string | null };

export type AuditEnvelope = {
  kind: Lane;
  tier: AuditTier;
  target: string;
  scorecard_url: string | null;
  markdown_url: string | null;
  json_url: string | null;
  freshness: AuditFreshness;
  spec_version: string;
  scorecard: unknown;
  score_pct?: number;
  anc_version?: string;
  tool_version?: string;
  source_sha?: string;
  target_url?: string;
  summary_html?: string;
};

/** A web record younger than this serves from cache; it is also the refresh window `refresh_after` advertises. */
export const WEB_AUDIT_STALE_AFTER_MS = 60_000;

/** The R2 lifecycle rule on `scores/`; a live CLI record's `refresh_after` is its scoring instant plus this. */
export const LIVE_CLI_LIFECYCLE_MS = 7 * 24 * 60 * 60_000;

const REFRESH_WINDOW_MS: Record<Lane, number> = { web: WEB_AUDIT_STALE_AFTER_MS, cli: LIVE_CLI_LIFECYCLE_MS };

/**
 * Freshness from one scoring instant. `refresh_after` is derived, never
 * stored, so a stored stamp and a served refresh time cannot drift; a
 * missing or unparseable stamp reports both instants as null rather than
 * synthesizing a recent scoring time.
 */
export function freshnessFor(lane: Lane, cached: boolean, scoredAt: string | null | undefined): AuditFreshness {
  if (!scoredAt) return { cached, scored_at: null, refresh_after: null };
  const t = Date.parse(scoredAt);
  if (Number.isNaN(t)) return { cached, scored_at: null, refresh_after: null };
  return { cached, scored_at: scoredAt, refresh_after: new Date(t + REFRESH_WINDOW_MS[lane]).toISOString() };
}

export type RegistryEntryLike = {
  name: string;
  binary: string;
  scorecard_url?: string;
  score_pct?: number;
  anc_version?: string;
  version?: string;
};

export type RegistryIndexLike = { by_slug: Record<string, RegistryEntryLike> };

export type CliRecordLike = {
  spec_version: string;
  anc_version: string;
  tool_version: string;
  scorecard: unknown;
  scored_at?: string;
};

export type WebRecordLike = {
  spec_version: string;
  target_url: string;
  scorecard: unknown;
  scored_at?: string;
};

type ResultUrls = Pick<AuditEnvelope, 'scorecard_url' | 'markdown_url' | 'json_url'>;

function urlsFor(origin: string, target: string): ResultUrls {
  return {
    scorecard_url: `${origin}${scorePath(target)}`,
    markdown_url: `${origin}${scoreMarkdownPath(target)}`,
    json_url: `${origin}${scoreJsonPath(target)}`,
  };
}

const NO_URLS: ResultUrls = { scorecard_url: null, markdown_url: null, json_url: null };

type CliScorecardLike = {
  tool?: { name?: string; binary?: string };
  badge?: { score_pct?: number };
  run?: { started_at?: string };
};

function asCliScorecard(scorecard: unknown): CliScorecardLike {
  return typeof scorecard === 'object' && scorecard !== null ? (scorecard as CliScorecardLike) : {};
}

function scorePctOf(scorecard: unknown): number | undefined {
  const pct = (scorecard as { badge?: { score_pct?: unknown }; score_pct?: unknown } | null)?.badge?.score_pct;
  if (typeof pct === 'number') return pct;
  const flat = (scorecard as { score_pct?: unknown } | null)?.score_pct;
  return typeof flat === 'number' ? flat : undefined;
}

/** The curated entry whose binary is `binary`, or null; the by-slug key is not consulted. */
export function curatedEntryForBinary<T extends RegistryEntryLike>(
  binary: string,
  registry: { by_slug: Record<string, T> },
): T | null {
  for (const entry of Object.values(registry.by_slug)) {
    if (entry.binary === binary) return entry;
  }
  return null;
}

function hasScorecard(entry: RegistryEntryLike | null | undefined): entry is RegistryEntryLike {
  return Boolean(entry?.scorecard_url && entry.anc_version);
}

/** The curated entry a resolved binary belongs to, or the curated slug it merely shadows. */
function curatedFor(
  binary: string,
  registry: RegistryIndexLike,
): { kind: 'entry'; entry: RegistryEntryLike } | { kind: 'shadow' } | { kind: 'none' } {
  const entry = curatedEntryForBinary(binary, registry);
  if (hasScorecard(entry)) return { kind: 'entry', entry };
  const slugEntry = Object.hasOwn(registry.by_slug, binary) ? registry.by_slug[binary] : undefined;
  return hasScorecard(slugEntry) ? { kind: 'shadow' } : { kind: 'none' };
}

/** True when `/score/<binary>` is a path the result route would serve as a CLI result. */
function isRoutableBinary(binary: string): boolean {
  return isResultTarget(binary) && laneOf(binary) === 'cli';
}

export type RegistryEnvelopeInput = {
  entry: RegistryEntryLike;
  origin: string;
  specVersion: string;
  scorecard?: unknown;
};

/**
 * A curated result: the registry index is the source of its URL. The
 * score beside an attached scorecard is that scorecard's own, so the
 * headline number and `scorecard.badge.score_pct` cannot disagree inside
 * one envelope; the entry's score stands in only when no scorecard is
 * attached.
 */
export function buildRegistryEnvelope(input: RegistryEnvelopeInput): AuditEnvelope {
  const { entry, origin } = input;
  const envelope: AuditEnvelope = {
    kind: 'cli',
    tier: 'registry',
    target: entry.name,
    ...urlsFor(origin, entry.name),
    freshness: freshnessFor('cli', true, null),
    spec_version: input.specVersion,
    scorecard: input.scorecard ?? null,
  };
  const pct = input.scorecard === undefined ? entry.score_pct : (scorePctOf(input.scorecard) ?? entry.score_pct);
  if (pct !== undefined) envelope.score_pct = pct;
  if (entry.anc_version !== undefined) envelope.anc_version = entry.anc_version;
  if (entry.version !== undefined) envelope.tool_version = entry.version;
  return envelope;
}

export type CliEnvelopeInput = {
  tier: 'cache' | 'live';
  /** The result target: the binary, or `owner/repo@branch` for a source clone. */
  target: string;
  record: CliRecordLike;
  registry: RegistryIndexLike;
  origin: string;
  /** Defaults to true for the cache tier and false for a live run. */
  cached?: boolean;
  sourceSha?: string;
};

/** A live or cached CLI result; a binary that names a curated tool becomes a registry hit. */
export function buildCliEnvelope(input: CliEnvelopeInput): AuditEnvelope {
  const { record, origin, target } = input;
  const liveEnvelope = (urls: ResultUrls): AuditEnvelope => {
    const scorecard = asCliScorecard(record.scorecard);
    const cached = input.cached ?? input.tier === 'cache';
    const envelope: AuditEnvelope = {
      kind: 'cli',
      tier: input.tier,
      target,
      ...urls,
      freshness: freshnessFor('cli', cached, record.scored_at ?? scorecard.run?.started_at ?? null),
      spec_version: record.spec_version,
      scorecard: record.scorecard,
      anc_version: record.anc_version,
      tool_version: record.tool_version,
    };
    const pct = scorePctOf(record.scorecard);
    if (pct !== undefined) envelope.score_pct = pct;
    return envelope;
  };

  if (target.includes('@')) {
    const envelope = liveEnvelope(urlsFor(origin, target));
    if (input.sourceSha !== undefined) envelope.source_sha = input.sourceSha;
    return envelope;
  }

  const curated = curatedFor(target, input.registry);
  if (curated.kind === 'entry') {
    const registryEnvelope = buildRegistryEnvelope({
      entry: curated.entry,
      origin,
      specVersion: record.spec_version,
      scorecard: record.scorecard,
    });
    return { ...registryEnvelope, anc_version: record.anc_version, tool_version: record.tool_version };
  }
  if (curated.kind === 'shadow' || !isRoutableBinary(target)) {
    return { ...liveEnvelope(NO_URLS), summary_html: collisionSummaryHtml(target, record) };
  }
  return liveEnvelope(urlsFor(origin, target));
}

// The result body a result with no page of its own renders inline on the
// progress page: the shared scorecard body without its crumb and badge
// call-to-action, so nothing in it links to a page that would serve a
// different tool or that the route would refuse.
function collisionSummaryHtml(binary: string, record: CliRecordLike): string {
  const scorecard = asCliScorecard(record.scorecard);
  const tool = { name: scorecard.tool?.name ?? binary, binary: scorecard.tool?.binary ?? binary };
  const headerSubline = `Binary <code>${escHtml(binary)}</code> · scored by anc ${escHtml(record.anc_version)} · spec ${escHtml(record.spec_version)}`;
  return buildScorecardBody(tool, scorecard, {
    version: record.tool_version,
    headerSubline,
    hideBreadcrumb: true,
    hideBadgeEmbed: true,
    showBadgePreview: false,
  });
}

export type WebEnvelopeInput = {
  tier: 'cache' | 'live';
  /** The website target: the host, with a non-default port. */
  target: string;
  record: WebRecordLike;
  origin: string;
  cached?: boolean;
};

/** A live or cached website result. */
export function buildWebEnvelope(input: WebEnvelopeInput): AuditEnvelope {
  const { record, origin, target } = input;
  const cached = input.cached ?? input.tier === 'cache';
  const envelope: AuditEnvelope = {
    kind: 'web',
    tier: input.tier,
    target,
    ...urlsFor(origin, target),
    freshness: freshnessFor('web', cached, record.scored_at),
    spec_version: record.spec_version,
    scorecard: record.scorecard,
    target_url: record.target_url,
  };
  const pct = scorePctOf(record.scorecard);
  if (pct !== undefined) envelope.score_pct = pct;
  return envelope;
}
