// Captures structured log records for assertions through the emitter's
// injectable sink, the only path a Worker record takes. Console output is
// silenced for the capture's lifetime and never read: a site that wrote to
// console directly would be invisible here, which is the point.

import { type LogLevel, type LogRecord, setLogSink } from '../../src/worker/telemetry/log';

export type CapturedLog = { level: LogLevel; record: LogRecord };

export interface LogCapture {
  readonly records: CapturedLog[];
  restore(): void;
}

const LEVELS: readonly LogLevel[] = ['log', 'warn', 'error'];

/** Start capturing; every record until `restore()` lands in `records`. */
export function captureLogs(): LogCapture {
  const records: CapturedLog[] = [];
  setLogSink((level, record) => {
    records.push({ level, record });
  });
  const originals = Object.fromEntries(LEVELS.map((level) => [level, console[level]])) as Record<
    LogLevel,
    (typeof console)[LogLevel]
  >;
  for (const level of LEVELS) {
    console[level] = () => {};
  }
  return {
    records,
    restore() {
      setLogSink(null);
      for (const level of LEVELS) console[level] = originals[level];
    },
  };
}

/** Run `fn` under capture and return both its result and the records. */
export async function withLogCapture<T>(fn: () => Promise<T>): Promise<{ result: T; records: CapturedLog[] }> {
  const capture = captureLogs();
  try {
    const result = await fn();
    return { result, records: capture.records };
  } finally {
    capture.restore();
  }
}
