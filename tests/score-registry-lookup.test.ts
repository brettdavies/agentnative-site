import { describe, expect, test } from 'bun:test';
import type { InstallSpec } from '../src/worker/score/discover-binary';
import type { DiscoveryHintsIndex, RegistryIndex } from '../src/worker/score/registry-lookup';
import {
  deriveShareBinary,
  deriveShareBinaryFromSpec,
  lookupRegistry,
  SHARE_URL_BINARY_RE,
} from '../src/worker/score/registry-lookup';
import type { ValidatedInput } from '../src/worker/score/validate';

const REGISTRY: RegistryIndex = {
  by_slug: {
    ripgrep: { name: 'ripgrep', binary: 'rg', install: 'brew install ripgrep', repo: 'BurntSushi/ripgrep' },
  },
  by_owner_repo: {
    'BurntSushi/ripgrep': {
      name: 'ripgrep',
      binary: 'rg',
      install: 'brew install ripgrep',
      repo: 'BurntSushi/ripgrep',
    },
  },
};

const HINTS: DiscoveryHintsIndex = {
  by_owner_repo: {
    'Aider-AI/aider': { pm: 'pip', package: 'aider-chat', binary: 'aider', note: 'foo' },
  },
};

describe('lookupRegistry', () => {
  test('slug input → registry hit by_slug', () => {
    const input: ValidatedInput = { kind: 'slug', slug: 'ripgrep' };
    const r = lookupRegistry(input, REGISTRY, HINTS);
    expect(r.kind).toBe('registry');
    if (r.kind === 'registry') expect(r.entry.name).toBe('ripgrep');
  });

  test('slug input not in registry → miss', () => {
    const input: ValidatedInput = { kind: 'slug', slug: 'not-a-real-tool' };
    expect(lookupRegistry(input, REGISTRY, HINTS).kind).toBe('miss');
  });

  test('github-url input → registry hit by_owner_repo', () => {
    const input: ValidatedInput = { kind: 'github-url', owner: 'BurntSushi', repo: 'ripgrep' };
    const r = lookupRegistry(input, REGISTRY, HINTS);
    expect(r.kind).toBe('registry');
  });

  test('github-url, registry miss, hint hit → kind: hint', () => {
    const input: ValidatedInput = { kind: 'github-url', owner: 'Aider-AI', repo: 'aider' };
    const r = lookupRegistry(input, REGISTRY, HINTS);
    expect(r.kind).toBe('hint');
    if (r.kind === 'hint') {
      expect(r.hint.pm).toBe('pip');
      expect(r.hint.package).toBe('aider-chat');
      expect(r.hint.binary).toBe('aider');
    }
  });

  test('github-url with case-mismatched owner/repo → still hits hint (case-insensitive)', () => {
    const input: ValidatedInput = { kind: 'github-url', owner: 'aider-ai', repo: 'AIDER' };
    const r = lookupRegistry(input, REGISTRY, HINTS);
    expect(r.kind).toBe('hint');
  });

  test('github-url with case-mismatched owner/repo → still hits registry (case-insensitive)', () => {
    const input: ValidatedInput = { kind: 'github-url', owner: 'burntsushi', repo: 'RIPGREP' };
    const r = lookupRegistry(input, REGISTRY, HINTS);
    expect(r.kind).toBe('registry');
  });

  test('github-url, registry AND hints miss → miss', () => {
    const input: ValidatedInput = { kind: 'github-url', owner: 'totally', repo: 'unknown' };
    expect(lookupRegistry(input, REGISTRY, HINTS).kind).toBe('miss');
  });

  test('install-command with curated binary → registry hit (cross-check by spec.binary)', () => {
    // `cargo install ripgrep` parses to binary='ripgrep'. The curated
    // by_slug map has ripgrep, so this should hit registry, not fall
    // through to the cache + live path. Catches the bat-shaped class of
    // install-command-resolving-to-curated-tool inputs that previously
    // paid sandbox cost for a tool already audited.
    const input: ValidatedInput = {
      kind: 'install-command',
      spec: { pm: 'cargo-binstall', package: 'ripgrep', binary: 'ripgrep' },
    };
    const r = lookupRegistry(input, REGISTRY, HINTS);
    expect(r.kind).toBe('registry');
    if (r.kind === 'registry') {
      expect(r.entry.name).toBe('ripgrep');
      expect(r.entry.binary).toBe('rg'); // curated entry's actual binary, not the parser's binary
    }
  });

  test('install-command with non-curated binary → miss (live path)', () => {
    const input: ValidatedInput = {
      kind: 'install-command',
      spec: { pm: 'brew', package: 'obscure-tool', binary: 'obscure-tool' },
    };
    expect(lookupRegistry(input, REGISTRY, HINTS).kind).toBe('miss');
  });

  test('install-command binary-alias edge case (cargo install <binary-not-package>) → miss', () => {
    // Typing `cargo install rg` (the binary name, not the cargo package
    // name 'ripgrep') makes the parser report binary='rg'. by_slug has
    // 'ripgrep' but not 'rg' (rg is curated under tool.binary, not
    // tool.name). Documented edge case — falls through to live path.
    const input: ValidatedInput = {
      kind: 'install-command',
      spec: { pm: 'cargo-binstall', package: 'rg', binary: 'rg' },
    };
    expect(lookupRegistry(input, REGISTRY, HINTS).kind).toBe('miss');
  });

  test('unknown input → miss', () => {
    const input: ValidatedInput = { kind: 'unknown', error: 'unrecognized_input' };
    expect(lookupRegistry(input, REGISTRY, HINTS).kind).toBe('miss');
  });

  test('order: registry beats hint for the same owner/repo (committed scorecards win)', () => {
    const registry: RegistryIndex = {
      by_slug: {},
      by_owner_repo: {
        'foo/bar': { name: 'foo', binary: 'foo', install: 'brew install foo' },
      },
    };
    const hints: DiscoveryHintsIndex = {
      by_owner_repo: {
        'foo/bar': { pm: 'pip', package: 'foo-different', binary: 'foo' },
      },
    };
    const input: ValidatedInput = { kind: 'github-url', owner: 'foo', repo: 'bar' };
    const r = lookupRegistry(input, registry, hints);
    expect(r.kind).toBe('registry');
  });
});

describe('deriveShareBinary — branch-aware', () => {
  test('github-url WITHOUT branch + matching hint → binary derived from hint', () => {
    const input: ValidatedInput = { kind: 'github-url', owner: 'Aider-AI', repo: 'aider' };
    expect(deriveShareBinary(input, HINTS)).toBe('aider');
  });

  test('github-url WITH branch returns null (branch-scoped scores are one-off, no share URL)', () => {
    // /score/live/<binary> is keyed by binary alone. Returning a share
    // URL for a branch-scoped score would clobber the default-branch
    // scorecard at the same key on subsequent lookups. The branch
    // request returns inline; the user keeps the scorecard, can't
    // bookmark a branch-scoped URL today.
    const input: ValidatedInput = { kind: 'github-url', owner: 'Aider-AI', repo: 'aider', branch: 'main' };
    expect(deriveShareBinary(input, HINTS)).toBeNull();
  });

  test('install-command kind passes through unchanged (no branch concept)', () => {
    const input: ValidatedInput = {
      kind: 'install-command',
      spec: { pm: 'pip', package: 'black', binary: 'black' },
    };
    expect(deriveShareBinary(input, HINTS)).toBe('black');
  });

  test('install-command with slug-incompatible binary (uppercase) → null', () => {
    // Defense in depth — install-command parser doesn't normalize case,
    // so a hypothetical paste like `pip install MyTool` (where the
    // package == binary == 'MyTool') must not mint a URL the
    // /score/live/<binary> route refuses to serve.
    const input: ValidatedInput = {
      kind: 'install-command',
      spec: { pm: 'pip', package: 'MyTool', binary: 'MyTool' },
    };
    expect(deriveShareBinary(input, HINTS)).toBeNull();
  });

  test('hint with slug-incompatible binary → null', () => {
    // Hints are author-curated, but the same slug-shape gate applies so
    // a typo in src/data/hints/ can't bypass the route's regex.
    const hints: DiscoveryHintsIndex = {
      by_owner_repo: { 'foo/bar': { pm: 'pip', package: 'foo', binary: 'My_Tool' } },
    };
    const input: ValidatedInput = { kind: 'github-url', owner: 'foo', repo: 'bar' };
    expect(deriveShareBinary(input, hints)).toBeNull();
  });
});

describe('deriveShareBinaryFromSpec — post-discovery derivation', () => {
  test('direct (releases-asset) spec → binary passes through', () => {
    const spec: InstallSpec = {
      pm: 'direct',
      url: 'https://github.com/sharkdp/hexyl/releases/download/v0.16.0/hexyl-x86_64-linux.tar.gz',
      binary: 'hexyl',
    };
    expect(deriveShareBinaryFromSpec(spec)).toBe('hexyl');
  });

  test('parsed-install spec (any PM) → binary passes through', () => {
    for (const pm of ['brew', 'cargo-binstall', 'bun', 'pip', 'uv', 'npm', 'go'] as const) {
      const spec: InstallSpec = { pm, package: 'foo', binary: 'foo' };
      expect(deriveShareBinaryFromSpec(spec)).toBe('foo');
    }
  });

  test('git-clone spec → null (branch-scoped, no shareable surface)', () => {
    const spec: InstallSpec = {
      pm: 'git-clone',
      owner: 'sharkdp',
      repo: 'hexyl',
      branch: 'feature/x',
      binary: 'hexyl',
    };
    expect(deriveShareBinaryFromSpec(spec)).toBeNull();
  });

  test('uppercase / underscore / period / leading hyphen → null', () => {
    for (const binary of ['MyTool', 'my_tool', 'tool.js', '-bad']) {
      const spec: InstallSpec = { pm: 'direct', url: 'https://x', binary };
      expect(deriveShareBinaryFromSpec(spec)).toBeNull();
    }
  });

  test('empty binary → null (refuse to mint /score/live/)', () => {
    const spec: InstallSpec = { pm: 'direct', url: 'https://x', binary: '' };
    expect(deriveShareBinaryFromSpec(spec)).toBeNull();
  });

  test('over-long binary (>64 chars) → null', () => {
    const spec: InstallSpec = { pm: 'direct', url: 'https://x', binary: 'a'.repeat(65) };
    expect(deriveShareBinaryFromSpec(spec)).toBeNull();
  });
});

describe('SHARE_URL_BINARY_RE — invariant', () => {
  test('matches the /score/live/<binary> route slug shape exactly', () => {
    // The summary-render.ts BINARY_SLUG_RE is `SHARE_URL_BINARY_RE`
    // (re-exported), so any value the handler mints is a value the
    // route accepts. This test pins the source string so a refactor
    // that drifts one without the other fails loudly.
    expect(SHARE_URL_BINARY_RE.source).toBe('^[a-z0-9][a-z0-9-]{0,63}$');
  });
});
