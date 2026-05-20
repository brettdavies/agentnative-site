// Input validator + classifier. Routes raw user input into one of four
// kinds (slug | install-command | github-url | unknown) the rest of the
// scoring pipeline consumes.
//
// Plan U4 (docs/plans/2026-04-28-002-feat-live-scoring-cf-sandbox-plan.md
// lines 1086-1091). URL validation rules per the rust-url-validation
// learning referenced in the plan (HTTPS only, github.com host only,
// homoglyph guard via literal hostname comparison after URL parsing).
//
// Plan U8 input-handling expansion (2026-05-19):
//
//   - http:// is upgraded to https:// silently. The user pasted a tool
//     URL; the protocol is the wrong scheme but the intent is clear.
//     Substring attacks (`http://github.com.evil.com/...`) still fail
//     `non_github_host` because the host check is exact-match against
//     the URL parser's hostname field — the upgrade only changes the
//     scheme.
//   - `owner/repo` shorthand. `tobi/qmd` (no protocol, no github.com
//     prefix) routes to the same github-url path as
//     `https://github.com/tobi/qmd`. Strict per-GitHub username + repo
//     name rules (no leading hyphens, no spaces, capped lengths).
//   - Branch URLs. `https://github.com/<owner>/<repo>/tree/<branch>`
//     and `…/tree/<branch>/<subpath>` accept; the github-url variant
//     carries an optional `branch` field. Strict branch-name regex
//     plus an explicit `..` reject (defense in depth — the strict
//     regex already excludes shell metacharacters but the path-
//     traversal pattern is worth a separate guard for clarity).
//
// The `non_https_url` + `invalid_url_path` error codes stay in the union
// so they fire for genuinely-malformed inputs (e.g., `javascript:` or a
// repo URL with `/releases/download/...` instead of `/tree/...`).

import type { ParsedInstall } from './parse-install';
import { parseInstallCommand } from './parse-install';

export type ValidationError =
  | 'unrecognized_input'
  | 'unparseable_install_command'
  | 'invalid_url'
  | 'non_https_url'
  | 'non_github_host'
  | 'invalid_url_path';

export type ValidatedInput =
  | { kind: 'slug'; slug: string }
  | { kind: 'install-command'; spec: ParsedInstall }
  | { kind: 'github-url'; owner: string; repo: string; branch?: string }
  | { kind: 'unknown'; error: ValidationError };

const SLUG_RE = /^[a-z0-9-]+$/;
const PM_PREFIX_RE = /^(brew|cargo|bun|uv|pip|pip3|pipx|npm|yarn|pnpm|go)\s/;
// "Looks like an install command for a package manager we don't support."
// These prefixes are routed to `unparseable_install_command` (not
// `unrecognized_input`) so the homepage form can render a precise
// "this kind of install isn't supported" copy with the supported set
// listed, rather than a generic "not a recognized tool" line. Each
// entry is a literal head token; `apt-get` is hyphenated so the regex
// pins the whole word boundary.
const UNSUPPORTED_PM_PREFIX_RE =
  /^(apt-get|apt|dnf|yum|zypper|pacman|snap|flatpak|port|choco|scoop|winget|gem|composer|emerge)\s/;
// Anchored: repo-root URL (with optional .git suffix and optional
// trailing slash). Branch URLs (`/tree/<branch>[/<subpath>]`) match a
// separate pattern below — kept separate so the repo-root case stays
// the obvious-by-eye shape and branch handling doesn't muddy it.
const GITHUB_URL_RE = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/;
// Branch URL: `…/<owner>/<repo>/tree/<branch>[/<subpath>]`. Owner and
// repo segments captured for re-validation via the same character
// classes the shorthand uses. Branch capture is greedy because a
// branch name MAY contain `/` (e.g., `feature/new-thing`). The optional
// `/<subpath>` tail is allowed but discarded — users frequently paste
// `…/tree/main/docs/architecture.md`; the scoring contract is
// repo+branch granularity, not file granularity. If subpath-aware
// scoring ever lands, capture this tail then.
const GITHUB_BRANCH_URL_RE = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)\/tree\/(.+)$/;

// GitHub username rules: 1-39 chars, alphanumeric + hyphen, no leading
// hyphen. Org names follow the same rule. Mirrors GitHub's own
// validation so a regex pass here is the same gate the user would hit
// at github.com.
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
// GitHub repo name rules: alphanumeric, `.`, `_`, `-`. The literal
// strings `.` and `..` are reserved by GitHub itself, so we reject
// them explicitly. Cap at 100 chars (GitHub's documented limit is
// effectively unbounded but anything past 100 is almost certainly a
// paste mistake).
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;
// `owner/repo` shorthand: exactly two segments split by a single `/`.
// Substring attacks (`../etc/passwd`, `foo/bar/baz`, leading slashes)
// fail this regex before the owner+repo character classes run.
const SHORTHAND_RE = /^([^/\s]+)\/([^/\s]+)$/;

// Branch-name shape lock: alphanumeric, dot, underscore, slash, hyphen.
// Length capped at 250 chars (git itself enforces 255 for refs minus
// some overhead; 250 stays inside that and is plenty for any real
// branch). Path-traversal pattern (`..`) and shell metacharacters
// (space, `;`, `$`, `(`, `)`, backtick, `&`, `|`, `<`, `>`, quotes)
// are excluded by the character class; the explicit `..` guard in
// validBranchName() catches the path-traversal case clearly.
const BRANCH_NAME_RE = /^[A-Za-z0-9._/-]{1,250}$/;

// Mirrors the shape U1 emits at dist/registry-index.json. The Worker
// imports the actual file at request time; here we declare the contract.
export type RegistryIndexShape = {
  by_slug: Record<string, unknown>;
  by_owner_repo: Record<string, unknown>;
};

export function validateInput(raw: string, registryIndex: RegistryIndexShape): ValidatedInput {
  const trimmed = raw.trim();
  if (!trimmed) return { kind: 'unknown', error: 'unrecognized_input' };

  // Slug: regex AND in registry. A bare alphanumeric+hyphen string that
  // ISN'T in the registry falls through (unrecognized_input at the end).
  if (SLUG_RE.test(trimmed) && trimmed in registryIndex.by_slug) {
    return { kind: 'slug', slug: trimmed };
  }

  // Install-command: starts with a known package-manager prefix. Delegates
  // shape validation to parse-install.
  if (PM_PREFIX_RE.test(trimmed)) {
    const parsed = parseInstallCommand(trimmed);
    if (parsed.ok) return { kind: 'install-command', spec: parsed.value };
    return { kind: 'unknown', error: parsed.error };
  }

  // Looks-like-install-command for an unsupported package manager:
  // route directly to `unparseable_install_command` so the homepage form
  // surfaces the "PM isn't supported" copy with the supported set listed,
  // rather than the generic "not a recognized tool" line. Without this
  // branch, `apt-get install foo` would fall through to
  // `unrecognized_input` and read the same as random text.
  if (UNSUPPORTED_PM_PREFIX_RE.test(trimmed)) {
    return { kind: 'unknown', error: 'unparseable_install_command' };
  }

  // URL paste: must be parseable, github.com only, repo-root OR branch.
  // http:// is silently upgraded to https:// before routing — the user's
  // intent is unambiguous and the protocol is the only thing wrong.
  // Genuinely malformed protocols (`javascript:`, `htp:`, etc.) still
  // fail through the URL-parse path or the protocol check.
  if (trimmed.includes('://')) {
    const upgraded = maybeUpgradeHttp(trimmed);
    return classifyUrl(upgraded);
  }

  // `owner/repo` shorthand. Tried AFTER slug + install-command checks so
  // an installed-by-name lookup wins over an accidental shorthand match,
  // and BEFORE the unknown bounce so two-segment github-shaped inputs
  // route to the github-url path. The regex is strict on segment shape;
  // path traversal (`../foo`), triple-slash (`foo/bar/baz`), leading
  // hyphens (`-bad/repo`), and whitespace all bounce as
  // unrecognized_input here rather than producing a malformed github-url.
  const shorthand = trimmed.match(SHORTHAND_RE);
  if (shorthand && OWNER_RE.test(shorthand[1]) && REPO_RE.test(shorthand[2])) {
    return { kind: 'github-url', owner: shorthand[1], repo: shorthand[2] };
  }

  return { kind: 'unknown', error: 'unrecognized_input' };
}

// Silent http:// → https:// upgrade. Only the `http://` prefix is
// rewritten (case-insensitive); `https://`, `javascript:`, `data:`,
// `htp:`, etc. pass through untouched and fall to the normal URL-parse
// path. The substring is matched at position 0 so a string like
// `random text http://x` doesn't trigger the upgrade — only a paste
// that actually STARTS with http:// gets the silent fix.
function maybeUpgradeHttp(input: string): string {
  if (/^http:\/\//i.test(input)) {
    return `https://${input.slice('http://'.length)}`;
  }
  return input;
}

function classifyUrl(url: string): ValidatedInput {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { kind: 'unknown', error: 'invalid_url' };
  }
  if (parsed.protocol !== 'https:') return { kind: 'unknown', error: 'non_https_url' };
  // The URL parser IDN-encodes non-ASCII hostnames into Punycode
  // (`xn--*`). Literal comparison against `github.com` rejects homoglyph
  // spoofs (e.g. Cyrillic 'і' in `gіthub.com` becomes `xn--gthub-cph.com`)
  // AND substring-attack hosts like `github.com.evil.com` (whose parsed
  // hostname is the full `github.com.evil.com`, not `github.com`).
  if (parsed.hostname !== 'github.com') return { kind: 'unknown', error: 'non_github_host' };

  // Match against the parser-normalized href so case-variant pastes
  // (`HTTP://GitHub.com/...`) succeed: the parser lowercases scheme +
  // host but preserves path case, so `normalized` is always
  // `https://github.com/<owner>/<repo>[/...]`.
  const normalized = parsed.href;
  // Try repo-root URL first (the common case).
  const root = normalized.match(GITHUB_URL_RE);
  if (root) return { kind: 'github-url', owner: root[1], repo: stripGitSuffix(root[2]) };

  // Branch URL: `…/<owner>/<repo>/tree/<branch>[/<subpath>]`. The
  // branch capture is greedy through the rest of the URL; we split it
  // again to peel a leading `<branch>` segment off any trailing
  // `/<subpath>` so a paste like `…/tree/main/docs/file.md` resolves
  // to branch=`main` (subpath discarded). Branch may itself contain
  // `/` (e.g. `feature/new-thing`), but the standard GitHub URL shape
  // doesn't disambiguate `feature/new-thing/<no-subpath>` from
  // `feature/new-thing/some-subpath` — we accept the FULL tail as the
  // branch name in that case and let the DO's git clone bounce if the
  // branch doesn't exist. This matches GitHub's own URL semantics
  // (which also can't tell the difference without a server round-trip)
  // and biases toward "let the user score what they pasted".
  const branchUrl = normalized.match(GITHUB_BRANCH_URL_RE);
  if (branchUrl) {
    const owner = branchUrl[1];
    const repo = stripGitSuffix(branchUrl[2]);
    const tail = branchUrl[3];
    const branch = peelBranch(tail);
    if (!branch || !validBranchName(branch)) {
      return { kind: 'unknown', error: 'invalid_url_path' };
    }
    return { kind: 'github-url', owner, repo, branch };
  }

  return { kind: 'unknown', error: 'invalid_url_path' };
}

// Peel a branch name off a `/tree/<...>` tail, taking the FULL tail as
// the branch. The URL parser already URL-decoded the path, so `%2F`
// inputs land here as literal `/`. The validBranchName() guard then
// rejects path-traversal patterns (`..`) before the branch reaches the
// DO. Empty tail returns null so `…/tree/` (no branch) bounces.
function peelBranch(tail: string): string | null {
  // Trim a trailing slash so `…/tree/main/` matches `main`.
  const cleaned = tail.replace(/\/+$/, '');
  if (!cleaned) return null;
  return cleaned;
}

// Branch-name shape lock applied after URL parsing. Pure-character-class
// check plus an explicit `..` reject so path-traversal stands out in
// the code (the regex already excludes `..` by way of dot AND adjacent
// dot being a non-repeating run, but the explicit guard documents the
// security property loudly and protects against a future regex relax
// that would silently re-open the gap).
export function validBranchName(branch: string): boolean {
  if (!BRANCH_NAME_RE.test(branch)) return false;
  if (branch.includes('..')) return false;
  if (branch.startsWith('/') || branch.endsWith('/')) return false;
  if (branch.startsWith('.') || branch.endsWith('.')) return false;
  return true;
}

function stripGitSuffix(repo: string): string {
  return repo.replace(/\.git$/, '');
}
