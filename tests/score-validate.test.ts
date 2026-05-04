import { describe, expect, test } from 'bun:test';
import { validateInput } from '../src/worker/score/validate';

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

  test('branch path /tree/main is rejected', () => {
    expect(validateInput('https://github.com/foo/bar/tree/main', REGISTRY)).toEqual({
      kind: 'unknown',
      error: 'invalid_url_path',
    });
  });

  test('release-asset URL is rejected as invalid_url_path', () => {
    expect(validateInput('https://github.com/foo/bar/releases/download/v1/foo-x86_64.tar.gz', REGISTRY).kind).toBe(
      'unknown',
    );
  });
});

describe('validateInput — URL error paths', () => {
  test('non-https URL rejected', () => {
    expect(validateInput('http://github.com/foo/bar', REGISTRY)).toEqual({
      kind: 'unknown',
      error: 'non_https_url',
    });
  });

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
