import { describe, expect, test } from 'bun:test';
import { validateInput, validBranchName } from '../src/worker/score/validate';

const REGISTRY = {
  by_slug: {
    ripgrep: { name: 'ripgrep', binary: 'rg', install: 'brew install ripgrep' },
    bat: { name: 'bat', binary: 'bat', install: 'brew install bat' },
  },
  by_owner_repo: {
    'BurntSushi/ripgrep': { name: 'ripgrep' },
  },
} as const;

describe('validateInput — slug', () => {
  test('exact slug in registry → kind: slug', () => {
    expect(validateInput('ripgrep', REGISTRY)).toEqual({ kind: 'slug', slug: 'ripgrep' });
  });

  test('slug-shaped string NOT in registry → unrecognized_input (falls through)', () => {
    expect(validateInput('not-a-real-tool', REGISTRY)).toEqual({ kind: 'unknown', error: 'unrecognized_input' });
  });

  test('uppercase rejected (slug regex is lowercase only)', () => {
    expect(validateInput('Ripgrep', REGISTRY)).toEqual({ kind: 'unknown', error: 'unrecognized_input' });
  });

  test('whitespace-trimmed before slug check', () => {
    expect(validateInput('  bat  ', REGISTRY).kind).toBe('slug');
  });

  test('leading + trailing whitespace on a curated slug routes to slug, NOT unrecognized_input', () => {
    // Front-end trims on submit (live-score.ts), but a user could POST
    // ` ripgrep ` directly to /api/score via curl. The validator MUST
    // trim before the slug-and-registry check; otherwise `" ripgrep "`
    // would fail SLUG_RE and bounce as unrecognized_input.
    expect(validateInput(' ripgrep ', REGISTRY)).toEqual({ kind: 'slug', slug: 'ripgrep' });
    expect(validateInput('\tripgrep\n', REGISTRY)).toEqual({ kind: 'slug', slug: 'ripgrep' });
  });
});

describe('validateInput — install command', () => {
  test('brew install <pkg>', () => {
    const r = validateInput('brew install ripgrep', REGISTRY);
    expect(r.kind).toBe('install-command');
    if (r.kind === 'install-command') {
      expect(r.spec).toEqual({ pm: 'brew', package: 'ripgrep', binary: 'ripgrep' });
    }
  });

  test('cargo binstall <pkg>', () => {
    const r = validateInput('cargo binstall hyperfine', REGISTRY);
    expect(r.kind).toBe('install-command');
  });

  test('unparseable install command surfaces parse error', () => {
    expect(validateInput('cargo whatever foo', REGISTRY)).toEqual({
      kind: 'unknown',
      error: 'unparseable_install_command',
    });
  });

  test('looks-like-install-command for unsupported PM → unparseable_install_command (NOT unrecognized_input)', () => {
    // Without the unsupported-PM branch, `apt-get install foo` would
    // fall through to `unrecognized_input` and the homepage form would
    // render the generic "not a recognized tool" copy. The dedicated
    // bucket lets the client surface "PM isn't supported, try cargo /
    // brew / npm / pip / bun / uv / go" instead.
    const unsupportedCases = [
      'apt-get install foo',
      'apt install foo',
      'dnf install foo',
      'yum install foo',
      'zypper install foo',
      'pacman -S foo',
      'snap install foo',
      'flatpak install foo',
      'port install foo',
      'choco install foo',
      'scoop install foo',
      'winget install foo',
      'gem install foo',
      'composer require foo',
      'emerge foo',
    ];
    for (const cmd of unsupportedCases) {
      expect(validateInput(cmd, REGISTRY)).toEqual({
        kind: 'unknown',
        error: 'unparseable_install_command',
      });
    }
  });
});

describe('validateInput — github URL', () => {
  test('repo-root URL', () => {
    expect(validateInput('https://github.com/foo/bar', REGISTRY)).toEqual({
      kind: 'github-url',
      owner: 'foo',
      repo: 'bar',
    });
  });

  test('repo-root URL with .git suffix', () => {
    expect(validateInput('https://github.com/foo/bar.git', REGISTRY)).toEqual({
      kind: 'github-url',
      owner: 'foo',
      repo: 'bar',
    });
  });

  test('repo-root URL with trailing slash', () => {
    expect(validateInput('https://github.com/foo/bar/', REGISTRY)).toEqual({
      kind: 'github-url',
      owner: 'foo',
      repo: 'bar',
    });
  });

  test('release-asset URL is rejected as invalid_url_path', () => {
    expect(validateInput('https://github.com/foo/bar/releases/download/v1/foo-x86_64.tar.gz', REGISTRY).kind).toBe(
      'unknown',
    );
  });
});

describe('validateInput — branch URL (U8 feature 3)', () => {
  test('/tree/<branch> accepts with branch captured', () => {
    expect(validateInput('https://github.com/foo/bar/tree/main', REGISTRY)).toEqual({
      kind: 'github-url',
      owner: 'foo',
      repo: 'bar',
      branch: 'main',
    });
  });

  test('/tree/<branch> with subpath: branch captures the FULL tail (semantic match with GitHub)', () => {
    // GitHub's own URL routing can't disambiguate `feature/new/<no-subpath>`
    // from `feature/new/<subpath>` without a server round-trip — the URL
    // shape is the same. We accept the full tail as the branch and let
    // the DO's git clone bounce if the branch doesn't exist. Matches
    // GitHub's own semantics: paste-and-share works for the user.
    const r = validateInput('https://github.com/foo/bar/tree/main/docs/file.md', REGISTRY);
    expect(r.kind).toBe('github-url');
    if (r.kind === 'github-url') {
      expect(r.owner).toBe('foo');
      expect(r.repo).toBe('bar');
      // Tail captured as branch; the DO's git clone will validate
      // against the actual ref at clone time.
      expect(r.branch).toBe('main/docs/file.md');
    }
  });

  test('branch name with slash (feature/new-thing) accepts', () => {
    const r = validateInput('https://github.com/foo/bar/tree/feature/new-thing', REGISTRY);
    expect(r.kind).toBe('github-url');
    if (r.kind === 'github-url') expect(r.branch).toBe('feature/new-thing');
  });

  test('empty branch (/tree/) rejected as invalid_url_path', () => {
    expect(validateInput('https://github.com/foo/bar/tree/', REGISTRY)).toEqual({
      kind: 'unknown',
      error: 'invalid_url_path',
    });
  });

  test('trailing slash on branch trims (/tree/main/)', () => {
    const r = validateInput('https://github.com/foo/bar/tree/main/', REGISTRY);
    expect(r.kind).toBe('github-url');
    if (r.kind === 'github-url') expect(r.branch).toBe('main');
  });

  test('default-branch path (no /tree/<branch>) returns github-url WITHOUT branch field', () => {
    const r = validateInput('https://github.com/foo/bar', REGISTRY);
    expect(r.kind).toBe('github-url');
    if (r.kind === 'github-url') expect(r.branch).toBeUndefined();
  });
});

describe('validateInput — owner/repo shorthand (U8 feature 2)', () => {
  test('basic shorthand: `tobi/qmd` → github-url', () => {
    expect(validateInput('tobi/qmd', REGISTRY)).toEqual({
      kind: 'github-url',
      owner: 'tobi',
      repo: 'qmd',
    });
  });

  test('curated owner/repo via shorthand: registry cross-check is the lookupRegistry layer, not validator', () => {
    // The validator routes BurntSushi/ripgrep to github-url. Whether it
    // resolves to a registry hit is the registry-lookup layer's job
    // (lookupRegistry consults by_owner_repo case-insensitively).
    expect(validateInput('BurntSushi/ripgrep', REGISTRY)).toEqual({
      kind: 'github-url',
      owner: 'BurntSushi',
      repo: 'ripgrep',
    });
  });

  test('repo names with dots / underscores / hyphens accept (GitHub-legal)', () => {
    expect(validateInput('foo/my.repo', REGISTRY).kind).toBe('github-url');
    expect(validateInput('foo/my_repo', REGISTRY).kind).toBe('github-url');
    expect(validateInput('foo/my-repo', REGISTRY).kind).toBe('github-url');
  });
});

describe('validateInput — URL error paths', () => {
  test('non-github host rejected', () => {
    expect(validateInput('https://gitlab.com/foo/bar', REGISTRY)).toEqual({
      kind: 'unknown',
      error: 'non_github_host',
    });
  });

  test('bare malformed URL', () => {
    expect(validateInput('https://', REGISTRY).kind).toBe('unknown');
  });

  test('homoglyph host (Cyrillic і in github) rejected via Punycode comparison', () => {
    // `gіthub.com` with Cyrillic 'і' — URL parser encodes to xn--gthub-cph.com
    // and literal hostname comparison rejects it as non_github_host.
    const result = validateInput('https://gіthub.com/foo/bar', REGISTRY);
    expect(result.kind).toBe('unknown');
    if (result.kind === 'unknown') expect(result.error).toBe('non_github_host');
  });
});

describe('validateInput — empty / unknown', () => {
  test('empty string', () => {
    expect(validateInput('', REGISTRY)).toEqual({ kind: 'unknown', error: 'unrecognized_input' });
  });

  test('whitespace only', () => {
    expect(validateInput('   ', REGISTRY)).toEqual({ kind: 'unknown', error: 'unrecognized_input' });
  });

  test('arbitrary text with no shape match', () => {
    expect(validateInput('please score my tool', REGISTRY)).toEqual({
      kind: 'unknown',
      error: 'unrecognized_input',
    });
  });
});

// ============================================================================
// RED TEAM tests (U8 input-handling expansion)
//
// Each new feature carries its own attack surface. Pin the negative paths
// so a future regex relaxation doesn't silently widen the gate.
// ============================================================================

describe('RED TEAM — http:// silent upgrade (feature 1)', () => {
  test('http://github.com/cli/cli → upgraded to https, parsed as github-url (curated cli/cli)', () => {
    // The whole point of the silent upgrade: a user pasting the http://
    // form of a curated tool URL gets the same answer as the https://
    // form. The protocol was the only thing wrong.
    expect(validateInput('http://github.com/cli/cli', REGISTRY)).toEqual({
      kind: 'github-url',
      owner: 'cli',
      repo: 'cli',
    });
  });

  test('http://github.com.evil.com/x/y → upgrade to https, still non_github_host (exact-match hostname)', () => {
    // Substring attack: the attacker's hostname `github.com.evil.com`
    // contains `github.com` as a substring but is NOT equal to it. The
    // URL parser's hostname field is the full `github.com.evil.com`;
    // literal comparison against `github.com` rejects it. The http://
    // upgrade does not weaken this gate — the host check runs AFTER
    // the upgrade on the parsed URL.
    expect(validateInput('http://github.com.evil.com/foo/bar', REGISTRY)).toEqual({
      kind: 'unknown',
      error: 'non_github_host',
    });
  });

  test('http://gitlab.com/foo/bar → upgraded, still non_github_host (gitlab is not github)', () => {
    // Protocol upgrade is silent; host check is not. The upgrade only
    // changes what the user MEANT — it does not move the trust boundary.
    expect(validateInput('http://gitlab.com/foo/bar', REGISTRY)).toEqual({
      kind: 'unknown',
      error: 'non_github_host',
    });
  });

  test('javascript://github.com/x/y → NOT silently upgraded (protocol confusion attack)', () => {
    // The upgrade regex matches `^http://` ONLY. `javascript:` is a
    // different scheme entirely and falls through to URL parsing.
    // URL.parseable but protocol is `javascript:`; non_https_url
    // rejects it.
    const r = validateInput('javascript://github.com/x/y', REGISTRY);
    expect(r.kind).toBe('unknown');
    if (r.kind === 'unknown') {
      // Either non_https_url (parser accepts javascript: as a scheme)
      // OR invalid_url (parser refuses). Both are correct rejects.
      expect(['non_https_url', 'invalid_url']).toContain(r.error);
    }
  });

  test('htp://github.com/foo → genuinely malformed; falls through to invalid_url or unrecognized_input', () => {
    // Typo in protocol — does not match `^http://`. Falls to the URL
    // parser, which may accept `htp:` as a custom scheme. Whichever
    // rejection branch fires, it MUST NOT silently parse as a github-url.
    const r = validateInput('htp://github.com/foo/bar', REGISTRY);
    expect(r.kind).toBe('unknown');
  });

  test('http://192.168.1.1/x/y → upgraded, IP host rejected as non_github_host', () => {
    // Numeric host attempt — URL parser puts the IP in the hostname
    // field; literal comparison against `github.com` rejects.
    expect(validateInput('http://192.168.1.1/foo/bar', REGISTRY)).toEqual({
      kind: 'unknown',
      error: 'non_github_host',
    });
  });

  test('http:// empty (nothing after prefix) → invalid_url', () => {
    expect(validateInput('http://', REGISTRY).kind).toBe('unknown');
  });

  test('HTTP://GitHub.com/foo/bar (uppercased protocol) → upgrade is case-insensitive', () => {
    // Regex uses /i flag. Without it, an uppercase paste would bounce
    // as a non-protocol input and the upgrade wouldn't apply.
    expect(validateInput('HTTP://GitHub.com/foo/bar', REGISTRY)).toEqual({
      kind: 'github-url',
      owner: 'foo',
      repo: 'bar',
    });
  });
});

describe('RED TEAM — owner/repo shorthand (feature 2)', () => {
  test('path traversal: `../etc/passwd` → unrecognized_input', () => {
    // Shorthand regex requires owner+repo to match strict character
    // classes that exclude `..`. The shorthand path doesn't match the
    // pattern so it falls through.
    expect(validateInput('../etc/passwd', REGISTRY)).toEqual({
      kind: 'unknown',
      error: 'unrecognized_input',
    });
  });

  test('three segments: `foo/bar/baz` → falls through (not the shorthand shape)', () => {
    // The shorthand is EXACTLY two segments. Three segments don't
    // match SHORTHAND_RE.
    expect(validateInput('foo/bar/baz', REGISTRY)).toEqual({
      kind: 'unknown',
      error: 'unrecognized_input',
    });
  });

  test('empty owner: `/qmd` → unrecognized_input', () => {
    expect(validateInput('/qmd', REGISTRY)).toEqual({
      kind: 'unknown',
      error: 'unrecognized_input',
    });
  });

  test('empty repo: `tobi/` → unrecognized_input', () => {
    expect(validateInput('tobi/', REGISTRY)).toEqual({
      kind: 'unknown',
      error: 'unrecognized_input',
    });
  });

  test('leading hyphen in owner: `-bad/repo` → unrecognized_input (GitHub rejects too)', () => {
    expect(validateInput('-bad/repo', REGISTRY)).toEqual({
      kind: 'unknown',
      error: 'unrecognized_input',
    });
  });

  test('space in segment: `tobi name/qmd` → unrecognized_input', () => {
    expect(validateInput('tobi name/qmd', REGISTRY)).toEqual({
      kind: 'unknown',
      error: 'unrecognized_input',
    });
  });

  test('owner over 39 chars (GitHub limit) → unrecognized_input', () => {
    const longOwner = 'a'.repeat(40);
    expect(validateInput(`${longOwner}/repo`, REGISTRY)).toEqual({
      kind: 'unknown',
      error: 'unrecognized_input',
    });
  });

  test('repo over 100 chars → unrecognized_input', () => {
    const longRepo = 'a'.repeat(101);
    expect(validateInput(`foo/${longRepo}`, REGISTRY)).toEqual({
      kind: 'unknown',
      error: 'unrecognized_input',
    });
  });

  test('null byte in shorthand: `tobi\\0/qmd` → unrecognized_input', () => {
    // Defense in depth: the segment splitter sees the null byte as a
    // non-printable character that falls outside the strict regex
    // character classes.
    expect(validateInput('tobi /qmd', REGISTRY)).toEqual({
      kind: 'unknown',
      error: 'unrecognized_input',
    });
  });

  test('shell metacharacters in segment: `tobi;rm/qmd` → unrecognized_input', () => {
    expect(validateInput('tobi;rm/qmd', REGISTRY)).toEqual({
      kind: 'unknown',
      error: 'unrecognized_input',
    });
  });

  test('owner with leading-trailing whitespace inside the segment → unrecognized_input', () => {
    // Outer trim happens in validateInput; INNER whitespace can't be
    // trimmed because it would change the user's intent. Strict regex
    // rejects.
    expect(validateInput('to bi/qmd', REGISTRY)).toEqual({
      kind: 'unknown',
      error: 'unrecognized_input',
    });
  });
});

describe('RED TEAM — branch URL (feature 3)', () => {
  test('path-traversal in URL-encoded form: `/tree/..%2Fevil` → URL parser decodes; `..` reject fires', () => {
    // URL parser decodes %2F → /. The peeled branch is then `../evil`.
    // The explicit `..` reject in validBranchName fires.
    const r = validateInput('https://github.com/foo/bar/tree/..%2Fevil', REGISTRY);
    expect(r.kind).toBe('unknown');
    if (r.kind === 'unknown') expect(r.error).toBe('invalid_url_path');
  });

  test('shell metacharacters in branch: `; rm -rf /` → rejected', () => {
    const attempts = [
      'https://github.com/foo/bar/tree/;rm -rf /',
      'https://github.com/foo/bar/tree/$(whoami)',
      'https://github.com/foo/bar/tree/`whoami`',
      'https://github.com/foo/bar/tree/foo&&bar',
      'https://github.com/foo/bar/tree/foo|bar',
      'https://github.com/foo/bar/tree/foo>bar',
      'https://github.com/foo/bar/tree/foo<bar',
      'https://github.com/foo/bar/tree/"quoted"',
      "https://github.com/foo/bar/tree/'quoted'",
    ];
    for (const url of attempts) {
      const r = validateInput(url, REGISTRY);
      expect(r.kind, `expected reject for: ${url}`).toBe('unknown');
    }
  });

  test('over-long branch (>250 chars) → rejected', () => {
    const longBranch = 'a'.repeat(251);
    const r = validateInput(`https://github.com/foo/bar/tree/${longBranch}`, REGISTRY);
    expect(r.kind).toBe('unknown');
    if (r.kind === 'unknown') expect(r.error).toBe('invalid_url_path');
  });

  test('branch with leading dot: `.evil` → rejected (matches git refname rule and dotfile concerns)', () => {
    const r = validateInput('https://github.com/foo/bar/tree/.evil', REGISTRY);
    expect(r.kind).toBe('unknown');
  });

  test('branch with trailing dot: `evil.` → rejected', () => {
    const r = validateInput('https://github.com/foo/bar/tree/evil.', REGISTRY);
    expect(r.kind).toBe('unknown');
  });

  test('valid 250-char branch boundary → accepts', () => {
    // Boundary: exactly 250 chars passes.
    const branch = 'a'.repeat(250);
    const r = validateInput(`https://github.com/foo/bar/tree/${branch}`, REGISTRY);
    expect(r.kind).toBe('github-url');
    if (r.kind === 'github-url') expect(r.branch).toBe(branch);
  });

  test('valid branch with dots, hyphens, underscores: `release/v1.2.3-rc_1` → accepts', () => {
    const r = validateInput('https://github.com/foo/bar/tree/release/v1.2.3-rc_1', REGISTRY);
    expect(r.kind).toBe('github-url');
    if (r.kind === 'github-url') expect(r.branch).toBe('release/v1.2.3-rc_1');
  });
});

describe('validBranchName — direct unit tests (defense-in-depth helper)', () => {
  test('alphanumeric accepts', () => {
    expect(validBranchName('main')).toBe(true);
    expect(validBranchName('v1')).toBe(true);
    expect(validBranchName('feature/new-thing')).toBe(true);
    expect(validBranchName('release/v1.2.3')).toBe(true);
  });

  test('rejects `..` anywhere', () => {
    expect(validBranchName('..')).toBe(false);
    expect(validBranchName('foo..bar')).toBe(false);
    expect(validBranchName('../etc')).toBe(false);
    expect(validBranchName('foo/..')).toBe(false);
  });

  test('rejects leading or trailing slash', () => {
    expect(validBranchName('/main')).toBe(false);
    expect(validBranchName('main/')).toBe(false);
  });

  test('rejects leading or trailing dot', () => {
    expect(validBranchName('.main')).toBe(false);
    expect(validBranchName('main.')).toBe(false);
  });

  test('rejects shell metacharacters', () => {
    expect(validBranchName('foo;bar')).toBe(false);
    expect(validBranchName('foo$bar')).toBe(false);
    expect(validBranchName('foo`bar')).toBe(false);
    expect(validBranchName('foo(bar)')).toBe(false);
    expect(validBranchName('foo&bar')).toBe(false);
    expect(validBranchName('foo|bar')).toBe(false);
    expect(validBranchName('foo>bar')).toBe(false);
    expect(validBranchName('foo bar')).toBe(false);
    expect(validBranchName('foo"bar')).toBe(false);
    expect(validBranchName("foo'bar")).toBe(false);
  });

  test('rejects empty', () => {
    expect(validBranchName('')).toBe(false);
  });

  test('rejects over 250 chars', () => {
    expect(validBranchName('a'.repeat(251))).toBe(false);
    expect(validBranchName('a'.repeat(250))).toBe(true);
  });
});
