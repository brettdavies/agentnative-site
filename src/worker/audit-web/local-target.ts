// The refusal for a target the SSRF gate refuses as a host, on every surface
// that takes one or reports on one. The public audit will never contact it;
// `anc web` audits it from a network that can reach it, so the refusal names that
// command.

import { type AuditError, type AuditNextStep, auditError } from '../../shared/audit-events';
import { escHtml } from '../../shared/esc-html';
import {
  ANC_WEB_DOCS_PATH,
  LOCAL_TARGET_CAUTION,
  LOCAL_TARGET_DOCS_LINK,
  localTargetCta,
  localTargetNextHtml,
} from '../../shared/scoring-copy';
import { ancWebCommand } from './anc-web-command';
import { prepareWebTarget, type WebTargetRefusal } from './core';
import { ANC_WEB_RELEASED } from './provenance-copy';

export type LocalTargetError = AuditError & { value: string; next_step: AuditNextStep };

/** Why a GET surface has nothing to offer but the command: nothing here will change the answer. */
const FINAL = 'Auditing it again returns the same answer.';

/**
 * The error object naming `anc web <host>`, or null when the caller's generic
 * refusal stands: input that names no host, no published command, or a host
 * `ancWebCommand` will not print, which covers a metadata endpoint.
 */
export function localTargetRefusal(
  refusal: WebTargetRefusal,
  origin: string,
  commandReleased: boolean = ANC_WEB_RELEASED,
): { error: LocalTargetError } | null {
  if (refusal.refused !== 'host') return null;
  const { host } = refusal.url;
  const command = ancWebCommand(host, commandReleased);
  if (command === null) return null;
  const { error } = auditError(
    'invalid_target',
    `anc's public audit never contacts ${host}, a local, private, or internal host.`,
    { cta: localTargetCta(command), details: refusal.reason, reason: 'local-target' },
  );
  return {
    error: {
      ...error,
      value: host,
      next_step: { action: 'run', command, docs: `${origin}${ANC_WEB_DOCS_PATH}` },
    },
  };
}

/** The refusal for a website host a GET surface reports on, or null when the public audit may contact it. */
export function refusalForHost(host: string, origin: string): { error: LocalTargetError } | null {
  const prepared = prepareWebTarget(host);
  return prepared.ok ? null : localTargetRefusal(prepared, origin);
}

export function localTargetMarkdown(error: LocalTargetError): string {
  return [
    `# anc's public audit refuses \`${error.value}\``,
    '',
    `${error.message} ${FINAL}`,
    '',
    error.cta,
    LOCAL_TARGET_CAUTION,
    '',
    '```bash',
    error.next_step.command,
    '```',
    '',
    `[${LOCAL_TARGET_DOCS_LINK}](${error.next_step.docs}).`,
    '',
  ].join('\n');
}

export function localTargetBodyHtml(error: LocalTargetError): string {
  return `<article class="container scorecard-page result-missing result-refused">
<header class="result-spine"><h1 class="result-spine__title">anc's public audit refuses <code>${escHtml(error.value)}</code></h1></header>
<p>${escHtml(error.message)} ${FINAL}</p>
<p>${localTargetNextHtml(error.next_step.command)}</p>
</article>`;
}
