// Central structured-log emitter tests. The load-bearing assertion is
// that the sink receives an object rather than a pre-serialized string:
// Workers Logs indexes the keys of an object argument and collapses a
// string into `message`. The rest pins the envelope: `mcp.request` is
// keyed `event` with no `scope`, a throwing sink never reaches the
// caller, undefined fields are omitted, the debug tier is gated on the
// caller's flag, ambient request fields merge in without threading, and
// the console level survives so the indexed `level` key is unchanged.

import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { emitLog, type LogLevel, type LogRecord, setLogSink } from '../src/worker/telemetry/log';
import { runWithRequestContext } from '../src/worker/telemetry/request-context';

type Captured = { level: LogLevel; record: LogRecord };

function captureSink(): Captured[] {
  const seen: Captured[] = [];
  setLogSink((level, record) => {
    seen.push({ level, record });
  });
  return seen;
}

afterEach(() => {
  setLogSink(null);
});

describe('emitLog', () => {
  test('hands the sink an object, not a string', () => {
    const seen = captureSink();
    emitLog({ scope: 'cache.get' }, { key: 'k', error: 'boom' });
    expect(seen.length).toBe(1);
    expect(typeof seen[0].record).toBe('object');
    expect(typeof seen[0].record).not.toBe('string');
    expect(seen[0].record).toEqual({ scope: 'cache.get', key: 'k', error: 'boom' });
  });

  test('the default sink passes the object itself to console, unserialized', () => {
    const logSpy = spyOn(console, 'log').mockImplementation(() => {});
    try {
      emitLog({ scope: 'cache.put' }, { key: 'k' });
      expect(logSpy.mock.calls.length).toBe(1);
      const arg = logSpy.mock.calls[0][0];
      expect(typeof arg).toBe('object');
      expect(arg).toEqual({ scope: 'cache.put', key: 'k' });
    } finally {
      logSpy.mockRestore();
    }
  });

  test('an mcp.request emit is keyed event with no scope field', () => {
    const seen = captureSink();
    emitLog({ event: 'mcp.request' }, { era: 'modern', outcome: 'ok' });
    expect(seen[0].record.event).toBe('mcp.request');
    expect('scope' in seen[0].record).toBe(false);
    expect(Object.keys(seen[0].record)).toEqual(['event', 'era', 'outcome']);
  });

  test('a throwing sink never reaches the caller', () => {
    setLogSink(() => {
      throw new Error('sink exploded');
    });
    expect(() => emitLog({ scope: 'cache.get' }, { key: 'k' })).not.toThrow();
  });

  test('an unknown scope fails typecheck', () => {
    const seen = captureSink();
    // @ts-expect-error 'not.a.scope' is outside the closed vocabulary
    emitLog({ scope: 'not.a.scope' }, {});
    expect(seen.length).toBe(1);
  });

  test('a field whose value is undefined is omitted rather than emitted as null', () => {
    const seen = captureSink();
    emitLog({ scope: 'web-seed' }, { present: null, absent: undefined, count: 0 });
    expect('absent' in seen[0].record).toBe(false);
    expect(seen[0].record).toEqual({ scope: 'web-seed', present: null, count: 0 });
  });

  test('a debug-tier emit is dropped when the flag is off and emitted when it is on', () => {
    const seen = captureSink();
    emitLog({ scope: 'web-audit.check' }, { id: 'x' }, { tier: 'debug', debug: false });
    emitLog({ scope: 'web-audit.check' }, { id: 'y' }, { tier: 'debug' });
    expect(seen.length).toBe(0);
    emitLog({ scope: 'web-audit.check' }, { id: 'z' }, { tier: 'debug', debug: true });
    expect(seen.length).toBe(1);
    expect(seen[0].record.id).toBe('z');
  });

  test('ambient request fields merge in without the call site passing them', () => {
    const seen = captureSink();
    runWithRequestContext({ ambient: 'yes' }, () => {
      emitLog({ scope: 'cache.get' }, { key: 'k' });
    });
    emitLog({ scope: 'cache.get' }, { key: 'outside' });
    expect(seen[0].record).toEqual({ scope: 'cache.get', ambient: 'yes', key: 'k' });
    expect('ambient' in seen[1].record).toBe(false);
  });

  test('the console level is preserved and defaults to log', () => {
    const seen = captureSink();
    emitLog({ scope: 'notify.send_failed' }, { key: 'k' }, { level: 'error' });
    emitLog({ scope: 'cache.get' }, { key: 'k' });
    expect(seen.map((s) => s.level)).toEqual(['error', 'log']);
  });

  test('arrays and nested objects pass through as values', () => {
    const seen = captureSink();
    const errors = [{ message: 'a' }, { message: 'b' }];
    emitLog({ scope: 'hit-min-purge' }, { tags: ['t1', 't2'], errors });
    expect(seen[0].record.tags).toEqual(['t1', 't2']);
    expect(seen[0].record.errors).toEqual(errors);
  });
});

describe('emitLog field caps', () => {
  const long = 'x'.repeat(200);

  test('client_name, method, and name are each truncated at 64 at the boundary', () => {
    const seen = captureSink();
    emitLog({ event: 'mcp.request' }, { client_name: long, method: long, name: long });
    for (const key of ['client_name', 'method', 'name'] as const) {
      const value = seen[0].record[key];
      expect(typeof value).toBe('string');
      expect((value as string).length).toBe(64);
      expect((value as string).endsWith('…')).toBe(true);
    }
  });

  test('a raw millisecond duration emerges bucketed as ms_bucket at the existing boundaries', () => {
    const seen = captureSink();
    for (const ms of [0, 49, 50, 199, 200, 999, 1000, 5000]) {
      emitLog({ event: 'mcp.request' }, { duration_ms: ms });
    }
    expect(seen.map((s) => s.record.ms_bucket)).toEqual([
      '<50',
      '<50',
      '50-200',
      '50-200',
      '200-1000',
      '200-1000',
      '>1000',
      '>1000',
    ]);
    expect(seen.every((s) => !('duration_ms' in s.record))).toBe(true);
  });

  test('an already-truncated value is not double-truncated', () => {
    const seen = captureSink();
    emitLog({ event: 'mcp.request' }, { client_name: long });
    const once = seen[0].record.client_name as string;
    emitLog({ event: 'mcp.request' }, { client_name: once });
    expect(seen[1].record.client_name).toBe(once);
  });

  test('null and empty capped values resolve the way the mcp.request line always has', () => {
    const seen = captureSink();
    emitLog({ event: 'mcp.request' }, { client_name: null, method: '', name: 'tools/list' });
    expect(seen[0].record).toEqual({ event: 'mcp.request', client_name: null, method: null, name: 'tools/list' });
  });

  test('a field not on the named cap list passes through untouched', () => {
    const seen = captureSink();
    emitLog({ scope: 'web-audit.run' }, { target: long, elapsed_ms: 5000, checks: { pass: 1 } });
    expect(seen[0].record.target).toBe(long);
    expect(seen[0].record.elapsed_ms).toBe(5000);
    expect(seen[0].record.checks).toEqual({ pass: 1 });
  });
});
