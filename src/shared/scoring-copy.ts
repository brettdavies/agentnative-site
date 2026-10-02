// The progress page's copy and heading, shared by the Worker that renders
// the first paint and the client that renders every state after it, so the
// two never disagree about what the page says.

import type { AuditEvent, CliPhase } from './audit-events';
import type { Lane } from './audit-routes';
import { escHtml } from './esc-html';
import { hostOf } from './url-host';
import { FINDING_STATUSES, isNotRunReason } from './web-audit-findings';
import { resultLine } from './web-audit-result-line';

/** The sentence that tells a visitor what normal looks like for a lane. */
export const LANE_EXPECTATION: Readonly<Record<Lane, string>> = {
  cli: 'Installs the tool in a sandbox; usually under a minute.',
  web: 'Usually under 30 seconds; longer when the site declares other hosts.',
};

/** The website lane's status line once the run starts, until its first event arrives. */
export function webReadingLine(target: string): string {
  return `Reading ${target} and any hosts it declares…`;
}

/** The host a discovered endpoint sits on, or null when there is none to name. */
export function endpointHostOf(endpoint: string | null): string | null {
  return endpoint === null ? null : hostOf(endpoint);
}

/** Where discovery found the MCP endpoint, naming the target as its declarer when it sits on another host. */
export function discoveryLine(endpoint: string | null, target: string): string {
  if (endpoint === null) return 'No MCP endpoint found.';
  const host = endpointHostOf(endpoint);
  return host === null || host === target.toLowerCase()
    ? `MCP endpoint found at ${endpoint}.`
    : `MCP endpoint found at ${endpoint}, declared by ${target}.`;
}

/**
 * The host a streamed row names in its title, only when the row reached a
 * host other than both the target and the endpoint the status line names. A
 * row the audit could not run names its host in its result line instead,
 * because it was not evaluated there.
 */
export function rowHostPhrase(
  event: Pick<Extract<AuditEvent, { type: 'check' }>, 'host' | 'na_reason'>,
  target: string,
  endpointHost: string | null,
): string | null {
  const { host } = event;
  if (host === undefined || host === target.toLowerCase() || host === endpointHost) return null;
  if (isNotRunReason(event.na_reason)) return null;
  return `evaluated at ${host}`;
}

/** The lane as the heading's chip names it. */
export const LANE_LABEL: Readonly<Record<Lane, string>> = { cli: 'CLI', web: 'Website' };

/** Each CLI phase as its progress row names it. */
export const CLI_PHASE_LABEL: Readonly<Record<CliPhase, string>> = {
  resolving: 'Resolving the install path',
  installing: 'Installing in the sandbox',
  installed: 'Installed',
  verifying: 'Verifying the binary',
  lockdown: 'Closing network access',
  auditing: 'Running anc audit',
};

/** The first status line when the target's shape moved it off the lane the visitor had selected. */
export const RECLASSIFIED: Readonly<Record<Lane, string>> = {
  cli: 'Audited as a CLI tool: the target looks like a tool name, not a website.',
  web: 'Audited as a website: the target looks like a domain, not a CLI tool.',
};

/** The page's headings. A failed audit reads like an idle one, because the next action is the same Start. */
export type ScoringState = 'idle' | 'running' | 'done' | 'failed';

/** The site's suffix on every document title. */
export const TITLE_SUFFIX = ' — anc.dev';

/** The heading's markup: the target in mono beside its lane chip. */
export function scoringHeadingHtml(state: ScoringState, target: string, lane: Lane): string {
  const code = `<code>${escHtml(target)}</code>`;
  const chip = ` <span class="tier">${LANE_LABEL[lane]}</span>`;
  if (state === 'running') return `Auditing ${code}&hellip;${chip}`;
  if (state === 'done') return `${code} audited${chip}`;
  return `Audit ${code}${chip}`;
}

/** The document title for a state: it follows the heading and never a phase. */
export function scoringTitle(state: ScoringState, target: string): string {
  const text =
    state === 'running'
      ? `Auditing ${target}…`
      : state === 'done'
        ? `${target} audited`
        : state === 'failed'
          ? `${target}: audit failed`
          : `Audit ${target}`;
  return `${text}${TITLE_SUFFIX}`;
}

/**
 * A streamed check's result line: the words the saved page shows for the
 * same row, built from the same phrases. An event without a host came from
 * the target itself.
 */
export function streamedResultLine(event: Extract<AuditEvent, { type: 'check' }>, target: string): string | null {
  const status = FINDING_STATUSES.find((s) => s === event.status);
  if (status === undefined) return event.evidence;
  return resultLine(status, event.evidence, event.na_reason, event.host ?? target);
}
