// The scorecard a card draws, read the same way the result page reads it.
//
// A curated slug wins over a live cache entry. A binary alias resolves to
// the slug. A stored record wins over an in-flight flag: the page shows the
// stored score while a re-audit runs. Pending is an in-flight run with
// nothing stored yet. Unscored is a record whose headline is not a 0–100
// percent. A real zero is a score.

import { cliScoredAt, curatedEntryForBinary, hasScorecard, scorePctOf } from '../../shared/audit-envelope';
import { classifyTarget } from '../../shared/audit-routes';
import { brandName, cliOgIdentity, type ScoreOgCard } from '../../shared/score-og';
import { CANONICAL_SITE_URL } from '../../shared/site-url';
import { readInFlight } from '../audit/inflight';
import {
  canonicalTargetOf,
  WebCacheUnavailableError,
  getForRequest as webCacheGet,
  keyFor as webKeyFor,
} from '../audit-web/cache';
import { loadWebSeed } from '../audit-web/seed';
import { get as cliCacheGet, keyFor as cliKeyFor } from '../score/cache';
import { readCuratedEnvelope } from '../score/core';
import { loadRegistryIndex, type RegistryEntry, type RegistryIndex } from '../score/registry-lookup';
import { SPEC_VERSION } from '../spec-version.gen';

export type ScoreOgEnv = {
  ASSETS: Fetcher;
  SCORE_CACHE: R2Bucket;
  SCORE_KV?: KVNamespace;
  /** context.dev key for the brand-logo fallback; unset skips that lookup. */
  CONTEXT_DEV_API_KEY?: string;
};

export type ScoreOgSubject =
  | {
      status: 'ready';
      /** Canonical result target. Differs from the request for an alias or a case fold. */
      target: string;
      card: ScoreOgCard;
      /** HTTPS pages a logo may be fetched from. Empty when the card stays a wordmark. */
      pages: string[];
      /** When the score was recorded; null for a pending card or a record without the stamp. */
      scoredAt: string | null;
    }
  | { status: 'missing' }
  | { status: 'unavailable' };

type ToolName = { name?: string; binary?: string };

/** Load the card for one result target. Does not fetch a logo. */
export async function loadScoreOgSubject(env: ScoreOgEnv, target: string): Promise<ScoreOgSubject> {
  const classified = classifyTarget(target);
  if (!classified.ok) return { status: 'missing' };
  if (classified.lane === 'web') return loadWeb(env, classified.target);
  if (classified.kind === 'cli-branch') return loadCachedCli(env, classified.target, await registryOrNull(env));
  return loadCli(env, classified.target);
}

async function loadWeb(env: ScoreOgEnv, host: string): Promise<ScoreOgSubject> {
  const canonical = canonicalTargetOf(new URL(`https://${host}/`));
  let record: Awaited<ReturnType<typeof webCacheGet>>;
  try {
    record = await webCacheGet(env, await webKeyFor(canonical, SPEC_VERSION));
  } catch (err) {
    if (err instanceof WebCacheUnavailableError) return { status: 'unavailable' };
    throw err;
  }
  const friendly = await seedName(env, host);
  const identity = brandName(host, friendly);
  if (!record) {
    if (await readInFlight(env, 'web', host))
      return pending(host, 'web', identity.name, identity.subtitle, [`https://${host}/`]);
    return { status: 'missing' };
  }
  return ready(host, {
    ...identity,
    lane: 'web',
    scorePct: finiteScore(scorePctOf(record.scorecard)),
    pending: false,
    specVersion: record.spec_version,
    logo: null,
    pages: [`https://${host}/`],
    scoredAt: record.scored_at ?? null,
  });
}

async function loadCli(env: ScoreOgEnv, target: string): Promise<ScoreOgSubject> {
  let registry: RegistryIndex;
  try {
    registry = await loadRegistryIndex(env);
  } catch {
    return { status: 'unavailable' };
  }
  const slugEntry = Object.hasOwn(registry.by_slug, target) ? registry.by_slug[target] : undefined;
  if (hasScorecard(slugEntry)) {
    const curated = await curatedSubject(env, slugEntry);
    if (curated) return curated;
  }
  const alias = curatedEntryForBinary(target, registry);
  if (hasScorecard(alias) && alias.name !== target) return loadCli(env, alias.name);
  return loadCachedCli(env, target, registry);
}

async function loadCachedCli(env: ScoreOgEnv, target: string, registry: RegistryIndex | null): Promise<ScoreOgSubject> {
  const record = await cliCacheGet(env, cliKeyFor(target, SPEC_VERSION));
  const entry = registry ? entryFor(registry, target) : undefined;
  const pages = httpsPage(entry?.url);
  if (!record) {
    if (await readInFlight(env, 'cli', target)) {
      const identity = cliOgIdentity(target, undefined);
      return pending(target, 'cli', identity.name, identity.subtitle, pages);
    }
    return { status: 'missing' };
  }
  const tool = (record.scorecard as { tool?: ToolName } | null)?.tool;
  const identity = cliOgIdentity(target, tool);
  return ready(target, {
    ...identity,
    lane: 'cli',
    scorePct: finiteScore(scorePctOf(record.scorecard)),
    pending: false,
    specVersion: record.spec_version,
    logo: null,
    pages,
    scoredAt: cliScoredAt(record),
  });
}

async function curatedSubject(env: ScoreOgEnv, entry: RegistryEntry): Promise<ScoreOgSubject | null> {
  const envelope = await readCuratedEnvelope(env, entry, CANONICAL_SITE_URL);
  if (!envelope) return null;
  const identity = cliOgIdentity(entry.name, { name: entry.name, binary: entry.binary }, entry.name);
  return ready(entry.name, {
    ...identity,
    lane: 'cli',
    scorePct: finiteScore(envelope.score_pct),
    pending: false,
    specVersion: envelope.spec_version,
    logo: null,
    pages: httpsPage(entry.url),
    scoredAt: cliScoredAt({ scorecard: envelope.scorecard }),
  });
}

function ready(target: string, card: ScoreOgCard & { pages: string[]; scoredAt: string | null }): ScoreOgSubject {
  const { pages, scoredAt, ...rest } = card;
  return { status: 'ready', target, card: rest, pages, scoredAt };
}

function pending(
  target: string,
  lane: ScoreOgCard['lane'],
  name: string,
  subtitle: string | null,
  pages: string[],
): ScoreOgSubject {
  return ready(target, {
    name,
    subtitle,
    lane,
    scorePct: null,
    pending: true,
    specVersion: SPEC_VERSION,
    logo: null,
    pages,
    scoredAt: null,
  });
}

function finiteScore(score: number | undefined): number | null {
  if (typeof score !== 'number' || !Number.isFinite(score)) return null;
  return score;
}

function httpsPage(raw: string | undefined): string[] {
  if (!raw?.startsWith('https://')) return [];
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' ? [url.toString()] : [];
  } catch {
    return [];
  }
}

function entryFor(registry: RegistryIndex, target: string): RegistryEntry | undefined {
  if (Object.hasOwn(registry.by_slug, target)) return registry.by_slug[target];
  return curatedEntryForBinary(target, registry) ?? undefined;
}

async function registryOrNull(env: ScoreOgEnv): Promise<RegistryIndex | null> {
  try {
    return await loadRegistryIndex(env);
  } catch {
    return null;
  }
}

async function seedName(env: ScoreOgEnv, host: string): Promise<string | null> {
  try {
    const entry = (await loadWebSeed(env)).find((item) => item.domain === host);
    return entry?.name ?? null;
  } catch {
    return null;
  }
}
