// AE telemetry regression suite (plan U10).
//
// Pins the writeDataPoint field-shape contract and the per-tier
// emission discipline so a future refactor that reorders blobs /
// drops a blob / skips emission on a bounce class fails LOCALLY,
// before it silently breaks every saved AE SQL query in
// docs/runbooks/live-scoring-analytics.md.
//
// Tests reuse the makeEnv / postScore / getScore helpers exported
// from tests/score-handler.test.ts so a regression in the handler's
// fixture wiring surfaces in one place rather than two.

import { beforeEach, describe, expect, test } from 'bun:test';
import { _resetIndexCache, handleScore } from '../src/worker/score/handler';
import { _resetKillSwitchCache } from '../src/worker/score/kill-switch';
import { ANC_VERSION } from '../src/worker/spec-version.gen';
import { getScore, makeEnv, postScore, type TelemetryEvent } from './score-handler.test';

beforeEach(() => {
  _resetIndexCache();
  _resetKillSwitchCache();
});

// Canonical slot positions — single source of truth for the regression
// test. If the helper or the runbook needs to move, this object is the
// one place to update.
const SLOT = {
  BLOB_INPUT_KIND: 0,
  BLOB_PM: 1,
  BLOB_ERROR_CODE: 2,
  BLOB_FRESHNESS: 3,
  BLOB_RESOLVED_STEP: 4,
  DOUBLE_TOTAL_MS: 0,
  DOUBLE_INSTALL_MS: 1,
  DOUBLE_ANC_CHECK_MS: 2,
  DOUBLE_STATUS: 3,
} as const;

function lastEvent(events: TelemetryEvent[]): TelemetryEvent {
  expect(events.length).toBeGreaterThan(0);
  return events[events.length - 1];
}

// ---------------------------------------------------------------------------
// Field-shape regression — pins blob/double/index slot assignments
// ---------------------------------------------------------------------------

describe('AE telemetry — field-shape contract', () => {
  test('every event carries blobs.length=5 and doubles.length=4', async () => {
    const events: TelemetryEvent[] = [];
    await handleScore(getScore('ripgrep'), makeEnv({ telemetryEvents: events }));
    const evt = lastEvent(events);
    expect(evt.blobs?.length).toBe(5);
    expect(evt.doubles?.length).toBe(4);
  });

  test('curated hit emits blob1=registry, blob4=registry-hit, blob5=registry, index1=tool', async () => {
    const events: TelemetryEvent[] = [];
    await handleScore(getScore('ripgrep'), makeEnv({ telemetryEvents: events }));
    const evt = lastEvent(events);
    expect(evt.blobs?.[SLOT.BLOB_INPUT_KIND]).toBe('registry');
    expect(evt.blobs?.[SLOT.BLOB_FRESHNESS]).toBe('registry-hit');
    expect(evt.blobs?.[SLOT.BLOB_RESOLVED_STEP]).toBe('registry');
    // Curated registry hits don't go through resolveSpec, so blob2 pm is null.
    expect(evt.blobs?.[SLOT.BLOB_PM]).toBe(null);
    expect(evt.blobs?.[SLOT.BLOB_ERROR_CODE]).toBe(null);
    // index1 carries the tool name on success paths with a known binary.
    expect(evt.indexes).toEqual(['rg']);
  });

  test('doubles capture status + total_ms; install/anc null on curated hit', async () => {
    const events: TelemetryEvent[] = [];
    await handleScore(getScore('ripgrep'), makeEnv({ telemetryEvents: events }));
    const evt = lastEvent(events);
    expect(typeof evt.doubles?.[SLOT.DOUBLE_TOTAL_MS]).toBe('number');
    expect(evt.doubles?.[SLOT.DOUBLE_INSTALL_MS]).toBe(null);
    expect(evt.doubles?.[SLOT.DOUBLE_ANC_CHECK_MS]).toBe(null);
    expect(evt.doubles?.[SLOT.DOUBLE_STATUS]).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Per-tier emission discipline
// ---------------------------------------------------------------------------

describe('AE telemetry — emits exactly one event per /api/score request', () => {
  test('curated registry hit → 1 event', async () => {
    const events: TelemetryEvent[] = [];
    await handleScore(getScore('ripgrep'), makeEnv({ telemetryEvents: events }));
    expect(events).toHaveLength(1);
  });

  test('GET miss (chain_no_resolve) → 1 event with blob3=chain_no_resolve, status=404', async () => {
    const events: TelemetryEvent[] = [];
    const res = await handleScore(
      getScore('https://github.com/owner/not-in-registry'),
      makeEnv({ telemetryEvents: events }),
    );
    expect(events).toHaveLength(1);
    const evt = lastEvent(events);
    expect(evt.blobs?.[SLOT.BLOB_ERROR_CODE]).toBe('chain_no_resolve');
    expect(evt.blobs?.[SLOT.BLOB_FRESHNESS]).toBe(null);
    expect(evt.doubles?.[SLOT.DOUBLE_STATUS]).toBe(res.status);
  });

  test('POST validation reject (invalid github host) → 1 event with input_kind=invalid', async () => {
    const events: TelemetryEvent[] = [];
    await handleScore(postScore('https://gitlab.com/owner/repo'), makeEnv({ telemetryEvents: events }));
    const evt = lastEvent(events);
    expect(events).toHaveLength(1);
    expect(evt.blobs?.[SLOT.BLOB_INPUT_KIND]).toBe('invalid');
    expect(evt.blobs?.[SLOT.BLOB_ERROR_CODE]).toBe('non_github_host');
  });

  test('POST turnstile_failed → 1 event with blob3=turnstile_failed', async () => {
    const events: TelemetryEvent[] = [];
    await handleScore(
      postScore('cargo install foo-cli'),
      makeEnv({ telemetryEvents: events, turnstileResponse: { success: false } }),
    );
    const evt = lastEvent(events);
    expect(events).toHaveLength(1);
    expect(evt.blobs?.[SLOT.BLOB_ERROR_CODE]).toBe('turnstile_failed');
  });

  test('POST rate_limited (session limiter) → 1 event with blob3=rate_limited, status=429', async () => {
    const events: TelemetryEvent[] = [];
    await handleScore(postScore('cargo install foo-cli'), makeEnv({ telemetryEvents: events, rateLimit: false }));
    const evt = lastEvent(events);
    expect(events).toHaveLength(1);
    expect(evt.blobs?.[SLOT.BLOB_ERROR_CODE]).toBe('rate_limited');
    expect(evt.doubles?.[SLOT.DOUBLE_STATUS]).toBe(429);
  });

  test('POST live success → 1 event with blob4=live, install_ms + anc_audit_ms populated', async () => {
    const events: TelemetryEvent[] = [];
    await handleScore(
      postScore('cargo install foo-cli'),
      makeEnv({
        telemetryEvents: events,
        doResponse: {
          scorecard: { tool: { name: 'foo-cli', version: '1.0.0' } },
          anc_version: ANC_VERSION,
          install_ms: 1234,
          anc_audit_ms: 567,
        },
      }),
    );
    const evt = lastEvent(events);
    expect(events).toHaveLength(1);
    expect(evt.blobs?.[SLOT.BLOB_FRESHNESS]).toBe('live');
    expect(evt.blobs?.[SLOT.BLOB_PM]).toBe('cargo-binstall');
    expect(evt.doubles?.[SLOT.DOUBLE_INSTALL_MS]).toBe(1234);
    expect(evt.doubles?.[SLOT.DOUBLE_ANC_CHECK_MS]).toBe(567);
    expect(evt.doubles?.[SLOT.DOUBLE_STATUS]).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Kill-switch + telemetry interaction — operators MUST see kill-switched
// traffic in AE; suppressing the event would hide a denial-of-service
// signal.
// ---------------------------------------------------------------------------

describe('AE telemetry — kill switch fired still emits', () => {
  test('scoring_disabled bounce → 1 event with blob3=scoring_disabled, status=503', async () => {
    const events: TelemetryEvent[] = [];
    const res = await handleScore(
      postScore('cargo install foo-cli'),
      makeEnv({ telemetryEvents: events, kvDisabled: true }),
    );
    expect(events).toHaveLength(1);
    const evt = lastEvent(events);
    expect(evt.blobs?.[SLOT.BLOB_ERROR_CODE]).toBe('scoring_disabled');
    expect(evt.doubles?.[SLOT.DOUBLE_STATUS]).toBe(503);
    expect(res.status).toBe(503);
  });
});

// ---------------------------------------------------------------------------
// Graceful degradation — AE outage MUST NOT break /api/score
// ---------------------------------------------------------------------------

describe('AE telemetry — write failure swallowed', () => {
  test('writeDataPoint throws on success path → handler still returns 200', async () => {
    const res = await handleScore(getScore('ripgrep'), makeEnv({ telemetryThrows: true }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { spec_version: string; auditor_url: string };
    expect(body.spec_version).toBeDefined();
    expect(body.auditor_url).toBeDefined();
  });

  test('writeDataPoint throws on error path → handler still returns the error envelope', async () => {
    const res = await handleScore(
      postScore('cargo install foo-cli'),
      makeEnv({ telemetryThrows: true, rateLimit: false }),
    );
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('rate_limited');
  });
});
