// Cloudflare Turnstile siteverify wrapper. The Worker POSTs the client's
// token (with the secret) to challenges.cloudflare.com under a bounded
// deadline and reports a typed verdict. Two verdict classes matter to
// callers: the visitor's token was refused (`missing_token`, `rejected`),
// or verification itself could not be completed (`timeout`,
// `transport_error`, `malformed`), which is the provider's problem and
// must never be reported to the visitor as their failure.
//
// Invisible mode and lazy loading are client-side decisions; this module
// only validates whatever token the client sends.

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/** Siteverify answers in well under a second; anything past this is an outage, not a slow answer. */
export const SITEVERIFY_TIMEOUT_MS = 5_000;

export type TurnstileEnv = {
  TURNSTILE_SECRET?: string;
};

export type VerifyRejection = 'missing_token' | 'rejected';
export type VerifyUnavailable = 'timeout' | 'transport_error' | 'malformed';

export type VerifyResult = { ok: true } | { ok: false; reason: 'misconfigured' | VerifyRejection | VerifyUnavailable };

export type VerifyReason = 'misconfigured' | VerifyRejection | VerifyUnavailable;

/** True for the verdicts that mean verification could not be completed rather than that the token was refused. */
export function isVerifyUnavailable(reason: VerifyReason): reason is VerifyUnavailable {
  return reason === 'timeout' || reason === 'transport_error' || reason === 'malformed';
}

export type VerifyOpts = {
  /** Injectable for tests; defaults to globalThis.fetch. */
  fetcher?: typeof fetch;
  /** Remote IP from the request (CF-Connecting-IP); optional but Cloudflare-recommended. */
  remoteIp?: string;
  /** Deadline for the siteverify call; defaults to SITEVERIFY_TIMEOUT_MS. */
  timeoutMs?: number;
};

export async function verifyTurnstile(
  env: TurnstileEnv,
  token: string | null | undefined,
  opts: VerifyOpts = {},
): Promise<VerifyResult> {
  if (!env.TURNSTILE_SECRET) return { ok: false, reason: 'misconfigured' };
  if (!token) return { ok: false, reason: 'missing_token' };

  const fetcher = opts.fetcher ?? globalThis.fetch.bind(globalThis);
  const body = new FormData();
  body.set('secret', env.TURNSTILE_SECRET);
  body.set('response', token);
  if (opts.remoteIp) body.set('remoteip', opts.remoteIp);

  // The deadline is raced as well as signalled: a fetcher that ignores
  // the abort signal must still resolve to a timeout verdict.
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve('timeout');
    }, opts.timeoutMs ?? SITEVERIFY_TIMEOUT_MS);
  });
  const attempt = (async (): Promise<VerifyResult> => {
    let res: Response;
    try {
      res = await fetcher(SITEVERIFY_URL, { method: 'POST', body, signal: controller.signal });
    } catch {
      return { ok: false, reason: controller.signal.aborted ? 'timeout' : 'transport_error' };
    }
    if (!res.ok) return { ok: false, reason: 'transport_error' };
    const parsed = (await res.json().catch(() => null)) as { success?: boolean } | null;
    if (!parsed || typeof parsed.success !== 'boolean') return { ok: false, reason: 'malformed' };
    return parsed.success ? { ok: true } : { ok: false, reason: 'rejected' };
  })();
  try {
    const outcome = await Promise.race([attempt, deadline]);
    return outcome === 'timeout' ? { ok: false, reason: 'timeout' } : outcome;
  } finally {
    clearTimeout(timer);
  }
}
