// The refusal for a target the SSRF gate refuses as a host, on every surface
// that takes one. The public audit will never contact it; `anc web` audits it
// from a network that can reach it, so the refusal names that command.

import { type AuditErrorObject, auditError } from '../../shared/audit-events';
import { ANC_WEB_DOCS_PATH, localTargetCta } from '../../shared/scoring-copy';
import type { WebTargetRefusal } from './core';
import { ANC_WEB_RELEASED, ancWebCommand } from './provenance-copy';
import { isMetadataHost } from './ssrf';

/**
 * The error object naming `anc web <host>`, or null when the caller's generic
 * refusal stands: input that names no host, no published command, a host that
 * cannot be printed as one, or a metadata endpoint, which `anc web` refuses too.
 */
export function localTargetRefusal(
  refusal: WebTargetRefusal,
  origin: string,
  commandReleased: boolean = ANC_WEB_RELEASED,
): AuditErrorObject | null {
  if (refusal.refused !== 'host' || isMetadataHost(refusal.url.hostname)) return null;
  const { host } = refusal.url;
  const command = ancWebCommand(host, commandReleased);
  if (command === null) return null;
  return auditError(
    'invalid_target',
    `anc's public audit never contacts ${host}, a local, private, or internal host.`,
    {
      cta: localTargetCta(command),
      details: refusal.reason,
      reason: 'local-target',
      value: host,
      next_step: { action: 'run', command, docs: `${origin}${ANC_WEB_DOCS_PATH}` },
    },
  );
}
