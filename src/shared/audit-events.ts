// The NDJSON event union, the error object, and the error-code vocabulary
// every funnel surface shares: the transact endpoint emits them, the
// progress page and the MCP tools consume them.
//
// Nothing here touches a runtime global, so the browser client's tsconfig
// (DOM only, no Workers types) compiles it; the values are tables and
// builders over plain objects.
//
// Wire shapes:
//
//   pre-dispatch failure   JSON body { error: AuditError }, HTTP status by code
//   after `accepted`       one event per line:
//     accepted -> phase* | discovery, check* -> heartbeat* -> complete
//                                                         | incomplete
//                                                         | bounce
//                                                         | error

import type { AuditEnvelope } from './audit-envelope';
import { type Lane, REJECTION_MESSAGES } from './audit-routes';

export type AuditErrorCode =
  // Input the classifier or the lane validator refused.
  | 'target_empty'
  | 'target_too_long'
  | 'target_reserved'
  | 'reserved_branch_segment'
  | 'invalid_target'
  | 'invalid_url'
  | 'non_https_url'
  | 'non_github_host'
  | 'invalid_url_path'
  | 'unrecognized_input'
  | 'unparseable_install_command'
  | 'invalid_body'
  | 'invalid_site_type'
  | 'invalid_public_listing'
  // Admission: bot defense, limiters, kill switches, bindings.
  | 'turnstile_failed'
  | 'turnstile_unavailable'
  | 'rate_limited'
  | 'flip_rate_limited'
  | 'scoring_disabled'
  | 'web_audit_disabled'
  | 'service_misconfigured'
  // Resolution before the sandbox.
  | 'chain_no_resolve'
  | 'github_repo_not_accessible'
  | 'discovery_redirect_loop'
  | 'install_unsupported'
  // The run itself.
  | 'chain_resolved_install_failed'
  | 'chain_resolved_no_binary_produced'
  | 'timeout'
  | 'sandbox_unavailable'
  | 'incomplete_response_contract'
  | 'unreachable'
  | 'patch_failed'
  // A result page or read tool for a target with no stored result.
  | 'not_found';

export type AuditError = {
  code: AuditErrorCode;
  message: string;
  cta: string;
  details?: string;
  retry_after?: number;
  pm?: string;
};

export type AuditErrorObject = { error: AuditError };

export type AuditErrorExtras = { cta: string; details?: string; retry_after?: number; pm?: string };

/** The call to action for a transient failure. */
export const CTA_RETRY = 'Try again in a moment.';

/** The human line for each shared code, the one surface that owns it. */
export const AUDIT_ERROR_MESSAGES: Readonly<Record<AuditErrorCode, string>> = {
  ...REJECTION_MESSAGES,
  invalid_url: 'That input is not a recognized tool, install command, or GitHub URL.',
  non_https_url: "Use https://. The scoring sandbox won't fetch http:// URLs.",
  non_github_host: 'Only public GitHub repos are supported.',
  invalid_url_path: 'Paste the repo root, not a branch or release link. Example: https://github.com/owner/repo.',
  unrecognized_input: 'That input is not a recognized tool, install command, or GitHub URL.',
  unparseable_install_command:
    "That looks like an install command, but the package manager isn't supported. Try cargo, brew, npm, pip, bun, uv, or go.",
  invalid_body: 'The request body must be a JSON object with a target.',
  invalid_site_type: 'That site type is not recognized.',
  invalid_public_listing: 'public_listing must be true or false.',
  turnstile_failed: 'Verification failed. Please try again.',
  turnstile_unavailable: 'Verification is briefly unavailable.',
  rate_limited: 'Too many requests.',
  flip_rate_limited: 'Too many listing changes for this site.',
  scoring_disabled: 'Live scoring is paused.',
  web_audit_disabled: 'The website audit is disabled by the operator.',
  service_misconfigured: "Live scoring is misconfigured on our side. We've been notified.",
  chain_no_resolve: "We couldn't find a pre-built binary for that.",
  github_repo_not_accessible: "GitHub couldn't find that repo.",
  discovery_redirect_loop:
    'GitHub redirected us in a loop while resolving releases. Try again, or paste the exact owner/repo URL.',
  install_unsupported: 'That install path is not supported by the live sandbox.',
  chain_resolved_install_failed: "Found an install path, but it didn't run.",
  chain_resolved_no_binary_produced:
    'We installed it, but no command-line entry point appeared on PATH. anc only scores binaries. If this is wrong, paste the actual binary name as <command> to retry.',
  timeout: 'The scan ran past the time budget.',
  sandbox_unavailable: 'The scoring sandbox is unavailable right now.',
  incomplete_response_contract: 'The scoring service returned an incomplete response.',
  unreachable: 'The site could not be reached.',
  patch_failed: 'The listing change did not save.',
  not_found: 'No audit exists for that target yet.',
};

/** The one error object every JSON error response and every bounce or error event carries. */
export function auditError(code: AuditErrorCode, message: string, extras: AuditErrorExtras): AuditErrorObject {
  const error: AuditError = { code, message, cta: extras.cta };
  if (extras.details !== undefined) error.details = extras.details;
  if (extras.retry_after !== undefined) error.retry_after = extras.retry_after;
  if (extras.pm !== undefined) error.pm = extras.pm;
  return { error };
}

/** `auditError` with the code's shared message. */
export function auditErrorFor(code: AuditErrorCode, extras: AuditErrorExtras): AuditErrorObject {
  return auditError(code, AUDIT_ERROR_MESSAGES[code], extras);
}

/** The CLI lane's legacy `ScoreError` codes, each onto its shared code. */
export const LEGACY_CLI_ERROR_CODES = {
  invalid_url: 'invalid_url',
  non_https_url: 'non_https_url',
  non_github_host: 'non_github_host',
  invalid_url_path: 'invalid_url_path',
  unrecognized_input: 'unrecognized_input',
  unparseable_install_command: 'unparseable_install_command',
  chain_no_resolve: 'chain_no_resolve',
  github_repo_not_accessible: 'github_repo_not_accessible',
  discovery_redirect_loop: 'discovery_redirect_loop',
  rate_limited: 'rate_limited',
  install_unsupported: 'install_unsupported',
  chain_resolved_install_failed: 'chain_resolved_install_failed',
  chain_resolved_no_binary_produced: 'chain_resolved_no_binary_produced',
  timeout: 'timeout',
  turnstile_failed: 'turnstile_failed',
  scoring_disabled: 'scoring_disabled',
  sandbox_stub_until_u6: 'sandbox_unavailable',
  sandbox_unavailable: 'sandbox_unavailable',
  incomplete_response_contract: 'incomplete_response_contract',
  service_misconfigured: 'service_misconfigured',
} as const satisfies Record<string, AuditErrorCode>;

/** The website lane's legacy error strings, each onto its shared code. */
export const LEGACY_WEB_ERROR_CODES = {
  flip_rate_limited: 'flip_rate_limited',
  invalid_body: 'invalid_body',
  invalid_public_listing: 'invalid_public_listing',
  invalid_site_type: 'invalid_site_type',
  invalid_url: 'invalid_target',
  patch_failed: 'patch_failed',
  rate_limit: 'rate_limited',
  service_misconfigured: 'service_misconfigured',
  turnstile_failed: 'turnstile_failed',
  unreachable: 'unreachable',
  web_audit_disabled: 'web_audit_disabled',
} as const satisfies Record<string, AuditErrorCode>;

const LEGACY_TABLES: Record<Lane, Readonly<Record<string, AuditErrorCode>>> = {
  cli: LEGACY_CLI_ERROR_CODES,
  web: LEGACY_WEB_ERROR_CODES,
};

/** The shared code for a lane's legacy error string; throws on a string the table does not name. */
export function auditErrorCodeFor(lane: Lane, legacy: string): AuditErrorCode {
  const table = LEGACY_TABLES[lane];
  if (!Object.hasOwn(table, legacy))
    throw new Error(`no shared error code for ${lane} error ${JSON.stringify(legacy)}`);
  return table[legacy];
}

/** CLI phases in stream order: the endpoint emits `resolving`, the Durable Object the rest. */
export const CLI_PHASES = ['resolving', 'installing', 'installed', 'verifying', 'lockdown', 'auditing'] as const;
export type CliPhase = (typeof CLI_PHASES)[number];

export type AuditEvent =
  | { type: 'accepted'; lane: Lane; target: string; started_at: string }
  | { type: 'phase'; phase: CliPhase; at: string }
  | { type: 'discovery'; mcp_endpoint: string | null }
  | { type: 'check'; id: string; principle: string; keyword: string; status: string; evidence: string | null }
  | { type: 'heartbeat'; at: string }
  | ({ type: 'complete' } & AuditEnvelope)
  | { type: 'incomplete'; scorecard: unknown; reason?: string }
  | ({ type: 'bounce' } & AuditErrorObject)
  | ({ type: 'error' } & AuditErrorObject);

export type CompleteEvent = Extract<AuditEvent, { type: 'complete' }>;

/** The terminal event: the envelope itself, tagged. */
export function completeEvent(envelope: AuditEnvelope): CompleteEvent {
  return { type: 'complete', ...envelope };
}
