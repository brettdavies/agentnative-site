// The words a website result uses for where its evidence came from: the
// declared-hosts section, the host lines on categories and rows, the
// not-run groups, and why the public audit could not evaluate a check.
// Written once as rich text, so the page, its markdown twin, and the MCP
// reads say the same sentences.

import type { NaReason } from '../../shared/web-audit-findings';
import { MAX_FOLLOWED_HOSTS } from './follow-requests';
import type { BudgetCause, NotFollowedReason } from './follow-trail';
import type { AdmittedBy } from './reciprocity';
import type { Rich } from './rich-text';
import { isMetadataHost } from './ssrf';

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
  'insecure-scheme': 'not https',
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

// Whether a published anc release includes `anc web`. Every Worker surface that
// names the command reads this, so a reader is never sent to a command that
// fails; the reason a check did not run or a target was refused is stated either
// way. Pages under content/ name the command regardless.
export const ANC_WEB_RELEASED = true;

// A URL host admits `$(...)`, `;`, backticks, and a leading `-`, and the MCP
// tools read theirs from a URL no classifier has seen. Only a host that reads
// as neither shell syntax nor a flag is printed as a command an agent may run.
const COMMAND_SAFE_HOST = /^(?:[a-z0-9_][a-z0-9_.-]*|\[[0-9a-f:.]+\])(?::\d+)?$/i;

/**
 * The `anc web` invocation for a host, runnable as printed, or null when no
 * published release has the command or it cannot run for this host.
 */
export function ancWebCommand(host: string, commandReleased: boolean = ANC_WEB_RELEASED): string | null {
  if (!commandReleased) return null;
  const printed = printableHost(host);
  return printed === null ? null : `anc web ${printed}`;
}

/**
 * The host as a command argument, or null when it cannot be printed safely or
 * `anc web` refuses it from any network. A bracketed IPv6 literal is quoted
 * because zsh reads brackets as a glob.
 */
function printableHost(host: string): string | null {
  if (!COMMAND_SAFE_HOST.test(host) || isMetadataHost(host.replace(/:\d+$/, ''))) return null;
  return host.startsWith('[') ? `'${host}'` : host;
}

// `anc web` holds a declared host to the same rules the public audit does: it
// never probes an IP literal or a host of another class than the target's, it
// needs the same confirmation from a declared host, and it stops at the same
// per-audit cap, which a budget row does not tell apart from the hourly limit a
// local run escapes. Naming the command for these would promise a result it may
// not produce.
const ANC_WEB_ALSO_REFUSES: readonly NaReason[] = [
  'declared-host-blocked',
  'reciprocity-refused',
  'declared-host-budget-exceeded',
];

/**
 * The command that evaluates a not-run row from the reader's own network, or
 * null when none does. `anc web` sends a token only to the host `--token-host`
 * names, so a sign-in row always names it; running the audited site with the
 * flag reaches the endpoint through the site's own declaration, which finds an
 * endpoint off the common paths that a run of the host alone would miss.
 */
function notRunCommand(reason: NaReason, host: string, domain: string, commandReleased: boolean): string | null {
  if (ANC_WEB_ALSO_REFUSES.includes(reason)) return null;
  const onSite = ancWebCommand(domain, commandReleased);
  if (onSite === null || reason !== 'auth-required') return onSite;
  const tokenHost = printableHost(host);
  return tokenHost === null ? null : `${onSite} --token-host ${tokenHost}`;
}

/**
 * Why the public audit could not evaluate a not-run row or group, and, when
 * a published anc release can evaluate it, the command that does so from the
 * reader's own network.
 */
export function notRunRemedy(
  reason: NaReason,
  host: string,
  domain: string,
  count: number,
  commandReleased: boolean = ANC_WEB_RELEASED,
): Rich {
  const cause = NOT_RUN_CAUSES[reason]?.(host, domain);
  const what = count === 1 ? 'this check' : 'these checks';
  const invocation = notRunCommand(reason, host, domain, commandReleased);
  if (invocation === null) return [cause ?? `anc's public audit could not run ${what}.`];
  const run = cause === undefined ? 'Run ' : `${cause} Run `;
  const command = { code: invocation };
  const tail = ` to evaluate ${what} from your own network.`;
  return reason === 'auth-required'
    ? [run, command, ' with ', { code: 'ANC_WEB_TOKEN' }, ` set to a token for ${host}${tail}`]
    : [run, command, tail];
}

/** The score note's sentence for a result holding rows the public audit could not run. */
export function notRunScoreNote(
  rows: readonly { reason: NaReason; host: string }[],
  domain: string,
  commandReleased: boolean = ANC_WEB_RELEASED,
): Rich {
  const total = rows.length === 1 ? '1 check' : `${rows.length} checks`;
  const siteCommand = ancWebCommand(domain, commandReleased);
  const commands = rows.map((row) => notRunCommand(row.reason, row.host, domain, commandReleased));
  const onSite = commands.filter((command) => command !== null && command === siteCommand).length;
  const signIn = commands.filter((command) => command !== null && command !== siteCommand).length;

  const them = onSite < rows.length ? `${onSite} of them` : rows.length === 1 ? 'it' : 'them';
  const runSite: Rich =
    siteCommand !== null && onSite > 0
      ? ['; run ', { code: siteCommand }, ` to evaluate ${them} from your own network`]
      : [];
  const signInRows: Rich =
    signIn === 0
      ? []
      : [
          signIn === 1
            ? '; the one that needs sign-in names its own command'
            : '; the ones that need sign-in name their own command',
        ];
  return [`Global keeps the ${total} this audit could not run in its maximum`, ...runSite, ...signInRows, '.'];
}
