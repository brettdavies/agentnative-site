// One-time, idempotent backfill that makes the stored `public_listing`
// schema exact on every existing per-domain web-audit object: user rows
// get `false`, curated seeds get `true`. It is fill-if-absent — an object
// that already carries an explicit flag is left untouched — so re-running
// is always safe and the completion signal is a run that writes nothing.
//
// The read-time board filter (coercing missing metadata to `false`) makes
// the board correct at deploy without this pass; the backfill's job is to
// make the stored schema exact and stamp curated seeds `true`. It is not a
// prerequisite for board correctness, so it runs after deploy.
//
// Boundedness: each object costs 2+ subrequests (a body read plus a
// preserving re-put) and one Worker invocation has a finite subrequest
// budget, so a run processes bounded work and returns a resume cursor.
// Completion protocol: re-run until a run reports zero writes.

import { SPEC_VERSION } from '../spec-version.gen';
import { get as cacheGet, isPerDomainAuditKey, patchStoredPublicListing, type WebCacheEnv } from './cache';
import { isSeededDomain, loadWebSeed, type WebSeedEnv } from './seed';

export type WebBackfillEnv = WebCacheEnv & WebSeedEnv;

export type WebBackfillOptions = {
  /** Resume point from a prior run's `cursor`. Absent starts a fresh pass. */
  cursor?: string;
  /** When true, compute and report intended changes but write nothing. */
  dryRun?: boolean;
  /** Cap on objects processed per run (re-put, or identified in a dry run) so the subrequest budget stays bounded. */
  maxWrites?: number;
  /** Spec version whose per-domain keys are in scope. Defaults to the current build. */
  specVersion?: string;
};

/** A single object the run identified as needing (or, in a real run, given) a flag. */
export type WebBackfillDiff = {
  key: string;
  domain: string;
  public_listing: boolean;
};

export type WebBackfillResult = {
  /** Per-domain keys examined this run (aggregate and off-version keys are not counted). */
  scanned: number;
  /** Objects re-put this run. Always 0 in a dry run. */
  written: number;
  /** Objects identified as needing a flag this run (both modes). */
  would_write: number;
  /** Objects left untouched because they already carried an explicit flag. */
  skipped: number;
  /** Objects that needed a flag but whose body was unreadable or whose re-put failed. */
  failed: number;
  dry_run: boolean;
  /** True when the listing drained fully this run. */
  done: boolean;
  /** Resume cursor for the next run, or null when the listing drained. */
  cursor: string | null;
  diffs: WebBackfillDiff[];
};

// R2 list page size. Small enough that a whole page of fills stays well
// inside one invocation's subrequest budget.
const BACKFILL_LIST_LIMIT = 100;

// Objects re-put per invocation before the run returns a resume cursor.
// A multiple of the page size so the write budget lands on a page boundary
// (each fill costs a body read plus a re-put; 400 fills is ~800 subrequests).
const DEFAULT_MAX_WRITES = 400;

const BACKFILL_SCOPE = 'web-cache.publicListingBackfill';

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Run one bounded batch of the `public_listing` backfill. Enumerates
 * per-domain objects at `specVersion`, and for each object with no stored
 * flag writes `public_listing = isSeededDomain(domain)` via the
 * `scored_at`-preserving writer (curated seeds -> true, user rows ->
 * false). Objects that already carry an explicit flag are skipped.
 *
 * Aborts before touching any object if the seed cannot load: a failed seed
 * load would misclassify curated domains as `false`, and fill-if-absent
 * would never revisit them on a later run. The seed-load error propagates
 * so the caller reports the abort rather than a partial success.
 */
export async function runWebPublicListingBackfill(
  env: WebBackfillEnv,
  opts: WebBackfillOptions = {},
): Promise<WebBackfillResult> {
  const specVersion = opts.specVersion ?? SPEC_VERSION;
  const dryRun = opts.dryRun ?? false;
  const maxWrites = opts.maxWrites ?? DEFAULT_MAX_WRITES;

  // Seed-load guard: load once up front so a load failure aborts the whole
  // batch (throws) before the enumeration writes anything. Per-domain
  // classification below reuses the module-cached load, so this costs one
  // fetch, not one per object.
  await loadWebSeed(env);

  const result: WebBackfillResult = {
    scanned: 0,
    written: 0,
    would_write: 0,
    skipped: 0,
    failed: 0,
    dry_run: dryRun,
    done: false,
    cursor: null,
    diffs: [],
  };

  let cursor = opts.cursor;
  do {
    let page: R2Objects;
    try {
      page = await env.SCORE_CACHE.list({
        prefix: 'audits/web/',
        include: ['customMetadata'],
        cursor,
        limit: BACKFILL_LIST_LIMIT,
      });
    } catch (err) {
      // A list failure ends this run without claiming completion; the
      // re-run-until-zero protocol picks up from the same cursor.
      console.log(JSON.stringify({ scope: BACKFILL_SCOPE, phase: 'list', error: errMsg(err) }));
      result.cursor = cursor ?? null;
      result.done = false;
      return result;
    }

    for (const obj of page.objects) {
      if (!isPerDomainAuditKey(obj.key, specVersion)) continue; // skip aggregate + off-version keys
      result.scanned++;

      // Fill-if-absent: an object that already carries a flag in metadata is
      // left untouched, so a re-run never overwrites an explicit value.
      if (obj.customMetadata?.public_listing !== undefined) {
        result.skipped++;
        continue;
      }

      // No stored flag: read the body to derive the domain and to carry the
      // prior scored_at forward through the preserving writer.
      const cached = await cacheGet(env, obj.key);
      if (!cached) {
        // Unreadable or corrupt body (cacheGet logged and deleted it):
        // count as failed so the run does not report a false zero.
        result.failed++;
        console.log(JSON.stringify({ scope: BACKFILL_SCOPE, action: 'unreadable', key: obj.key }));
        continue;
      }

      let domain: string;
      try {
        domain = new URL(cached.target_url).host;
      } catch {
        // A malformed target_url cannot be classified; count it failed so
        // the run never converges to a false zero over an unmigrated object,
        // and so the seed-load guard stays the only throw that escapes.
        result.failed++;
        console.log(JSON.stringify({ scope: BACKFILL_SCOPE, action: 'bad_target_url', key: obj.key }));
        continue;
      }
      const value = await isSeededDomain(env, domain);
      result.would_write++;
      result.diffs.push({ key: obj.key, domain, public_listing: value });
      console.log(
        JSON.stringify({
          scope: BACKFILL_SCOPE,
          action: dryRun ? 'would_add' : 'add',
          key: obj.key,
          domain,
          public_listing: value,
        }),
      );

      if (dryRun) continue;

      const ok = await patchStoredPublicListing(env, cached, value);
      if (ok) result.written++;
      else result.failed++;
    }

    cursor = page.truncated ? page.cursor : undefined;

    // Bound the run in both modes: a dry run still pays a body read per
    // unflagged object, so an unbounded pass would exhaust the invocation's
    // subrequest budget on a large bucket. Once the budget is spent and
    // objects remain, return the resume cursor.
    const progressed = dryRun ? result.would_write : result.written + result.failed;
    if (progressed >= maxWrites && cursor) {
      result.cursor = cursor;
      result.done = false;
      return result;
    }
  } while (cursor);

  result.cursor = null;
  result.done = true;
  return result;
}
