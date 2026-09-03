// Captures structured log records for assertions through the emitter's
// injectable sink. Console output is bridged as well, objects as-is and
// JSON strings parsed, so a record from a call site that still writes to
// console directly is captured under the same shape; the bridge goes away
// once no such call site remains.

import { type LogLevel, type LogRecord, setLogSink } from '../../src/worker/telemetry/log';

export type CapturedLog = { level: LogLevel; record: LogRecord };

export interface LogCapture {
  readonly records: CapturedLog[];
  restore(): void;
}

const LEVELS: readonly LogLevel[] = ['log', 'warn', 'error'];

function asRecord(value: unknown): LogRecord | null {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as LogRecord;
  if (typeof value !== 'string') return null;
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

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
    console[level] = (...args: unknown[]) => {
      const record = asRecord(args[0]);
      if (record) records.push({ level, record });
    };
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
