import { describe, expect, test } from 'bun:test';
import {
  buildDiscoveryHintsIndex,
  buildRegistryIndex,
  deriveOwnerRepo,
  KNOWN_PM,
  loadDiscoveryHints,
} from '../src/build/registry-index.mjs';

const REPO_ROOT = new URL('..', import.meta.url).pathname;

// Shape of one buildRegistryIndex() projected entry — narrows the
// loosely-typed (object) by_slug/by_owner_repo maps for indexed access below.
type RegistryIndexEntry = {
  name: string;
  binary: string;
  install: string;
  audit_profile?: string;
  repo?: string;
  version?: string;
  anc_version?: string;
  scorecard_url?: string;
  score_pct?: number;
};

type RegistryIndex = {
  by_slug: Record<string, RegistryIndexEntry>;
  by_owner_repo: Record<string, RegistryIndexEntry>;
};

// Shape of one buildDiscoveryHintsIndex() projected entry.
type DiscoveryHintEntry = {
  pm: string;
  package: string;
  binary: string;
  note?: string;
};

type DiscoveryHintsIndex = {
  by_owner_repo: Record<string, DiscoveryHintEntry>;
};

describe('deriveOwnerRepo', () => {
  test('returns repo when present and well-formed', () => {
    expect(deriveOwnerRepo({ name: 'rg', repo: 'BurntSushi/ripgrep' })).toBe('BurntSushi/ripgrep');
  });

  test('parses owner/repo from a github url when repo absent', () => {
    expect(deriveOwnerRepo({ name: 'foo', url: 'https://github.com/foo/bar' })).toBe('foo/bar');
  });

  test('strips trailing .git from a github url', () => {
    expect(deriveOwnerRepo({ name: 'foo', url: 'https://github.com/foo/bar.git' })).toBe('foo/bar');
  });

  test('returns null for non-github urls', () => {
    expect(deriveOwnerRepo({ name: 'make', url: 'https://www.gnu.org/software/make/' })).toBeNull();
  });

  test('returns null when neither repo nor url is present', () => {
    expect(deriveOwnerRepo({ name: 'mystery' })).toBeNull();
  });

  test('rejects malformed repo strings', () => {
    expect(deriveOwnerRepo({ name: 'foo', repo: 'just-a-name' })).toBeNull();
  });
});

describe('buildRegistryIndex', () => {
  test('happy path: every tool keyed in by_slug; tools with owner/repo also keyed in by_owner_repo', () => {
    const reg = [
      { name: 'rg', binary: 'rg', install: 'brew install ripgrep', repo: 'BurntSushi/ripgrep' },
      { name: 'fd', binary: 'fd', install: 'brew install fd', repo: 'sharkdp/fd' },
    ];
    const { index, warnings } = buildRegistryIndex(reg);
    expect(Object.keys(index.by_slug)).toEqual(['rg', 'fd']);
    expect(Object.keys(index.by_owner_repo)).toEqual(['BurntSushi/ripgrep', 'sharkdp/fd']);
    expect(warnings).toEqual([]);
  });

  test('round-trips audit_profile when present', () => {
    const reg = [
      {
        name: 'rg',
        binary: 'rg',
        install: 'brew install ripgrep',
        repo: 'BurntSushi/ripgrep',
        audit_profile: 'file-traversal',
      },
    ];
    const { index } = buildRegistryIndex(reg) as { index: RegistryIndex; warnings: string[] };
    expect(index.by_slug.rg.audit_profile).toBe('file-traversal');
    expect(index.by_owner_repo['BurntSushi/ripgrep'].audit_profile).toBe('file-traversal');
  });

  test('tool with url-only (no repo) is keyed by parsed owner/repo from url', () => {
    const reg = [{ name: 'foo', binary: 'foo', install: 'brew install foo', url: 'https://github.com/owner/foo' }];
    const { index } = buildRegistryIndex(reg) as { index: RegistryIndex; warnings: string[] };
    expect(index.by_owner_repo['owner/foo']).toBeDefined();
  });

  test('tool with neither repo nor github url emits warning, by_slug entry preserved, by_owner_repo skipped', () => {
    const reg = [{ name: 'make', binary: 'make', install: 'brew install make', url: 'https://gnu.org/make' }];
    const { index, warnings } = buildRegistryIndex(reg) as { index: RegistryIndex; warnings: string[] };
    expect(index.by_slug.make).toBeDefined();
    expect(index.by_owner_repo).toEqual({});
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"make"');
    expect(warnings[0]).toContain('owner/repo entry skipped');
  });

  test('two tools sharing owner/repo emit collision warning, second wins', () => {
    const reg = [
      { name: 'wrangler', binary: 'wrangler', install: 'npm i -g wrangler', repo: 'cloudflare/workers-sdk' },
      { name: 'cf', binary: 'cf', install: 'npm i -g wrangler', repo: 'cloudflare/workers-sdk' },
    ];
    const { index, warnings } = buildRegistryIndex(reg) as { index: RegistryIndex; warnings: string[] };
    expect(index.by_owner_repo['cloudflare/workers-sdk'].name).toBe('cf');
    expect(index.by_slug.wrangler).toBeDefined();
    expect(index.by_slug.cf).toBeDefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('cloudflare/workers-sdk');
    expect(warnings[0]).toContain('overwritten');
  });
});

describe('buildDiscoveryHintsIndex', () => {
  const emptyRegistryIndex = { by_slug: {}, by_owner_repo: {} };

  test('happy path: hints projected to {pm, package, binary, note?}', () => {
    const hints = [
      {
        owner_repo: 'Aider-AI/aider',
        pm: 'pip',
        package: 'aider-chat',
        binary: 'aider',
        note: 'because reasons',
      },
    ];
    const { index, warnings } = buildDiscoveryHintsIndex(hints, emptyRegistryIndex) as {
      index: DiscoveryHintsIndex;
      warnings: string[];
    };
    expect(index.by_owner_repo['Aider-AI/aider']).toEqual({
      pm: 'pip',
      package: 'aider-chat',
      binary: 'aider',
      note: 'because reasons',
    });
    expect(warnings).toEqual([]);
  });

  test('hint with unknown pm fails build', () => {
    const hints = [{ owner_repo: 'foo/bar', pm: 'yum', package: 'foo', binary: 'foo' }];
    expect(() => buildDiscoveryHintsIndex(hints, emptyRegistryIndex)).toThrow(/unknown pm "yum"/);
  });

  test('hint with malformed owner_repo fails build', () => {
    const hints = [{ owner_repo: 'just-a-name', pm: 'pip', package: 'foo', binary: 'foo' }];
    expect(() => buildDiscoveryHintsIndex(hints, emptyRegistryIndex)).toThrow(/owner_repo as "<owner>\/<repo>"/);
  });

  test('hint missing required field fails build', () => {
    const hints = [{ owner_repo: 'foo/bar', pm: 'pip', package: 'foo' }]; // missing binary
    expect(() => buildDiscoveryHintsIndex(hints, emptyRegistryIndex)).toThrow(/missing required field/);
  });

  test('hint colliding with registry entry is dropped with warning (registry wins)', () => {
    const registryIndex = {
      by_slug: {},
      by_owner_repo: { 'foo/bar': { name: 'foo', binary: 'foo', install: 'brew install foo' } },
    };
    const hints = [{ owner_repo: 'foo/bar', pm: 'pip', package: 'foo', binary: 'foo' }];
    const { index, warnings } = buildDiscoveryHintsIndex(hints, registryIndex) as {
      index: DiscoveryHintsIndex;
      warnings: string[];
    };
    expect(index.by_owner_repo).toEqual({});
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('foo/bar');
    expect(warnings[0]).toContain('registry wins');
  });

  test('duplicate hint emits warning, second wins', () => {
    const hints = [
      { owner_repo: 'foo/bar', pm: 'pip', package: 'first', binary: 'first' },
      { owner_repo: 'foo/bar', pm: 'pip', package: 'second', binary: 'second' },
    ];
    const { index, warnings } = buildDiscoveryHintsIndex(hints, emptyRegistryIndex) as {
      index: DiscoveryHintsIndex;
      warnings: string[];
    };
    expect(index.by_owner_repo['foo/bar'].package).toBe('second');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('duplicate hint');
  });

  test('note is optional', () => {
    const hints = [{ owner_repo: 'foo/bar', pm: 'pip', package: 'foo', binary: 'foo' }];
    const { index } = buildDiscoveryHintsIndex(hints, emptyRegistryIndex) as {
      index: DiscoveryHintsIndex;
      warnings: string[];
    };
    expect(index.by_owner_repo['foo/bar']).toEqual({ pm: 'pip', package: 'foo', binary: 'foo' });
  });
});

describe('KNOWN_PM contract', () => {
  test('mirrors U4 parse-install table values (brew/cargo-binstall/bun/pip/npm/go)', () => {
    expect([...KNOWN_PM].sort()).toEqual(['brew', 'bun', 'cargo-binstall', 'go', 'npm', 'pip']);
  });

  test('does NOT include "direct" (reserved for U4 step 1 URL paste, not a hint pm)', () => {
    expect(KNOWN_PM.has('direct')).toBe(false);
  });
});

describe('loadDiscoveryHints (integration with the real file)', () => {
  test('loads + parses discovery-hints.yaml at repo root', async () => {
    const hints = await loadDiscoveryHints(`${REPO_ROOT}discovery-hints.yaml`);
    expect(Array.isArray(hints)).toBe(true);
    expect(hints.length).toBeGreaterThanOrEqual(3);
    for (const h of hints) {
      expect(h.owner_repo).toBeTruthy();
      expect(h.pm).toBeTruthy();
      expect(h.package).toBeTruthy();
      expect(h.binary).toBeTruthy();
    }
  });
});
