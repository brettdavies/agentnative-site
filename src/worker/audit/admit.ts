// The one admission sequence a transact POST passes on either lane, run
// only after the unmetered tiers (registry, cache, in-flight) have had
// their say:
//
//   1. lane kill switch ........ CLI: SCORE_KV `scoring_disabled` (absent = on)
//                                web: WEB_AUDIT_ENABLED var (absent = off)
//   2. client identity ......... no cf-connecting-ip -> denied before the
//                                token is spent; IPv6 keyed by /48
//   3. siteverify .............. missing or rejected token -> 403 turnstile_failed
//                                timeout, transport, non-2xx, malformed,
//                                missing secret -> 503 turnstile_unavailable
//   4. session ................. read the __Host-anc-session cookie or mint one
//   5. session limiter ......... lane's binding, keyed <sid>:<sha256(target)>
//   6. IP limiter .............. lane's binding, keyed by the client key
//   7. hourly window ........... the lane's shared bucket (30 per lane), the
//                                one the legacy route and the MCP tool draw
//
// Fail-closed rules: a missing limiter or KV binding is
// service_misconfigured, never a skipped gate. The kill-switch polarities
// differ by lane and are recorded, not unified. A denial after the session
// mint still carries the Set-Cookie. The verifier's reason and the binding
// names never reach the body: `detail` is the server-side field the
// request row logs.

import { type AuditErrorObject, auditErrorFor, CTA_RETRY } from '../../shared/audit-events';
import type { Lane } from '../../shared/audit-routes';
import { sha256Hex } from '../audit-web/cache';
import { consumeLaneHourlyBudget } from '../audit-web/limiter';
import { isScoringDisabled } from '../score/kill-switch';
import { CTA } from '../score/response-shape';
import { issue, newSession, read as readSession, SessionConfigError, type SessionEnv } from '../score/session';
import { isVerifyUnavailable, type TurnstileEnv, verifyTurnstile } from '../score/turnstile';

export type RateLimit = { limit(o: { key: string }): Promise<{ success: boolean }> };

export type AdmitEnv = TurnstileEnv &
  SessionEnv & {
    SCORE_KV?: KVNamespace;
    SCORE_LIMITER?: RateLimit;
    SCORE_LIMITER_IP?: RateLimit;
    WEB_AUDIT_LIMITER?: RateLimit;
    WEB_AUDIT_LIMITER_IP?: RateLimit;
    WEB_AUDIT_ENABLED?: string;
  };

export type AdmitDeps = {
  /** Injected siteverify fetch for tests; production uses global fetch. */
  turnstileFetch?: typeof fetch;
  siteverifyTimeoutMs?: number;
};

export type AdmitInput = {
  lane: Lane;
  request: Request;
  token: string | null;
  /** The normalized target, the session limiter's key material. */
  target: string;
  env: AdmitEnv;
  deps?: AdmitDeps;
};

export type Admission =
  | { ok: true; sid: string; setCookie: string | null; ip: string }
  | ({
      ok: false;
      status: number;
      retryAfter?: number;
      setCookie: string | null;
      /** Server-side only: the verifier reason or the missing binding. */
      detail?: string;
    } & AuditErrorObject);

type DenyOptions = { retryAfter?: number; setCookie?: string | null; detail?: string };

const TURNSTILE_RETRY_AFTER_SECONDS = 30;
const RATE_LIMIT_RETRY_AFTER_SECONDS = 60;
const KILL_SWITCH_RETRY_AFTER_SECONDS = 3600;

const CTA_LOCAL = CTA.installAnc;

/**
 * The rate-limit key for a client address: IPv4 as-is, IPv6 collapsed to
 * its /48 so one subscriber prefix cannot rotate through addresses; null
 * when the address is absent.
 */
export function clientIpKey(address: string | null | undefined): string | null {
  const ip = address?.trim();
  if (!ip) return null;
  if (!ip.includes(':')) return ip;
  const bare = ip.replace(/^\[|\]$/g, '').toLowerCase();
  const [head] = bare.split('::');
  const groups = head.split(':').filter((g) => g !== '');
  const prefix = [0, 1, 2].map((i) => (groups[i] ?? '0').replace(/^0+(?=\w)/, ''));
  return `${prefix.join(':')}::/48`;
}

function deny(status: number, error: AuditErrorObject, opts: DenyOptions = {}): Admission {
  const admission: Admission = { ok: false, status, setCookie: opts.setCookie ?? null, ...error };
  if (opts.retryAfter !== undefined) admission.retryAfter = opts.retryAfter;
  if (opts.detail !== undefined) admission.detail = opts.detail;
  return admission;
}

function misconfigured(detail: string, setCookie: string | null = null): Admission {
  return deny(500, auditErrorFor('service_misconfigured', { cta: CTA_LOCAL }), { detail, setCookie });
}

export async function admitTransact(input: AdmitInput): Promise<Admission> {
  const { lane, request, env } = input;
  const deps = input.deps ?? {};

  if (!env.SCORE_KV) return misconfigured('SCORE_KV binding missing');
  if (lane === 'cli') {
    if (await isScoringDisabled({ SCORE_KV: env.SCORE_KV })) {
      return deny(
        503,
        auditErrorFor('scoring_disabled', { cta: CTA_LOCAL, retry_after: KILL_SWITCH_RETRY_AFTER_SECONDS }),
        { retryAfter: KILL_SWITCH_RETRY_AFTER_SECONDS },
      );
    }
  } else if (env.WEB_AUDIT_ENABLED !== 'true') {
    return deny(
      503,
      auditErrorFor('web_audit_disabled', { cta: CTA_RETRY, retry_after: KILL_SWITCH_RETRY_AFTER_SECONDS }),
      { retryAfter: KILL_SWITCH_RETRY_AFTER_SECONDS },
    );
  }

  const ipHeader = request.headers.get('cf-connecting-ip');
  const ip = clientIpKey(ipHeader);
  if (!ip) return deny(403, auditErrorFor('turnstile_failed', { cta: CTA_RETRY }), { detail: 'no client address' });

  const verify = await verifyTurnstile(env, input.token, {
    fetcher: deps.turnstileFetch,
    remoteIp: ipHeader ?? undefined,
    timeoutMs: deps.siteverifyTimeoutMs,
  });
  if (!verify.ok) {
    if (verify.reason === 'misconfigured' || isVerifyUnavailable(verify.reason)) {
      return deny(
        503,
        auditErrorFor('turnstile_unavailable', { cta: CTA_RETRY, retry_after: TURNSTILE_RETRY_AFTER_SECONDS }),
        {
          retryAfter: TURNSTILE_RETRY_AFTER_SECONDS,
          detail: verify.reason === 'misconfigured' ? 'TURNSTILE_SECRET missing' : verify.reason,
        },
      );
    }
    return deny(403, auditErrorFor('turnstile_failed', { cta: CTA_RETRY }), { detail: verify.reason });
  }

  let sid: string;
  let setCookie: string | null = null;
  try {
    const existing = await readSession(env, request);
    if (existing) {
      sid = existing.sid;
    } else {
      const fresh = newSession();
      setCookie = await issue(env, fresh);
      sid = fresh.sid;
    }
  } catch (err) {
    if (err instanceof SessionConfigError) return misconfigured('SESSION_HMAC_SECRET missing');
    throw err;
  }

  const sessionLimiter = lane === 'cli' ? env.SCORE_LIMITER : env.WEB_AUDIT_LIMITER;
  const ipLimiter = lane === 'cli' ? env.SCORE_LIMITER_IP : env.WEB_AUDIT_LIMITER_IP;
  if (!sessionLimiter || !ipLimiter) return misconfigured(`${lane} limiter binding missing`, setCookie);

  const limited = (): Admission =>
    deny(429, auditErrorFor('rate_limited', { cta: CTA_RETRY, retry_after: RATE_LIMIT_RETRY_AFTER_SECONDS }), {
      retryAfter: RATE_LIMIT_RETRY_AFTER_SECONDS,
      setCookie,
    });
  try {
    const session = await sessionLimiter.limit({ key: `${sid}:${await sha256Hex(input.target)}` });
    if (!session.success) return limited();
    const perIp = await ipLimiter.limit({ key: ip });
    if (!perIp.success) return limited();
    if (!(await consumeLaneHourlyBudget(env.SCORE_KV, lane, ip))) return limited();
  } catch (err) {
    return misconfigured(`limiter failed: ${err instanceof Error ? err.message : String(err)}`, setCookie);
  }

  return { ok: true, sid, setCookie, ip };
}
