// Signed `__Host-anc-session` cookie — issue, parse, verify.
//
// Plan U5 (docs/plans/2026-04-28-002-feat-live-scoring-cf-sandbox-plan.md
// "Cost ceiling and abuse mitigation" step 2): after a Turnstile solve,
// the Worker sets a signed session cookie. The cookie value identifies
// the session for `SCORE_LIMITER` rekeying: the limiter key is
// `<session-id>:<sha256(input)>` so same-tool requests within a session
// don't burn rate-limit budget.
//
// Cookie format:
//   __Host-anc-session=<sid>.<expEpochSec>.<sigBase64Url>
//
// where `sigBase64Url = HMAC-SHA256(sid + "." + expEpochSec)` using
// `env.SESSION_HMAC_SECRET`. Constant-time signature comparison.
//
// `__Host-` prefix requires Secure, Path=/, no Domain. Combined with
// HttpOnly + SameSite=Lax this is the strict-cookie shape per OWASP
// session-management guidance.

const COOKIE_NAME = '__Host-anc-session';
const COOKIE_TTL_SEC = 60 * 60; // 1 h, per plan
const SID_BYTES = 16;

export type SessionEnv = {
  SESSION_HMAC_SECRET?: string;
};

export type Session = { sid: string; expiresAt: number };

export class SessionConfigError extends Error {
  constructor() {
    super('SESSION_HMAC_SECRET not configured');
    this.name = 'SessionConfigError';
  }
}

/** Generate a fresh session payload (no signature yet — see issue()). */
export function newSession(nowMs: number = Date.now()): Session {
  const bytes = new Uint8Array(SID_BYTES);
  crypto.getRandomValues(bytes);
  return {
    sid: base64Url(bytes),
    expiresAt: Math.floor(nowMs / 1000) + COOKIE_TTL_SEC,
  };
}

/** Build the Set-Cookie header value for a fresh session. */
export async function issue(env: SessionEnv, session: Session): Promise<string> {
  const secret = requireSecret(env);
  const payload = `${session.sid}.${session.expiresAt}`;
  const sig = await sign(secret, payload);
  const value = `${payload}.${sig}`;
  return `${COOKIE_NAME}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${COOKIE_TTL_SEC}`;
}

/**
 * Parse + verify the session cookie from a request. Returns the session on
 * success, `null` on missing/expired/tampered cookie. Constant-time signature
 * comparison via Web Crypto.
 */
export async function read(env: SessionEnv, request: Request, nowMs: number = Date.now()): Promise<Session | null> {
  const secret = requireSecret(env);
  const cookieHeader = request.headers.get('cookie');
  if (!cookieHeader) return null;

  const raw = extractCookie(cookieHeader, COOKIE_NAME);
  if (!raw) return null;

  const parts = raw.split('.');
  if (parts.length !== 3) return null;
  const [sid, expStr, sig] = parts;

  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp <= Math.floor(nowMs / 1000)) return null;

  const expected = await sign(secret, `${sid}.${expStr}`);
  if (!constantTimeEquals(sig, expected)) return null;

  return { sid, expiresAt: exp };
}

function requireSecret(env: SessionEnv): string {
  if (!env.SESSION_HMAC_SECRET) throw new SessionConfigError();
  return env.SESSION_HMAC_SECRET;
}

async function sign(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return base64Url(new Uint8Array(sig));
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function extractCookie(header: string, name: string): string | null {
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    if (trimmed.slice(0, eq) === name) return trimmed.slice(eq + 1);
  }
  return null;
}

function base64Url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export const _internal = { COOKIE_NAME, COOKIE_TTL_SEC };
