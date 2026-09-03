// Operator failure notifications over Cloudflare Email Service (Email
// Sending, public beta). Fully optional: until the `send_email` binding and
// the ALERT_EMAIL_* vars are provisioned, every call is a no-op, so this
// module is safe to wire ahead of the account-level onboarding (domain
// onboarding + destination-address verification happen in the dashboard;
// steps in docs/runbooks/web-audit-operations.md § Failure notifications).
//
// Sends are deduplicated per alert key through SCORE_KV (one email per key
// per hour) so a hot failure loop cannot flood the inbox or burn through
// the Email Sending quota.

import { emitLog } from './telemetry/log';

// Structural type for the Email Sending Workers binding (env.EMAIL.send with
// a message object). Declared locally because the generated types only carry
// it once the binding exists in wrangler.jsonc.
interface EmailSender {
  send(message: { from: string; to: string; subject: string; text: string }): Promise<unknown>;
}

export interface NotifyEnv {
  EMAIL?: EmailSender;
  ALERT_EMAIL_FROM?: string;
  ALERT_EMAIL_TO?: string;
  SCORE_KV?: KVNamespace;
}

const DEDUPE_TTL_SECONDS = 3600;

/**
 * Email the operator about a failure, at most once per key per hour.
 * Never throws: alerting must not add a second failure to the path that
 * is already failing. Returns 'sent' | 'deduped' | 'unprovisioned' |
 * 'send_failed' so callers and tests can observe the outcome.
 */
export async function notifyFailure(
  env: NotifyEnv,
  alert: { key: string; subject: string; text: string },
): Promise<'sent' | 'deduped' | 'unprovisioned' | 'send_failed'> {
  if (!env.EMAIL || !env.ALERT_EMAIL_FROM || !env.ALERT_EMAIL_TO) return 'unprovisioned';
  const dedupeKey = `alert:${alert.key}`;
  try {
    if (env.SCORE_KV && (await env.SCORE_KV.get(dedupeKey)) !== null) return 'deduped';
    await env.SCORE_KV?.put(dedupeKey, '1', { expirationTtl: DEDUPE_TTL_SECONDS });
  } catch {
    // A KV failure falls through to sending: a duplicate email beats a
    // silently dropped alert.
  }
  try {
    await env.EMAIL.send({
      from: env.ALERT_EMAIL_FROM,
      to: env.ALERT_EMAIL_TO,
      subject: alert.subject,
      text: alert.text,
    });
    return 'sent';
  } catch (err) {
    emitLog(
      { scope: 'notify.send_failed' },
      { key: alert.key, error: err instanceof Error ? err.message : String(err) },
      { level: 'error' },
    );
    return 'send_failed';
  }
}
