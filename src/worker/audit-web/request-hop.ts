// The per-audit memo of what the target answered, one redirect hop at a
// time, keyed on what the target sees (method, URL, headers, body), so a
// caller's redirect or body-cap policy never turns one question into two
// requests. Every caller gets the status and headers as soon as they
// arrive; a caller that does not need the body (a status-only probe, a
// redirect it follows) returns then, while the memo keeps reading the body
// for a later caller that does. A request goes out again only when the
// answer on record cannot serve the caller: it holds less of the body than
// the caller reads, or it would not have reached the caller by its
// deadline. Nothing here reaches the network: guardedFetch sends each hop
// and hands this module the response.

export const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

// The memo keeps a body up to MEMO_BODY_MAX_BYTES for later callers, and
// no more than MEMO_TOTAL_MAX_BYTES across the audit, so a target serving
// large bodies at every path cannot make one audit hold tens of megabytes
// in an isolate other audits share. A body past either cap still reaches
// the caller that read it; a later caller that needs it asks again. A body
// read for the memo alone stops at MEMO_BODY_MAX_BYTES.
const MEMO_BODY_MAX_BYTES = 1024 * 1024;
const MEMO_TOTAL_MAX_BYTES = 8 * 1024 * 1024;

const DECODER = new TextDecoder();

export type HopRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
};

/** Why a request or its body read got no further, and when (Date.now() milliseconds). */
type HopError = { message: string; timedOut: boolean; startedAt: number; endedAt: number; deadlineAt: number };

type HopAnswer = {
  kind: 'answer';
  status: number;
  /** Response headers with lowercased names. */
  headers: Record<string, string>;
  /** When the request went out, in Date.now() milliseconds. */
  startedAt: number;
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

/** One stage of an answer, and whether it had settled when a caller joined. */
type Stage = { record: Promise<HopRecord>; settled: boolean };

/**
 * One identical request's answer: `headers` settles as soon as the status
 * and headers are known, `full` once the body read ends. `extend` pushes
 * the memo's own body read back to a later deadline.
 */
type MemoEntry = { headers: Stage; full: Stage; extend: (deadlineAt: number) => void };

/** What one audit's memo did with the hops it saw and the bodies it was handed. */
export type MemoStats = {
  /** Hops sent to the target. */
  sent: number;
  /** Hops answered from a record instead of sent. */
  reused: number;
  /** Body bytes kept against MEMO_TOTAL_MAX_BYTES; a record a better one replaced still counts. */
  retainedBytes: number;
  /** Non-empty bodies kept. */
  bodiesRetained: number;
  largestBodyBytes: number;
  /** Bodies not kept for being over MEMO_BODY_MAX_BYTES. */
  overBodyCap: number;
  /** Bodies not kept because the audit's total would pass MEMO_TOTAL_MAX_BYTES. */
  overTotalCap: number;
  /** Body reads the memo runs on its own that have not ended; their bytes are not in `retainedBytes` yet. */
  readsOpen: number;
};

/** One audit's answers, keyed by the request that produced them. */
export type RequestMemo = { entries: Map<string, MemoEntry>; stats: MemoStats };

/**
 * One sent hop: the record as of the headers, the record once the body read
 * ends, whether the sending caller reads that body, and, for a body read
 * the memo runs on its own, a way to push its deadline back.
 */
export type SentHop = {
  head: HopRecord;
  full: Promise<HopRecord>;
  readsBody: boolean;
  extend?: (deadlineAt: number) => void;
};

export function createRequestMemo(): RequestMemo {
  return {
    entries: new Map(),
    stats: {
      sent: 0,
      reused: 0,
      retainedBytes: 0,
      bodiesRetained: 0,
      largestBodyBytes: 0,
      overBodyCap: 0,
      overTotalCap: 0,
      readsOpen: 0,
    },
  };
}

export type HopContext = {
  /** When this hop began, in Date.now() milliseconds; the caller's budget for it runs from here. */
  startedAt: number;
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
 * Whether something that took `tookMs` and arrived at `arrivedAt` reaches
 * the caller as its own request would have. One that settled while the
 * caller waited reached it by its deadline; one already on record when the
 * caller joined fits when the time it took fits the caller's budget.
 */
function inTime(tookMs: number, arrivedAt: number, waited: boolean, ctx: HopContext): boolean {
  return waited ? arrivedAt <= ctx.deadlineAt : tookMs <= ctx.deadlineAt - ctx.startedAt;
}

/**
 * Whether a recorded error answers the caller as its own request would
 * have. A timeout already on record answers a caller whose budget is no
 * longer than the one that ran out; a timeout that ran out while the caller
 * waited ended before the caller's deadline, so its own request still has
 * time. Any other error answers when it arrived in time.
 */
function errorAnswers(error: HopError, waited: boolean, ctx: HopContext): boolean {
  if (!error.timedOut) return inTime(error.endedAt - error.startedAt, error.endedAt, waited, ctx);
  return !waited && ctx.deadlineAt - ctx.startedAt <= error.deadlineAt - error.startedAt;
}

/** Whether a stored record answers a caller with `ctx`'s deadline and body cap as a request of its own would have. */
function answers(record: HopRecord, waited: boolean, ctx: HopContext): boolean {
  if (record.kind === 'failure') return errorAnswers(record.error, waited, ctx);
  if (!readsBody(record, ctx)) return inTime(record.headersMs, record.startedAt + record.headersMs, waited, ctx);
  if (record.bodyError !== undefined) return errorAnswers(record.bodyError, waited, ctx);
  return (
    inTime(record.elapsedMs, record.startedAt + record.elapsedMs, waited, ctx) && bodyOf(record, ctx.bodyCap) !== null
  );
}

/** How much of the body a record can serve: nothing (a failure), up to its cap, or all of it. */
function coverage(record: HopRecord): number {
  if (record.kind === 'failure') return -1;
  if (!record.truncated && record.bodyCap !== 0) return Number.POSITIVE_INFINITY;
  return record.bodyCap ?? Number.POSITIVE_INFINITY;
}

/** The record the memo keeps for later callers: the body only while it fits under both caps. */
function retained(record: HopRecord, stats: MemoStats): HopRecord {
  if (record.kind === 'failure') return record;
  const size = record.bytes.byteLength;
  if (size > MEMO_BODY_MAX_BYTES) {
    stats.overBodyCap += 1;
  } else if (stats.retainedBytes + size > MEMO_TOTAL_MAX_BYTES) {
    stats.overTotalCap += 1;
  } else {
    stats.retainedBytes += size;
    if (size > 0) stats.bodiesRetained += 1;
    stats.largestBodyBytes = Math.max(stats.largestBodyBytes, size);
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

function timedOutFor(ctx: HopContext): HopFailure {
  return failureOf(new DOMException('deadline exceeded', 'TimeoutError'), ctx.startedAt, ctx.deadlineAt);
}

/** `record` as a stage that notes when it settles. */
function stage(record: Promise<HopRecord>): Stage {
  const tracked: Stage = { record, settled: false };
  void record.then(() => {
    tracked.settled = true;
  });
  return tracked;
}

/** The stage's record once it settles within the caller's deadline, and whether the caller had to wait for it. */
async function settle(at: Stage, ctx: HopContext): Promise<{ record: HopRecord; waited: boolean } | null> {
  const waited = !at.settled;
  const record = await withinDeadline(at.record, ctx.signal);
  return record === DEADLINE_PASSED ? null : { record, waited };
}

/**
 * The answer to `request`: what an identical request already got this audit
 * when that answers the caller, else whatever `send` gets from the target.
 * A caller waiting on an identical request still in flight, or on the
 * memo's read of its body, waits no longer than its own deadline, and
 * pushes the memo's read back to that deadline so the wait gives the body
 * the time the caller's own request would have. A new answer that serves
 * less than the one on record (a failure, or less of the body) goes to this
 * caller only; the memo keeps the better one.
 */
export async function takeHop(
  request: HopRequest,
  ctx: HopContext,
  send: (ctx: HopContext) => Promise<SentHop>,
): Promise<HopRecord> {
  const memo = ctx.memo;
  if (memo === undefined) {
    const hop = await send(ctx);
    return hop.readsBody ? hop.full : hop.head;
  }
  const key = keyOf(request);
  const prior = memo.entries.get(key);
  let priorRecord: HopRecord | undefined;
  if (prior !== undefined) {
    const head = await settle(prior.headers, ctx);
    if (head === null) return timedOutFor(ctx);
    if (answers(head.record, head.waited, ctx)) {
      memo.stats.reused += 1;
      return head.record;
    }
    prior.extend(ctx.deadlineAt);
    const full = await settle(prior.full, ctx);
    if (full === null) return timedOutFor(ctx);
    if (answers(full.record, full.waited, ctx)) {
      memo.stats.reused += 1;
      return full.record;
    }
    if (Date.now() >= ctx.deadlineAt) return timedOutFor(ctx);
    priorRecord = full.record;
  }
  memo.stats.sent += 1;
  const sent = send(ctx);
  const full = sent
    .then((hop) => hop.full)
    .then((answer) => {
      const kept = retained(answer, memo.stats);
      return priorRecord !== undefined && coverage(priorRecord) > coverage(kept) ? priorRecord : kept;
    });
  memo.entries.set(key, {
    headers: stage(sent.then((hop) => (hop.head.kind === 'failure' ? full : hop.head))),
    full: stage(full),
    extend: (deadlineAt) => {
      void sent.then((hop) => hop.extend?.(deadlineAt));
    },
  });
  const hop = await sent;
  return hop.readsBody ? hop.full : hop.head;
}

/**
 * The hop for a response the target sent: the status and headers at once,
 * and the body read as far as the caller needs. A caller that skips the
 * body leaves it to the memo, which reads up to MEMO_BODY_MAX_BYTES within
 * the caller's deadline, pushed back when a later caller waits on it.
 */
export function answerOf(response: Response, ctx: HopContext): SentHop {
  const started = ctx.startedAt;
  const headers = lowercased(response.headers);
  const head: HopAnswer = {
    kind: 'answer',
    status: response.status,
    headers,
    startedAt: started,
    headersMs: Date.now() - started,
    bytes: new Uint8Array(0),
    bodyCap: 0,
    truncated: false,
    elapsedMs: Date.now() - started,
  };
  if (readsBody(head, ctx)) {
    const full = bodyRecord(
      head,
      () => readBytes(response, ctx.bodyCap),
      ctx.bodyCap,
      () => ctx.deadlineAt,
    );
    return { head, full, readsBody: true };
  }
  if (ctx.memo === undefined) {
    return { head, full: readBytes(response, 0).then(() => head), readsBody: false };
  }
  const stats = ctx.memo.stats;
  const deadline: MovableDeadline = { at: ctx.deadlineAt, moved: new Set() };
  stats.readsOpen += 1;
  const full = bodyRecord(
    head,
    () => readBytes(response, MEMO_BODY_MAX_BYTES, deadline),
    MEMO_BODY_MAX_BYTES,
    () => deadline.at,
  ).finally(() => {
    stats.readsOpen -= 1;
  });
  const extend = (deadlineAt: number): void => {
    if (deadlineAt <= deadline.at) return;
    deadline.at = deadlineAt;
    for (const rearm of deadline.moved) rearm();
  };
  return { head, full, readsBody: false, extend };
}

/** The hop for a request that got no response. */
export function failedHop(err: unknown, ctx: HopContext): SentHop {
  const head = failureOf(err, ctx.startedAt, ctx.deadlineAt);
  return { head, full: Promise.resolve(head), readsBody: false };
}

/**
 * The answer record once its body read ends. When the read fails after the
 * status and headers arrived, they still answer a caller that reads only
 * the status, and the failure answers a caller that needs the body.
 */
async function bodyRecord(
  head: HopAnswer,
  read: () => Promise<{ bytes: Uint8Array; truncated: boolean }>,
  bodyCap: number | undefined,
  deadlineAt: () => number,
): Promise<HopAnswer> {
  try {
    const { bytes, truncated } = await read();
    return { ...head, bytes, bodyCap, truncated, elapsedMs: Date.now() - head.startedAt };
  } catch (err) {
    const bodyError = hopError(err, head.startedAt, deadlineAt());
    return { ...head, elapsedMs: bodyError.endedAt - head.startedAt, bodyError };
  }
}

function failureOf(err: unknown, started: number, deadlineAt: number): HopFailure {
  return { kind: 'failure', error: hopError(err, started, deadlineAt) };
}

function hopError(err: unknown, started: number, deadlineAt: number): HopError {
  const timedOut = err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
  return {
    message: timedOut ? 'TimeoutError: deadline exceeded' : errMsg(err),
    timedOut,
    startedAt: started,
    endedAt: Date.now(),
    deadlineAt,
  };
}

function lowercased(source: Headers): Record<string, string> {
  const headers: Record<string, string> = {};
  source.forEach((value, name) => {
    headers[name.toLowerCase()] = value;
  });
  return headers;
}

/** A deadline a later caller can push back; each running read re-arms its timer through `moved`. */
type MovableDeadline = { at: number; moved: Set<() => void> };

/**
 * The body up to `maxBodyBytes`. `deadline` bounds a read nothing else
 * aborts (the memo's read after its caller has returned): when it passes,
 * the read stops with a TimeoutError.
 */
async function readBytes(
  response: Response,
  maxBodyBytes: number | undefined,
  deadline?: MovableDeadline,
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
  let deadlinePassed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = (): void => {
    if (deadline === undefined) return;
    clearTimeout(timer);
    timer = setTimeout(
      () => {
        deadlinePassed = true;
        reader.cancel().catch(() => {});
      },
      Math.max(0, deadline.at - Date.now()),
    );
  };
  arm();
  deadline?.moved.add(arm);
  try {
    return await readChunks(reader, maxBodyBytes, () => deadlinePassed);
  } finally {
    clearTimeout(timer);
    deadline?.moved.delete(arm);
  }
}

async function readChunks(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  maxBodyBytes: number,
  deadlinePassed: () => boolean,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const chunks: Uint8Array[] = [];
  let received = 0;
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (deadlinePassed()) throw new DOMException('deadline exceeded', 'TimeoutError');
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
