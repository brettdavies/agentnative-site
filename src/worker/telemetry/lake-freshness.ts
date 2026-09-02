// Daily telemetry-lake freshness check. Lists the lake bucket through the
// Worker binding, compares the newest ingest-written object's age to the
// stall threshold, and alerts the operator through the KV-deduped email
// path on breach. Worker-path reads only — the CLI read path can serve
// stale copies, so it cannot witness freshness. Best-effort like the other
// scheduled paths: nothing here throws into the cron.

import { type NotifyEnv, notifyFailure } from '../notify';

export interface LakeFreshnessEnv extends NotifyEnv {
  TELEMETRY_LAKE?: R2Bucket;
  TELEMETRY_ENVIRONMENT?: string;
}

export const LAKE_FRESHNESS_CRON = '0 6 * * *';

const HOUR_MS = 3_600_000;

// A full day with no delivery is a stall; the daily cron bounds detection
// at under 48 hours against the live layer's 7-day loss window.
export const LAKE_STALE_THRESHOLD_MS = 24 * HOUR_MS;

// Freshness must be measured over ingest-written objects only: catalog
// compaction rewrites old data into new objects with fresh timestamps, so
// a signal over compaction-managed keys reads young during a real stall.
// The recorded sink layout (docs/runbooks/sitewide-analytics.md § Sink
// layout) governs this value; until it records a dedicated compaction
// prefix, the whole bucket is the ingest surface.
export const LAKE_INGEST_PREFIX = '';

const SCOPE = 'telemetry.lake-freshness';

async function newestUploadedMs(bucket: R2Bucket, prefix: string): Promise<number | null> {
  let newest: number | null = null;
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor });
    for (const obj of page.objects) {
      const uploaded = obj.uploaded.getTime();
      if (newest === null || uploaded > newest) newest = uploaded;
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return newest;
}

export async function runLakeFreshnessCheck(env: LakeFreshnessEnv, now = Date.now()): Promise<void> {
  const environment = env.TELEMETRY_ENVIRONMENT ?? 'unset';
  const emit = (fields: Record<string, unknown>): void => {
    console.log(JSON.stringify({ scope: SCOPE, environment, ...fields }));
  };

  if (!env.TELEMETRY_LAKE) {
    emit({ error: 'lake_binding_missing', newest_age_ms: null, stale: null, notify: 'skipped' });
    return;
  }

  let newest: number | null;
  try {
    newest = await newestUploadedMs(env.TELEMETRY_LAKE, LAKE_INGEST_PREFIX);
  } catch (err) {
    emit({
      error: err instanceof Error ? err.message : String(err),
      newest_age_ms: null,
      stale: null,
      notify: 'skipped',
    });
    return;
  }

  const newestAgeMs = newest === null ? null : now - newest;
  // An empty listing is a stall too: a sink that has never delivered.
  const stale = newestAgeMs === null || newestAgeMs > LAKE_STALE_THRESHOLD_MS;
  let notify = 'skipped';
  if (stale) {
    if (environment === 'production') {
      const ageText =
        newestAgeMs === null
          ? 'no objects under the ingest prefix (the sink has never delivered)'
          : `the newest ingest-written object is ${Math.round(newestAgeMs / HOUR_MS)}h old ` +
            `(threshold ${LAKE_STALE_THRESHOLD_MS / HOUR_MS}h)`;
      notify = await notifyFailure(env, {
        key: 'telemetry-lake-stale',
        subject: `telemetry lake stale (${environment})`,
        text: `The ${environment} telemetry-lake export looks stalled: ${ageText}.`,
      });
    } else {
      // Off production the breach is log-only: the staging lake is
      // legitimately quiet most days, and routine staging alerts would
      // train the operator to ignore the production key.
      notify = 'log-only';
    }
  }
  emit({ newest_age_ms: newestAgeMs, stale, notify });
}
