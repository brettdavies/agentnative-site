// The failed state's panel for each error the funnel shares. The CLI codes
// that a visitor can act on get the specific copy (a registry miss, a
// library with no binary, an install path the sandbox refuses); every other
// code falls back to its shared message and call to action. Panel bodies
// are markup this module owns; nothing a request carries reaches them
// unescaped.

import type { AuditError } from '../shared/audit-events';
import { escHtml } from '../shared/esc-html';

export type BouncePanel = { headline: string; bodyHtml: string; details?: string };

const INSTALL_LOCALLY = '<a href="/install">Install anc locally</a>';

// Stderr past this length is cut so the panel stays readable; the full
// text is in the Worker logs.
const STDERR_TRUNCATE_CHARS = 2000;

function truncate(details: string | undefined): string | undefined {
  if (!details) return undefined;
  return details.length <= STDERR_TRUNCATE_CHARS ? details : `${details.slice(0, STDERR_TRUNCATE_CHARS)}… (truncated)`;
}

// The sandbox reports a package manager that found nothing as a failed
// install; its stderr is what tells the two apart. A false positive would
// relabel a real install failure as a registry miss, so the patterns stay
// narrow.
function isPackageNotFound(details: string | undefined): boolean {
  if (!details) return false;
  const text = details.toLowerCase();
  return [
    /\bis not found\b/,
    /\bno matching (package|distribution|formula)\b/,
    /\bcould not find\b/,
    /\bno available formula\b/,
    /\bunknown package\b/,
    /\bdoes not exist\b/,
    /\bnot found in (the )?registry\b/,
    /\b404 not found\b/,
  ].some((re) => re.test(text));
}

function isArchiveWithoutBinary(details: string | undefined): boolean {
  return details ? /\bArchive contains no binary named\b/i.test(details) : false;
}

function installUnsupported(pm: string | undefined): BouncePanel {
  switch (pm) {
    case 'brew':
    case 'brew_only':
      return {
        headline: "Homebrew installs aren't sandboxed yet.",
        bodyHtml: `Homebrew isn't available in the scoring sandbox. Try a <code>cargo install</code>, <code>pipx install</code>, or <code>npm i -g</code> equivalent, or paste a GitHub URL. ${INSTALL_LOCALLY} to score brew-only tools.`,
      };
    case 'bun':
      return {
        headline: "`bun install` isn't sandboxed yet.",
        bodyHtml: `The sandbox doesn't put Bun's global install path on PATH. Try an <code>npm i -g</code> or <code>pipx install</code> equivalent, or ${INSTALL_LOCALLY.toLowerCase().replace('install anc', 'install anc')}.`,
      };
    case 'go_no_binary':
      return {
        headline: "That Go module doesn't expose a CLI binary.",
        bodyHtml: `anc only scores tools that produce a command on PATH. Paste a binary-producing package, or ${INSTALL_LOCALLY} to score libraries.`,
      };
    default:
      return {
        headline: "That install path isn't supported in the sandbox.",
        bodyHtml: `Paste a <code>cargo install</code>, <code>pipx install</code>, <code>npm i -g</code>, or GitHub URL instead, or ${INSTALL_LOCALLY}.`,
      };
  }
}

/** The panel for an error object from a JSON error body or a `bounce` or `error` event. */
export function bouncePanel(error: AuditError): BouncePanel {
  switch (error.code) {
    case 'chain_resolved_install_failed':
      if (isPackageNotFound(error.details)) {
        return {
          headline: "That package isn't in the registry.",
          bodyHtml: `The package manager couldn't find a package by that name. Check the spelling, or paste a GitHub URL if the project ships releases there. ${INSTALL_LOCALLY} to score private or unpublished tools.`,
          details: truncate(error.details),
        };
      }
      return {
        headline: "Found an install path, but it didn't run.",
        bodyHtml: `The install command returned a non-zero exit. ${INSTALL_LOCALLY} for more flexible install options.`,
        details: truncate(error.details),
      };
    case 'chain_no_resolve':
      return {
        headline: "We couldn't find a pre-built binary for that.",
        bodyHtml: `anc only scores tools with a published binary release. ${INSTALL_LOCALLY} to score source and project depth.`,
      };
    case 'github_repo_not_accessible':
      return {
        headline: "GitHub couldn't find that repo.",
        bodyHtml: `It may be private, renamed, or never existed. ${INSTALL_LOCALLY} to score private repos directly: the live sandbox has no GitHub credentials.`,
      };
    case 'chain_resolved_no_binary_produced':
      if (isArchiveWithoutBinary(error.details)) {
        return {
          headline: "The archive doesn't contain the binary we expected.",
          bodyHtml: `The release ships files but no executable that matches our auto-detector. ${INSTALL_LOCALLY} to score this tool directly.`,
          details: truncate(error.details),
        };
      }
      return {
        headline: 'That looks like a library, not a CLI.',
        bodyHtml: `We installed it, but no command-line entry point appeared on PATH. anc only scores binaries. If this is wrong, paste the actual binary name to retry. ${INSTALL_LOCALLY} for full project depth.`,
      };
    case 'install_unsupported':
      return installUnsupported(error.pm);
    case 'rate_limited':
      return {
        headline: 'Too many audits right now.',
        bodyHtml: `Try again in ${escHtml(String(error.retry_after ?? 60))} s.`,
      };
    default:
      return { headline: error.message, bodyHtml: escHtml(error.cta), details: truncate(error.details) };
  }
}

/** A run that hit its deadline before it finished: nothing was saved. */
export const INCOMPLETE_PANEL: BouncePanel = {
  headline: 'The audit ran out of time before it finished.',
  bodyHtml: 'Nothing was saved. Run it again.',
};

/** The stream closed before a terminal line: the run may still be going. */
export const STREAM_LOST_PANEL: BouncePanel = {
  headline: 'The connection to the audit dropped.',
  bodyHtml: 'The audit may still be running. Run it again to reattach to it.',
};

/** The request never reached the audit service. */
export const NETWORK_PANEL: BouncePanel = {
  headline: 'The audit service could not be reached.',
  bodyHtml: 'Check your connection and run it again.',
};
