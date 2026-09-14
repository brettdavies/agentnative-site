// NDJSON on both sides of a stream. A failed write means the reader is
// gone; it is dropped rather than thrown, so a producer never dies on a
// consumer's disconnect. The reader yields each line's JSON value as the
// line completes, so a consumer renders an event while the stream is still
// open.

/** A writer of one JSON value per line onto `writer`. */
export function ndjsonLineWriter(writer: WritableStreamDefaultWriter<Uint8Array>): (payload: unknown) => Promise<void> {
  const encoder = new TextEncoder();
  return (payload) => writer.write(encoder.encode(`${JSON.stringify(payload)}\n`)).catch(() => {});
}

function parseLine(raw: string): { value: unknown } | null {
  const line = raw.trim();
  if (!line) return null;
  try {
    return { value: JSON.parse(line) };
  } catch {
    return null;
  }
}

/**
 * Each JSON value of an NDJSON body in order; a line that is not JSON is
 * skipped. When `signal` aborts, the body is cancelled and the iteration
 * throws the signal's reason.
 */
export async function* ndjsonValues(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const onAbort = () => {
    reader.cancel().catch(() => {});
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  let buffered = '';
  try {
    while (true) {
      if (signal?.aborted) throw signal.reason;
      const { value, done } = await reader.read();
      if (signal?.aborted) throw signal.reason;
      buffered += decoder.decode(value ?? new Uint8Array(), { stream: !done });
      let newline = buffered.indexOf('\n');
      while (newline >= 0) {
        const parsed = parseLine(buffered.slice(0, newline));
        buffered = buffered.slice(newline + 1);
        if (parsed) yield parsed.value;
        newline = buffered.indexOf('\n');
      }
      if (done) {
        const last = parseLine(buffered);
        if (last) yield last.value;
        return;
      }
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    reader.cancel().catch(() => {});
  }
}
