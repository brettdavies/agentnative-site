// The one admission sequence a transact POST passes on either lane, run
// only after the unmetered tiers (registry, cache, in-flight) have had
// their say:
//
//   1. lane kill switch ........ CLI: SCORE_KV `scoring_disabled` (absent = on)
//                                web: WEB_AUDIT_ENABLED var (absent = off)
//   2. siteverify .............. missing or rejected token -> 403 turnstile_failed
//                                timeout, transport, non-2xx, malformed,
//                                missing secret -> 503 turnstile_unavailable
//   3. client identity ......... no cf-connecting-ip -> denied; IPv6 keyed by /48
//   4. session ................. read the __Host-anc-session cookie or mint one
//   5. session limiter ......... lane's binding, keyed <sid>:<sha256(target)>
//   6. IP limiter .............. lane's binding, keyed by the client key
//   7. hourly window ........... SCORE_KV `audit:<lane>:<ip>:<hour>` (30 per lane)
//
// Fail-closed rules: a missing limiter or KV binding is
// service_misconfigured, never a skipped gate. The kill-switch polarities
// differ by lane and are recorded, not unified.

import { type AuditErrorObject, auditErrorFor, CTA_RETRY } from '../../shared/audit-events';
import type { Lane } from '../../shared/audit-routes';
import { sha256Hex } from '../audit-web/cache';
import { consumeHourlyBucketBudget } from '../audit-web/limiter';
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
  | ({ ok: false; status: number; retryAfter?: number } & AuditErrorObject);

const HOURLY_CEILING = 30;
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

function deny(status: number, error: AuditErrorObject, retryAfter?: number): Admission {
  return retryAfter === undefined ? { ok: false, status, ...error } : { ok: false, status, retryAfter, ...error };
}

function misconfigured(details: string): Admission {
  return deny(500, auditErrorFor('service_misconfigured', { cta: CTA_LOCAL, details }));
}

function consumeHourlyWindow(kv: KVNamespace, lane: Lane, ip: string): Promise<boolean> {
  return consumeHourlyBucketBudget(kv, `audit:${lane}`, ip, HOURLY_CEILING);
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
        KILL_SWITCH_RETRY_AFTER_SECONDS,
      );
    }
  } else if (env.WEB_AUDIT_ENABLED !== 'true') {
    return deny(
      503,
      auditErrorFor('web_audit_disabled', { cta: CTA_RETRY, retry_after: KILL_SWITCH_RETRY_AFTER_SECONDS }),
      KILL_SWITCH_RETRY_AFTER_SECONDS,
    );
  }

  const ipHeader = request.headers.get('cf-connecting-ip');
  const verify = await verifyTurnstile(env, input.token, {
    fetcher: deps.turnstileFetch,
    remoteIp: ipHeader ?? undefined,
    timeoutMs: deps.siteverifyTimeoutMs,
  });
  if (!verify.ok) {
    if (verify.reason === 'misconfigured') return misconfigured('TURNSTILE_SECRET missing');
    if (isVerifyUnavailable(verify.reason)) {
      return deny(
        503,
        auditErrorFor('turnstile_unavailable', {
          cta: CTA_RETRY,
          retry_after: TURNSTILE_RETRY_AFTER_SECONDS,
          details: verify.reason,
        }),
        TURNSTILE_RETRY_AFTER_SECONDS,
      );
    }
    return deny(403, auditErrorFor('turnstile_failed', { cta: CTA_RETRY }));
  }

  const ip = clientIpKey(ipHeader);
  if (!ip) return deny(403, auditErrorFor('turnstile_failed', { cta: CTA_RETRY, details: 'no client address' }));

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
  if (!sessionLimiter || !ipLimiter) return misconfigured(`${lane} limiter binding missing`);

  const limited = (): Admission =>
    deny(
      429,
      auditErrorFor('rate_limited', { cta: CTA_RETRY, retry_after: RATE_LIMIT_RETRY_AFTER_SECONDS }),
      RATE_LIMIT_RETRY_AFTER_SECONDS,
    );
  try {
    const session = await sessionLimiter.limit({ key: `${sid}:${await sha256Hex(input.target)}` });
    if (!session.success) return limited();
    const perIp = await ipLimiter.limit({ key: ip });
    if (!perIp.success) return limited();
    if (!(await consumeHourlyWindow(env.SCORE_KV, lane, ip))) return limited();
  } catch (err) {
    return misconfigured(`limiter failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return { ok: true, sid, setCookie, ip };
}
