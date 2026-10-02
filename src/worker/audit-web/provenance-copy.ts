// The words a website result uses for where its evidence came from: the
// declared-hosts section, the host lines on categories and rows, the
// not-run groups, and what a reader can run to evaluate what the public
// audit could not. Written once as rich text, so the page, its markdown
// twin, and the MCP reads say the same sentences.

import type { NaReason } from '../../shared/web-audit-findings';
import { MAX_FOLLOWED_HOSTS } from './follow-requests';
import type { BudgetCause, NotFollowedReason } from './follow-trail';
import type { AdmittedBy } from './reciprocity';
import type { Rich } from './rich-text';

/** The fragment the Declared hosts slot carries on every page, whichever state it renders. */
export const DECLARED_HOSTS_ID = 'declared-hosts';
export const DECLARED_HOSTS_HEADING = 'Declared hosts';

const DECLARED_HOSTS_LINK = { text: DECLARED_HOSTS_HEADING, href: `#${DECLARED_HOSTS_ID}` };

export function declaredHostsLede(domain: string): string {
  return `${domain} points agents to these hosts; results from the hosts anc could confirm are credited to ${domain}.`;
}

/** Why the slot carries one line instead of a list. */
export type DeclaredHostsState = 'not-recorded' | 'paused' | 'this-run' | 'none';

export const DECLARED_HOSTS_LINES: Readonly<Record<DeclaredHostsState, string>> = {
  'not-recorded': 'Declared hosts: not recorded for this audit.',
  paused: 'Declared hosts: not followed; following is paused.',
  'this-run': 'Declared hosts: not followed for this run.',
  none: 'Declared hosts: none declared.',
};

/** The score note's clause for a result that evaluated hosts the site declares. */
export function scoreHostsClause(count: number): Rich {
  return [`, including ${count} ${count === 1 ? 'host' : 'hosts'} it declares (see `, DECLARED_HOSTS_LINK, ')'];
}

export function evaluatedAtNote(host: string): Rich {
  return ['Evaluated at ', { code: host }];
}

export function categoryHostLine(host: string, declaredBy: Rich | null): Rich {
  return declaredBy === null
    ? ['Evaluated at ', { code: host }]
    : ['Evaluated at ', { code: host }, ', declared by ', ...declaredBy];
}

export function notRunCount(count: number): string {
  return `${count} not run`;
}

export function notRunGroupLabel(count: number, why: string): string {
  return `${count} checks not run: ${why}`;
}

/** The group's accessible name: the label with a comma, so a screen reader reads it as one phrase. */
export function notRunGroupName(count: number, why: string): string {
  return `${count} checks not run, ${why}`;
}

/** An empty category whose rows mostly share a not-run reason says that reason instead of "does not apply". */
export function notRunCategoryNote(phrase: string): Rich {
  return [`${phrase}. See `, DECLARED_HOSTS_LINK, '.'];
}

export const SURFACE_LABELS = {
  cardRemotes: ['server card (', { code: 'remotes[].url' }, ')'],
  cardTransport: ['server card (', { code: 'transport.url' }, ')'],
  card: ['server card'],
  aiCatalog: ['ai-catalog entry'],
  apiAnchor: ['api-catalog anchor'],
  apiDescription: ['api-catalog service-desc'],
} as const satisfies Record<string, Rich>;

/** A common MCP path on the audited site that redirected its probes to another host. */
export function redirectSurface(path: string): Rich {
  return ['redirect from ', { code: path }];
}

const NOT_FOLLOWED: Readonly<Record<NotFollowedReason, string>> = {
  'templated-url': 'templated URL',
  'beyond-endpoint-of-record': 'not the endpoint of record',
  'no-service-desc': 'no service description',
  'self-path': 'self path',
  'follow-disabled': 'following off for this audit',
};

export function notFollowedOutcome(reason: string): string {
  const label = Object.hasOwn(NOT_FOLLOWED, reason) ? NOT_FOLLOWED[reason as NotFollowedReason] : reason;
  return `not followed: ${label}`;
}

/** `retryHour` is the UTC hour the domain's budget frees, as HH, when known. */
export function budgetOutcome(cause: string, retryHour: string | null): string {
  const causes: Readonly<Record<BudgetCause, string>> = {
    'per-audit-cap': `more than ${MAX_FOLLOWED_HOSTS} hosts`,
    slice: 'time limit',
    'domain-budget': retryHour === null ? 'hourly limit' : `hourly limit, try after ${retryHour}:00 UTC`,
  };
  return `not probed: ${Object.hasOwn(causes, cause) ? causes[cause as BudgetCause] : cause}`;
}

export const OUTCOME_WORDS = {
  followed: 'evaluated',
  blocked: 'not probed: private or IP address',
  unreachable: 'no answer',
} as const;

export function notConfirmedOutcome(host: string): string {
  return `not confirmed by ${host}`;
}

export function admittedByWhy(by: AdmittedBy, endpointCard: string, host: string): Rich {
  if (by === 'card') return ['confirmed by ', { code: endpointCard }];
  if (by === 'ai-catalog') return [`confirmed by ${host}'s ai-catalog`];
  return ['confirmed by RFC 9728 metadata'];
}

export const OPENAPI_FOUND: Rich = ['OpenAPI description found'];

/** What a host that did not confirm an endpoint publishes to be evaluated, as the URLs anc checked. */
export function confirmGuidance(
  host: string,
  endpoint: string,
  urls: { card: string; catalog: string; metadata: string },
): Rich {
  return [
    `To be evaluated, ${host} publishes one of these naming `,
    { code: endpoint },
    ': a SEP-2127 server card at ',
    { code: urls.card },
    ', an entry in ',
    { code: urls.catalog },
    ', or RFC 9728 metadata at ',
    { code: urls.metadata },
    '.',
  ];
}

const NOT_RUN_CAUSES: Readonly<Partial<Record<NaReason, (host: string, domain: string) => string>>> = {
  'follow-disabled': (_host, domain) => `This audit did not follow the hosts ${domain} declares.`,
  'reciprocity-refused': (host) => `anc's public audit probes ${host} only after ${host} confirms this endpoint.`,
  'declared-host-unreachable': (host) => `${host} did not answer anc's public audit.`,
  'declared-host-blocked': (host) => `anc's public audit never contacts ${host}, a private or IP address.`,
  'declared-host-budget-exceeded': (host) => `anc's public audit reached its hourly probe limit for ${host}.`,
  'auth-required': (host) => `anc's public audit holds no sign-in for ${host}.`,
};

/**
 * Why the public audit could not evaluate a not-run row or group, and the
 * command that evaluates it from the reader's own network.
 */
export function notRunRemedy(reason: NaReason, host: string, domain: string, count: number): Rich {
  const cause = NOT_RUN_CAUSES[reason]?.(host, domain);
  const run = cause === undefined ? 'Run ' : `${cause} Run `;
  const what = count === 1 ? 'this check' : 'these checks';
  const command = { code: `anc web ${domain}` };
  const tail = ` to evaluate ${what} from your own network.`;
  return reason === 'auth-required'
    ? [run, command, ' with ', { code: 'ANC_WEB_TOKEN' }, ` set to a token for ${host}${tail}`]
    : [run, command, tail];
}

/** The score note's sentence for a result holding rows the public audit could not run. */
export function notRunScoreNote(count: number, domain: string, needsSignIn: boolean): Rich {
  const rows = count === 1 ? '1 check' : `${count} checks`;
  const them = count === 1 ? 'it' : 'them';
  const signIn: Rich = needsSignIn ? [', with ', { code: 'ANC_WEB_TOKEN' }, ' set for the ones that need sign-in'] : [];
  return [
    `Global keeps the ${rows} this audit could not run in its maximum; run `,
    { code: `anc web ${domain}` },
    ` to evaluate ${them} from your own network`,
    ...signIn,
    '.',
  ];
}
