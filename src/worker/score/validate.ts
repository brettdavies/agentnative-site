// Input validator + classifier. Routes raw user input into one of four
// kinds (slug | install-command | github-url | unknown) the rest of the
// scoring pipeline consumes.
//
// Plan U4 (docs/plans/2026-04-28-002-feat-live-scoring-cf-sandbox-plan.md
// lines 1086-1091). URL validation rules per the rust-url-validation
// learning referenced in the plan (HTTPS only, github.com host only,
// homoglyph guard via literal hostname comparison after URL parsing).

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
  | { kind: 'github-url'; owner: string; repo: string }
  | { kind: 'unknown'; error: ValidationError };

const SLUG_RE = /^[a-z0-9-]+$/;
const PM_PREFIX_RE = /^(brew|cargo|bun|uv|pip|pip3|pipx|npm|yarn|pnpm|go)\s/;
// Anchored: only repo-root URLs (with optional .git suffix and optional
// trailing slash). Branch paths like `/tree/main` are rejected.
const GITHUB_URL_RE = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/;

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

  // URL paste: must be parseable, https-only, github.com only, repo-root only.
  if (trimmed.includes('://')) return classifyUrl(trimmed);

  return { kind: 'unknown', error: 'unrecognized_input' };
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
  // AND the standard non-github suffixes.
  if (parsed.hostname !== 'github.com') return { kind: 'unknown', error: 'non_github_host' };

  const m = url.match(GITHUB_URL_RE);
  if (!m) return { kind: 'unknown', error: 'invalid_url_path' };
  return { kind: 'github-url', owner: m[1], repo: m[2] };
}
