// One NDJSON line per write. A failed write means the reader is gone; it
// is dropped rather than thrown, so a producer never dies on a consumer's
// disconnect.

/** A writer of one JSON value per line onto `writer`. */
export function ndjsonLineWriter(writer: WritableStreamDefaultWriter<Uint8Array>): (payload: unknown) => Promise<void> {
  const encoder = new TextEncoder();
  return (payload) => writer.write(encoder.encode(`${JSON.stringify(payload)}\n`)).catch(() => {});
}
