// Cloudflare Turnstile siteverify wrapper.
//
// Plan U5 (docs/plans/2026-04-28-002-feat-live-scoring-cf-sandbox-plan.md
// "Cost ceiling and abuse mitigation" step 1 + U5 handler step 4): the U8
// form submits a `turnstile_token` in the POST body. The Worker POSTs it
// (with the secret) to challenges.cloudflare.com/turnstile/v0/siteverify.
// Failure → 400 with `turnstile_failed`. Success → caller may set the
// session cookie.
//
// Invisible-mode (no checkbox) + lazy-load are U8 client-side decisions;
// this module only validates whatever token the client sends.

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export type TurnstileEnv = {
  TURNSTILE_SECRET?: string;
};

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: 'misconfigured' | 'missing_token' | 'rejected' | 'transport_error' };

export class TurnstileConfigError extends Error {
  constructor() {
    super('TURNSTILE_SECRET not configured');
    this.name = 'TurnstileConfigError';
  }
}

export type VerifyOpts = {
  /** Injectable for tests; defaults to globalThis.fetch. */
  fetcher?: typeof fetch;
  /** Remote IP from the request (CF-Connecting-IP); optional but Cloudflare-recommended. */
  remoteIp?: string;
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

  let res: Response;
  try {
    res = await fetcher(SITEVERIFY_URL, { method: 'POST', body });
  } catch {
    return { ok: false, reason: 'transport_error' };
  }
  if (!res.ok) return { ok: false, reason: 'transport_error' };

  const parsed = (await res.json().catch(() => null)) as { success?: boolean } | null;
  if (!parsed || parsed.success !== true) return { ok: false, reason: 'rejected' };
  return { ok: true };
}
