// Central structured-log emitter. Every Worker log record is built here and
// handed to `console` as an object: Workers Logs indexes each key of an
// object argument as a queryable field, whereas a pre-serialized string
// collapses every field into `message` and leaves only `message` and
// `level` indexed. Call sites name a discriminator and their fields; the
// envelope, the closed scope vocabulary, the request-scoped ambient
// fields, the verbosity tier, and the console level all live here.

import { msBucket, truncateClientName } from '../mcp/telemetry';
import { getRequestContext } from './request-context';

/** Closed vocabulary of `scope` values. Adding a scope means adding it here. */
export type LogScope =
  | 'cache.get'
  | 'cache.put'
  | 'cache.write'
  | 'hit-min-purge'
  | 'notify.send_failed'
  | 'page.request'
  | 'scheduled'
  | 'score.telemetry.write_failed'
  | 'score.tier'
  | 'telemetry.lake-freshness'
  | 'web-aggregate'
  | 'web-audit.check'
  | 'web-audit.discovery'
  | 'web-audit.error'
  | 'web-audit.run'
  | 'web-backfill.trigger'
  | 'web-cache.get'
  | 'web-cache.getAggregate'
  | 'web-cache.listAllWebAudits'
  | 'web-cache.patchStoredPublicListing'
  | 'web-cache.publicListingBackfill'
  | 'web-cache.put'
  | 'web-cache.putAggregate'
  | 'web-rescore'
  | 'web-rescore.trigger'
  | 'web-seed';

/**
 * Records keyed by `event` instead of `scope`. `mcp.request` is a documented
 * public posture whose wire shape must not change, so it keeps its key.
 */
export type LogEvent = 'mcp.request';

export type LogDiscriminator = { scope: LogScope; event?: never } | { event: LogEvent; scope?: never };

export type LogFields = Readonly<Record<string, unknown>>;

export type LogRecord = Readonly<Record<string, unknown>>;

/** Console method the record is written with; Workers Logs indexes it as `level`. */
export type LogLevel = 'log' | 'warn' | 'error';

export interface LogOptions {
  level?: LogLevel;
  /** Debug-tier records are dropped unless `debug` is true. */
  tier?: 'always' | 'debug';
  debug?: boolean;
}

export type LogSink = (level: LogLevel, record: LogRecord) => void;

const consoleSink: LogSink = (level, record) => {
  console[level](record);
};

let sink: LogSink = consoleSink;

/** Test seam: replace the sink, or pass null to restore console. */
export function setLogSink(next: LogSink | null): void {
  sink = next ?? consoleSink;
}

// Client-supplied strings that reach the log on paths ahead of the rate
// limiter. Capping them here rather than at each call site keeps a flood
// from amplifying log volume with unbounded values.
const TRUNCATED_FIELDS: ReadonlySet<string> = new Set(['client_name', 'method', 'name']);

function cappedFields(fields: LogFields): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (key === 'duration_ms' && typeof value === 'number') {
      out.ms_bucket = msBucket(value);
    } else if (TRUNCATED_FIELDS.has(key) && (typeof value === 'string' || value === null)) {
      out[key] = truncateClientName(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Emit one structured record. Never throws: a logging failure must not
 * become a response failure, so anything the sink raises is dropped.
 */
export function emitLog(discriminator: LogDiscriminator, fields: LogFields, options: LogOptions = {}): void {
  try {
    if (options.tier === 'debug' && options.debug !== true) return;
    const record: LogRecord = {
      ...cappedFields(discriminator),
      ...getRequestContext(),
      ...cappedFields(fields),
    };
    sink(options.level ?? 'log', record);
  } catch {
    // Swallowed by design: telemetry can never fail the request path.
  }
}
