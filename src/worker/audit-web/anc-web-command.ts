// The `anc web` invocations this site prints, and when it prints none. A reader
// or an agent runs these as printed, so every host is treated as hostile: it
// comes from a request path, a caller-supplied URL, or a scorecard whose audited
// site chose it.

import type { NaReason } from '../../shared/web-audit-findings';
import { isMetadataHost } from './ssrf';

// A URL host admits `$(...)`, `;`, backticks, and a leading `-`, and the MCP
// tools read theirs from a URL no classifier has seen. Only a host that reads
// as neither shell syntax nor a flag is printed as a command an agent may run.
const COMMAND_SAFE_HOST = /^(?:[a-z0-9_][a-z0-9_.-]*|\[[0-9a-f:.]+\])(?::\d+)?$/i;

// The reasons a run from the reader's own network can change. `anc web` holds a
// declared host to the same rules the public audit does: it never probes an IP
// literal or a host of another class than the target's, it needs the same
// confirmation from a declared host, and it stops at the same per-audit cap,
// which a budget row does not tell apart from the hourly limit a local run
// escapes. Anything not listed names no command, so a new reason cannot promise a
// result by default.
const ANC_WEB_EVALUATES: readonly NaReason[] = ['follow-disabled', 'declared-host-unreachable', 'auth-required'];

/**
 * The host as a command argument, or null when it cannot be printed safely or
 * `anc web` refuses it from any network. A bracketed IPv6 literal is quoted
 * because zsh reads brackets as a glob.
 */
function printableHost(host: string): string | null {
  if (!COMMAND_SAFE_HOST.test(host) || isMetadataHost(host.replace(/:\d+$/, ''))) return null;
  return host.startsWith('[') ? `'${host}'` : host;
}

/** The `anc web` invocation for a host, or null when no published release has it or it cannot run for this host. */
export function ancWebCommand(host: string, commandReleased: boolean): string | null {
  if (!commandReleased) return null;
  const printed = printableHost(host);
  return printed === null ? null : `anc web ${printed}`;
}

/**
 * The file a sign-in row reads its token from, named for the host. The audited
 * site chooses that host, so a shared name would send a token kept for one host
 * to whichever site's row the reader ran next.
 */
export function tokenFileFor(host: string): string {
  return `token-for-${host.toLowerCase().replace(/[^a-z0-9._-]/g, '_')}.txt`;
}

/**
 * The command that evaluates a not-run row from the reader's own network, or
 * null when none does. A sign-in row binds the host with `--token-host` and reads
 * the token from that host's own file with `--token-stdin`, so a command run as
 * printed takes nothing from the environment. Running the audited site reaches
 * the endpoint through its own declaration, which finds an endpoint off the
 * common paths that a run of the host alone would miss.
 */
export function notRunCommand(reason: NaReason, host: string, domain: string, commandReleased: boolean): string | null {
  if (!ANC_WEB_EVALUATES.includes(reason)) return null;
  const onSite = ancWebCommand(domain, commandReleased);
  if (onSite === null || reason !== 'auth-required') return onSite;
  const tokenHost = printableHost(host);
  return tokenHost === null ? null : `${onSite} --token-host ${tokenHost} --token-stdin < ${tokenFileFor(host)}`;
}
