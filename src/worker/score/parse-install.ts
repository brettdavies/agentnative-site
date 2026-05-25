// Install-command parser table. Pure function; no I/O, no async.
//
// Plan U4 (docs/plans/2026-04-28-002-feat-live-scoring-cf-sandbox-plan.md
// lines 1092-1103). Mirrors the table in U1's KNOWN_PM contract
// (src/build/registry-index.mjs).
//
// Inputs that don't match any row return `unparseable_install_command`.
// Test-first per the plan's Execution note: the test suite IS the spec.

export type PM = 'brew' | 'cargo-binstall' | 'bun' | 'pip' | 'uv' | 'npm' | 'go';

export type ParsedInstall = {
  pm: PM;
  package: string;
  binary: string;
};

export type ParseResult = { ok: true; value: ParsedInstall } | { ok: false; error: 'unparseable_install_command' };

const FAIL: ParseResult = { ok: false, error: 'unparseable_install_command' };

// Tokenize on whitespace, drop empty leading/trailing slots. Treats `$ ` /
// `> ` shell prompts as part of the surrounding whitespace so a pasted
// `$ brew install ripgrep` parses identically to `brew install ripgrep`.
function tokenize(raw: string): string[] {
  return raw
    .replace(/^\s*\$?\s*/, '')
    .trim()
    .split(/\s+/);
}

// Find the first non-flag positional argument starting at index `from`.
// Flags are tokens starting with `-`. Used for npm/pip/bun/yarn/pnpm
// shapes where ordering is `<verb> [flags...] <pkg>`.
function firstPositional(tokens: string[], from: number): string | undefined {
  for (let i = from; i < tokens.length; i++) {
    if (!tokens[i].startsWith('-')) return tokens[i];
  }
  return undefined;
}

export function parseInstallCommand(raw: string): ParseResult {
  const tokens = tokenize(raw);
  if (tokens.length === 0) return FAIL;
  const head = tokens[0];

  switch (head) {
    case 'brew': {
      // brew install <pkg> | brew <pkg> (shorthand the plan accepts)
      const pkg = tokens[1] === 'install' ? tokens[2] : tokens[1];
      if (!pkg) return FAIL;
      return { ok: true, value: { pm: 'brew', package: pkg, binary: pkg } };
    }
    case 'cargo': {
      // cargo install <pkg> | cargo binstall <pkg>
      // Both map to cargo-binstall because U2's image refuses compile paths.
      // cargo install without a binstallable asset will fail at U6 install
      // time and bounce as chain_resolved_install_failed.
      const verb = tokens[1];
      if (verb !== 'install' && verb !== 'binstall') return FAIL;
      const pkg = firstPositional(tokens, 2);
      if (!pkg) return FAIL;
      return { ok: true, value: { pm: 'cargo-binstall', package: pkg, binary: pkg } };
    }
    case 'bun': {
      // bun add -g <pkg> | bun install -g <pkg> | bun i -g <pkg>
      const verb = tokens[1];
      if (verb !== 'add' && verb !== 'install' && verb !== 'i') return FAIL;
      const pkg = firstPositional(tokens, 2);
      if (!pkg) return FAIL;
      return { ok: true, value: { pm: 'bun', package: pkg, binary: pkg } };
    }
    case 'uv': {
      // uv tool install <pkg>
      //
      // Split from pm=pip in the 2026-05-18 U6 rework: the sandbox image
      // now ships native uv (pinned tarball + sha256), so uv-shape inputs
      // run through `uv tool install <pkg>` end-to-end rather than being
      // silently downgraded to `pip install <pkg>`. The resolver and
      // wheel-fetch paths differ enough that conflating them masked the
      // pip metadata 403 (Bug M) that uv does not exhibit.
      if (tokens[1] !== 'tool' || tokens[2] !== 'install') return FAIL;
      const pkg = firstPositional(tokens, 3);
      if (!pkg) return FAIL;
      return { ok: true, value: { pm: 'uv', package: pkg, binary: pkg } };
    }
    case 'pip':
    case 'pip3':
    case 'pipx': {
      // pip install <pkg> | pip3 install <pkg> | pipx install <pkg>
      if (tokens[1] !== 'install') return FAIL;
      const pkg = firstPositional(tokens, 2);
      if (!pkg) return FAIL;
      return { ok: true, value: { pm: 'pip', package: pkg, binary: pkg } };
    }
    case 'npm': {
      // npm install -g <pkg> | npm i -g <pkg>
      const verb = tokens[1];
      if (verb !== 'install' && verb !== 'i') return FAIL;
      const pkg = firstPositional(tokens, 2);
      if (!pkg) return FAIL;
      // binary name for npm packages frequently differs from the package
      // name (e.g. `npm i -g typescript` -> `tsc`). U6 resolves the real
      // binary by reading `package.bin` after install. We default to
      // package=binary here; the U6 `which` check + bounce class handles
      // the mismatch case.
      return { ok: true, value: { pm: 'npm', package: pkg, binary: pkg } };
    }
    case 'yarn': {
      // yarn global add <pkg>
      if (tokens[1] !== 'global' || tokens[2] !== 'add') return FAIL;
      const pkg = firstPositional(tokens, 3);
      if (!pkg) return FAIL;
      return { ok: true, value: { pm: 'npm', package: pkg, binary: pkg } };
    }
    case 'pnpm': {
      // pnpm add -g <pkg>
      if (tokens[1] !== 'add') return FAIL;
      const pkg = firstPositional(tokens, 2);
      if (!pkg) return FAIL;
      return { ok: true, value: { pm: 'npm', package: pkg, binary: pkg } };
    }
    case 'go': {
      // go install <module>@latest
      if (tokens[1] !== 'install') return FAIL;
      const module_ = tokens[2];
      if (!module_) return FAIL;
      // Strip @latest / @vX.Y.Z suffix, derive binary from the last path
      // segment per `go install`'s default-binary-name rule.
      const pkg = module_.split('@')[0];
      const binary = pkg.split('/').pop() ?? pkg;
      if (!binary) return FAIL;
      return { ok: true, value: { pm: 'go', package: pkg, binary } };
    }
    default:
      return FAIL;
  }
}
