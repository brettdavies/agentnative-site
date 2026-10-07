// The per-audit memo of what the target answered, one redirect hop at a
// time, keyed on what the target sees (method, URL, headers, body), so a
// caller's redirect or body-cap policy never turns one question into two
// requests. A request goes out again only when the answer on record cannot
// serve the caller: it kept less of the body than the caller reads, or it
// arrived later than the caller's deadline allows. Nothing here reaches the
// network: guardedFetch sends each hop and hands this module the response.

export const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

// The memo keeps a body up to MEMO_BODY_MAX_BYTES for later callers, and
// no more than MEMO_TOTAL_MAX_BYTES across the audit, so a target serving
// large bodies at every path cannot make one audit hold tens of megabytes
// in an isolate other audits share. A body past either cap still reaches
// the caller that read it; a later caller that needs it asks again.
const MEMO_BODY_MAX_BYTES = 1024 * 1024;
const MEMO_TOTAL_MAX_BYTES = 8 * 1024 * 1024;

const DECODER = new TextDecoder();

export type HopRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
};

/** Why a request or its body read got no further: the message the probe reports, and whether a deadline cut it off. */
type HopError = { message: string; timedOut: boolean; elapsedMs: number; budgetMs: number };

type HopAnswer = {
  kind: 'answer';
  status: number;
  /** Response headers with lowercased names. */
  headers: Record<string, string>;
  /** Milliseconds until the status and headers arrived. */
  headersMs: number;
  /** Body bytes read, up to `bodyCap`; empty when `bodyCap` is 0. */
  bytes: Uint8Array;
  /** The cap the body was read with: undefined = read in full, 0 = not read. */
  bodyCap: number | undefined;
  /** The body continued past `bodyCap`. */
  truncated: boolean;
  /** Milliseconds until the body read ended. */
  elapsedMs: number;
  /** Set when the body read failed after the status and headers arrived. */
  bodyError?: HopError;
};

type HopFailure = { kind: 'failure'; error: HopError };

export type HopRecord = HopAnswer | HopFailure;

/** One audit's answers, keyed by the request that produced them, and the body bytes they hold. */
export type RequestMemo = { entries: Map<string, Promise<HopRecord>>; retainedBytes: number };

export function createRequestMemo(): RequestMemo {
  return { entries: new Map(), retainedBytes: 0 };
}

export type HopContext = {
  /** When the caller's deadline passes, in Date.now() milliseconds. */
  deadlineAt: number;
  /** Aborts when the caller's deadline passes. */
  signal: AbortSignal;
  /** The caller's cap for the body of a response it keeps as its answer. */
  bodyCap: number | undefined;
  /** The caller may keep a redirect as its answer instead of following it, so its body is read. */
  keepsRedirect: boolean;
  memo?: RequestMemo;
};

type BodyRead = { body: string; truncated: boolean };

export function isRedirect(answer: Pick<HopAnswer, 'status' | 'headers'>): boolean {
  return REDIRECT_STATUSES.has(answer.status) && Boolean(answer.headers.location);
}

/** Whether the caller reads a body from this answer: it does not for a redirect it follows or a status-only read. */
function readsBody(
  answer: Pick<HopAnswer, 'status' | 'headers'>,
  ctx: Pick<HopContext, 'bodyCap' | 'keepsRedirect'>,
): boolean {
  return ctx.bodyCap !== 0 && !(isRedirect(answer) && !ctx.keepsRedirect);
}

/**
 * The body as a caller with `bodyCap` reads it, or null when the bytes the
 * answer kept cannot serve that cap.
 */
export function bodyOf(answer: HopAnswer, bodyCap: number | undefined): BodyRead | null {
  if (bodyCap === 0) return { body: '', truncated: false };
  if (answer.bodyCap === 0) return null;
  if (answer.truncated && (bodyCap === undefined || answer.bodyCap === undefined || bodyCap > answer.bodyCap)) {
    return null;
  }
  const bytes = bodyCap === undefined ? answer.bytes : answer.bytes.subarray(0, bodyCap);
  const truncated = answer.truncated || bytes.byteLength < answer.bytes.byteLength;
  return { body: DECODER.decode(bytes), truncated };
}

/**
 * Whether a recorded error answers a caller with `budgetMs` left as its own
 * request would have: a timeout only when the caller's deadline is no
 * longer than the one that ran out, any other error when it arrived within
 * the caller's deadline.
 */
function errorAnswers(error: HopError, budgetMs: number): boolean {
  return error.timedOut ? budgetMs <= error.budgetMs : error.elapsedMs <= budgetMs;
}

/** Whether a stored record answers a caller with `ctx`'s deadline and body cap as a request of its own would have. */
function answers(record: HopRecord, ctx: HopContext): boolean {
  const budgetMs = ctx.deadlineAt - Date.now();
  if (record.kind === 'failure') return errorAnswers(record.error, budgetMs);
  if (!readsBody(record, ctx)) return record.headersMs <= budgetMs;
  if (record.bodyError !== undefined) return errorAnswers(record.bodyError, budgetMs);
  return record.elapsedMs <= budgetMs && bodyOf(record, ctx.bodyCap) !== null;
}

/** How much of the body a record can serve: nothing (a failure), up to its cap, or all of it. */
function coverage(record: HopRecord): number {
  if (record.kind === 'failure') return -1;
  if (!record.truncated && record.bodyCap !== 0) return Number.POSITIVE_INFINITY;
  return record.bodyCap ?? Number.POSITIVE_INFINITY;
}

/** The record the memo keeps for later callers: the body only while it fits under both caps. */
function retained(record: HopRecord, memo: RequestMemo): HopRecord {
  if (record.kind === 'failure') return record;
  const size = record.bytes.byteLength;
  if (size <= MEMO_BODY_MAX_BYTES && memo.retainedBytes + size <= MEMO_TOTAL_MAX_BYTES) {
    memo.retainedBytes += size;
    return record;
  }
  return { ...record, bytes: new Uint8Array(0), bodyCap: 0, truncated: false };
}

function keyOf(request: HopRequest): string {
  const headers = Object.entries(request.headers)
    .map(([name, value]): [string, string] => [name.toLowerCase(), value])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify([request.method.toUpperCase(), request.url, headers, request.body ?? null]);
}

const DEADLINE_PASSED = Symbol('deadline passed');

/** `pending`, or DEADLINE_PASSED when the caller's deadline passes first. */
function withinDeadline<T>(pending: Promise<T>, signal: AbortSignal): Promise<T | typeof DEADLINE_PASSED> {
  if (signal.aborted) return Promise.resolve(DEADLINE_PASSED);
  let onAbort = (): void => {};
  const passed = new Promise<typeof DEADLINE_PASSED>((resolve) => {
    onAbort = () => resolve(DEADLINE_PASSED);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  return Promise.race([pending, passed]).finally(() => signal.removeEventListener('abort', onAbort));
}

/**
 * The answer to `request`: what an identical request already got this audit
 * when that answers the caller, else whatever `send` gets from the target.
 * A caller waiting on an identical request still in flight waits no longer
 * than its own deadline. A new answer that serves less than the one on
 * record (a failure, or less of the body) goes to this caller only; the
 * memo keeps the better one.
 */
export async function takeHop(
  request: HopRequest,
  ctx: HopContext,
  send: (ctx: HopContext) => Promise<HopRecord>,
): Promise<HopRecord> {
  const memo = ctx.memo;
  if (memo === undefined) return send(ctx);
  const started = Date.now();
  const key = keyOf(request);
  const prior = memo.entries.get(key);
  const priorRecord = prior === undefined ? undefined : await withinDeadline(prior, ctx.signal);
  if (priorRecord === DEADLINE_PASSED) {
    return failureOf(new DOMException('deadline exceeded', 'TimeoutError'), started, ctx);
  }
  if (priorRecord !== undefined && answers(priorRecord, ctx)) return priorRecord;
  const sent = send(ctx);
  memo.entries.set(
    key,
    sent.then((record) => {
      const kept = retained(record, memo);
      return priorRecord !== undefined && coverage(priorRecord) > coverage(kept) ? priorRecord : kept;
    }),
  );
  return sent;
}

/** The record of a response the target sent, its body read as far as `ctx` needs. */
export async function answerOf(response: Response, started: number, ctx: HopContext): Promise<HopRecord> {
  const headers = lowercased(response.headers);
  const headersMs = Date.now() - started;
  const status = response.status;
  const bodyCap = readsBody({ status, headers }, ctx) ? ctx.bodyCap : 0;
  try {
    const read = await readBytes(response, bodyCap);
    const elapsedMs = Date.now() - started;
    return {
      kind: 'answer',
      status,
      headers,
      headersMs,
      bytes: read.bytes,
      bodyCap,
      truncated: read.truncated,
      elapsedMs,
    };
  } catch (err) {
    // The status and headers arrived before the body failed, so a caller
    // that reads only the status is still answered by them.
    const bodyError = hopError(err, started, ctx);
    return {
      kind: 'answer',
      status,
      headers,
      headersMs,
      bytes: new Uint8Array(0),
      bodyCap: 0,
      truncated: false,
      elapsedMs: bodyError.elapsedMs,
      bodyError,
    };
  }
}

/** The record of a request that got no response. */
export function failureOf(err: unknown, started: number, ctx: HopContext): HopFailure {
  return { kind: 'failure', error: hopError(err, started, ctx) };
}

function hopError(err: unknown, started: number, ctx: HopContext): HopError {
  const timedOut = err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
  return {
    message: timedOut ? 'TimeoutError: deadline exceeded' : errMsg(err),
    timedOut,
    elapsedMs: Date.now() - started,
    budgetMs: ctx.deadlineAt - started,
  };
}

function lowercased(source: Headers): Record<string, string> {
  const headers: Record<string, string> = {};
  source.forEach((value, name) => {
    headers[name.toLowerCase()] = value;
  });
  return headers;
}

async function readBytes(
  response: Response,
  maxBodyBytes: number | undefined,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (maxBodyBytes === 0) {
    if (response.body) {
      try {
        await response.body.cancel();
      } catch {
        // Already locked or closed.
      }
    }
    return { bytes: new Uint8Array(0), truncated: false };
  }
  if (maxBodyBytes === undefined) {
    return { bytes: new Uint8Array(await response.arrayBuffer()), truncated: false };
  }
  const reader = response.body?.getReader();
  if (!reader) return { bytes: new Uint8Array(0), truncated: false };
  const chunks: Uint8Array[] = [];
  let received = 0;
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    const remaining = maxBodyBytes - received;
    if (remaining <= 0) {
      truncated = true;
      await reader.cancel();
      break;
    }
    if (value.byteLength > remaining) {
      chunks.push(value.slice(0, remaining));
      received = maxBodyBytes;
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(value);
    received += value.byteLength;
  }
  let total = 0;
  for (const chunk of chunks) total += chunk.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes: out, truncated };
}

function errMsg(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}
