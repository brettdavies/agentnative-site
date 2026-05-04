import { describe, expect, test } from 'bun:test';
import type { DiscoveryHintsIndex, RegistryIndex } from '../src/worker/score/registry-lookup';
import { lookupRegistry } from '../src/worker/score/registry-lookup';
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

  test('install-command input → miss (caller passes spec through directly)', () => {
    const input: ValidatedInput = {
      kind: 'install-command',
      spec: { pm: 'brew', package: 'ripgrep', binary: 'ripgrep' },
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
