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
 * The command that evaluates a not-run row from the reader's own network, or
 * null when none does. The audited site chooses the host a sign-in row prints,
 * so the row binds it with `--token-host` and reads the token with
 * `--token-stdin`: run as printed, it takes nothing from the environment, and a
 * token the reader exported for another host stays put. Running the audited site
 * reaches the endpoint through its own declaration, which finds an endpoint off
 * the common paths that a run of the host alone would miss.
 */
export function notRunCommand(reason: NaReason, host: string, domain: string, commandReleased: boolean): string | null {
  if (ANC_WEB_ALSO_REFUSES.includes(reason)) return null;
  const onSite = ancWebCommand(domain, commandReleased);
  if (onSite === null || reason !== 'auth-required') return onSite;
  const tokenHost = printableHost(host);
  return tokenHost === null ? null : `${onSite} --token-host ${tokenHost} --token-stdin < token.txt`;
}
