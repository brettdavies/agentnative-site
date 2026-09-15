// The progress page's copy and heading, shared by the Worker that renders
// the first paint and the client that renders every state after it, so the
// two never disagree about what the page says.

import type { CliPhase } from './audit-events';
import type { Lane } from './audit-routes';
import { escHtml } from './esc-html';

/** The sentence that tells a visitor what normal looks like for a lane. */
export const LANE_EXPECTATION: Readonly<Record<Lane, string>> = {
  cli: 'Installs the tool in a sandbox; usually under a minute.',
  web: 'Usually a few seconds.',
};

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
