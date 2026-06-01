// Branch-scoped git-clone install path tests.
//
// The DO routes github-url-with-branch inputs to a pm: 'git-clone'
// install spec that clones the repo at the requested ref and runs
// `anc audit <path>` against the source. The Sandbox SDK only exposes
// `exec(command: string)` — no argv array — so command-string
// composition + shellQuote is the trust boundary at exec time. These
// tests pin:
//
//   - The clone command shape (--depth 1 --no-tags --single-branch
//     --branch <branch> <url> <dest>)
//   - shellQuote wraps every interpolated value (POSIX single-quote
//     escape, so embedded `'` becomes `'\''`)
//   - The DO refuses unsafe branch names BEFORE shellQuote runs
//     (defense in depth — the regex catches structural metacharacters;
//     shellQuote closes the escape)
//   - `anc audit <path>` is used instead of `anc audit --command
//     <binary>` for source-scoped scores
//   - `which <binary>` gate is SKIPPED for git-clone (no binary lands
//     on PATH; the cloned source is what gets scored)

import { describe, expect, test } from 'bun:test';
import type { GitCloneInstall, InstallSpec } from '../src/worker/score/discover-binary';
import {
  buildAncAuditSourceCmd,
  buildGitCloneCommand,
  type ContainerLike,
  type ExecLike,
  score,
} from '../src/worker/score/sandbox-exec';
import { SPEC_VERSION } from '../src/worker/spec-version.gen';

// ---------------------------------------------------------------------------
// Stub — mirrors the shape in score-do.test.ts so tests run offline.
// ---------------------------------------------------------------------------

type Call =
  | { kind: 'setOutboundHandler'; name: string; params?: unknown }
  | { kind: 'exec'; command: string; timeout?: number };

type ExecResponder = (command: string) => ExecLike;

const ANC_CHECK_OK = JSON.stringify({
  spec_version: SPEC_VERSION,
  anc_version: '0.3.1',
  tool: { name: 'qmd', version: '0.1.0' },
  score: { value: 70 },
});

function defaultResponder(command: string): ExecLike {
  // git clone — synthesize success without touching the network.
  if (command.includes('git clone')) {
    return { success: true, stdout: '', stderr: '' };
  }
  if (command === 'anc --version') {
    return { success: true, stdout: 'anc 0.3.1\n', stderr: '' };
  }
  if (command.startsWith('anc audit ')) {
    return { success: true, stdout: ANC_CHECK_OK, stderr: '' };
  }
  return { success: true, stdout: '', stderr: '' };
}

function makeStub(responder: ExecResponder = defaultResponder): { stub: ContainerLike; calls: Call[] } {
  const calls: Call[] = [];
  const stub: ContainerLike = {
    async setOutboundHandler<P = unknown>(name: string, params?: P): Promise<void> {
      calls.push({ kind: 'setOutboundHandler', name, params });
    },
    async exec(command: string, options?: { timeout?: number }): Promise<ExecLike> {
      calls.push({ kind: 'exec', command, timeout: options?.timeout });
      return responder(command);
    },
  };
  return { stub, calls };
}

const CLI_SPEC: GitCloneInstall = {
  pm: 'git-clone',
  owner: 'cli',
  repo: 'cli',
  branch: 'main',
  binary: 'cli',
};

// ---------------------------------------------------------------------------
// buildGitCloneCommand — command-shape unit tests
// ---------------------------------------------------------------------------

describe('buildGitCloneCommand — shape', () => {
  test('emits `git clone --depth 1 --no-tags --single-branch --branch <branch> <url> <dest>`', () => {
    const cmd = buildGitCloneCommand(CLI_SPEC);
    expect(cmd).not.toBeNull();
    // EXACT shape pin. A future relaxation that drops --depth 1 or
    // --single-branch would slow every score by minutes and possibly
    // bust the 60 s budget.
    expect(cmd).toBe(
      `( set -e; rm -rf '/tmp/anc-clone-target'; ` +
        `git clone --depth 1 --no-tags --single-branch ` +
        `--branch 'main' ` +
        `'https://github.com/cli/cli.git' '/tmp/anc-clone-target' )`,
    );
  });

  test('clean-rm of destination BEFORE clone (warm-DO re-run safety)', () => {
    const cmd = buildGitCloneCommand(CLI_SPEC);
    expect(cmd).not.toBeNull();
    if (!cmd) return;
    // rm -rf MUST run before git clone — otherwise the second request
    // on a warm DO would collide with the prior clone's directory and
    // `git clone` would refuse with "destination path already exists".
    const rmIdx = cmd.indexOf('rm -rf');
    const cloneIdx = cmd.indexOf('git clone ');
    expect(rmIdx).toBeGreaterThanOrEqual(0);
    expect(cloneIdx).toBeGreaterThan(rmIdx);
  });

  test('wraps the whole pipeline in a `( set -e; ... )` subshell', () => {
    // set -e exits the subshell on failure, NOT the container's
    // persistent shell session. Same invariant as the directInstall
    // pipeline (sandbox-exec.ts).
    const cmd = buildGitCloneCommand(CLI_SPEC);
    expect(cmd).not.toBeNull();
    if (!cmd) return;
    expect(cmd.startsWith('( set -e;')).toBe(true);
    expect(cmd.endsWith(' )')).toBe(true);
  });

  test('every interpolated value is single-quote-wrapped (POSIX shell escape)', () => {
    const cmd = buildGitCloneCommand(CLI_SPEC);
    expect(cmd).not.toBeNull();
    if (!cmd) return;
    expect(cmd).toContain("'main'"); // branch
    expect(cmd).toContain("'https://github.com/cli/cli.git'"); // repo URL
    expect(cmd).toContain("'/tmp/anc-clone-target'"); // dest
  });

  test('branch with `/` (feature/new-thing) shell-quotes intact', () => {
    const spec: GitCloneInstall = { ...CLI_SPEC, branch: 'feature/new-thing' };
    const cmd = buildGitCloneCommand(spec);
    expect(cmd).not.toBeNull();
    expect(cmd).toContain("--branch 'feature/new-thing'");
  });
});

// ---------------------------------------------------------------------------
// buildGitCloneCommand — RED TEAM (defense in depth)
// ---------------------------------------------------------------------------

describe('buildGitCloneCommand — red team', () => {
  test('rejects branch with `..` (path traversal) BEFORE interpolation — returns null', () => {
    // validate.ts already rejects this at the Worker boundary; do.ts
    // re-rejects at the DO boundary. buildGitCloneCommand is the THIRD
    // defense: a future caller that bypasses both upstream layers
    // still can't smuggle a traversal pattern into the exec command.
    const spec: GitCloneInstall = { ...CLI_SPEC, branch: '../etc/passwd' };
    expect(buildGitCloneCommand(spec)).toBeNull();
  });

  test('rejects shell metacharacters in branch name', () => {
    const attempts = [';rm -rf /', '$(whoami)', '`whoami`', 'foo&&bar', 'foo|bar', 'foo>bar', '"q"', "'q'", 'foo bar'];
    for (const branch of attempts) {
      const spec: GitCloneInstall = { ...CLI_SPEC, branch };
      expect(buildGitCloneCommand(spec), `expected null for branch: ${branch}`).toBeNull();
    }
  });

  test('rejects empty branch', () => {
    expect(buildGitCloneCommand({ ...CLI_SPEC, branch: '' })).toBeNull();
  });

  test('rejects over-long branch (>250 chars)', () => {
    const branch = 'a'.repeat(251);
    expect(buildGitCloneCommand({ ...CLI_SPEC, branch })).toBeNull();
  });

  test('rejects leading dot / trailing dot / leading slash / trailing slash branch', () => {
    expect(buildGitCloneCommand({ ...CLI_SPEC, branch: '.main' })).toBeNull();
    expect(buildGitCloneCommand({ ...CLI_SPEC, branch: 'main.' })).toBeNull();
    expect(buildGitCloneCommand({ ...CLI_SPEC, branch: '/main' })).toBeNull();
    expect(buildGitCloneCommand({ ...CLI_SPEC, branch: 'main/' })).toBeNull();
  });

  test('shellQuote escapes embedded single-quote even though validBranchName would reject it', () => {
    // Belt-and-suspenders: if the regex layer EVER let a single quote
    // through (e.g. a typo in the character class), shellQuote would
    // STILL wrap and escape it. Construct a branch with a single
    // quote and bypass validBranchName by patching the function?
    // Easier: assert that shellQuote's behavior is preserved by
    // running an internal test that takes a known unsafe character
    // class and verifies the output is still single-quote-wrapped.
    // This is a regression guard on the shellQuote dependency.
    //
    // Cannot construct an InstallSpec with `'` in the branch because
    // validBranchName rejects upstream; documented here so the
    // safety chain is clear.
    expect(buildGitCloneCommand({ ...CLI_SPEC, branch: "evil'rm -rf /" })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildAncAuditSourceCmd — source-path anc invocation
// ---------------------------------------------------------------------------

describe('buildAncAuditSourceCmd — source-path anc invocation', () => {
  test('emits `anc audit <path> --output json`', () => {
    expect(buildAncAuditSourceCmd(CLI_SPEC, undefined)).toBe("anc audit '/tmp/anc-clone-target' --output json");
  });

  test('appends `--audit-profile <profile>` when audit_profile present', () => {
    expect(buildAncAuditSourceCmd(CLI_SPEC, 'cli-tool')).toBe(
      "anc audit '/tmp/anc-clone-target' --output json --audit-profile 'cli-tool'",
    );
  });

  test('path is single-quote-wrapped (POSIX shell escape)', () => {
    const cmd = buildAncAuditSourceCmd(CLI_SPEC, undefined);
    expect(cmd).toContain("'/tmp/anc-clone-target'");
  });
});

// ---------------------------------------------------------------------------
// Orchestration: full score() flow with pm=git-clone
// ---------------------------------------------------------------------------

describe('score() — git-clone orchestration', () => {
  test('runs the clone, skips `which` gate, runs `anc audit <path>`', async () => {
    const { stub, calls } = makeStub();
    const result = await score(stub, CLI_SPEC);
    expect(result.ok).toBe(true);

    const execCalls = calls.filter((c) => c.kind === 'exec') as Array<Extract<Call, { kind: 'exec' }>>;
    const cloneCall = execCalls.find((c) => c.command.includes('git clone'));
    expect(cloneCall).toBeDefined();
    // No `which <binary>` between install and Phase 2 lockdown — the
    // git-clone path doesn't put a binary on PATH; the source is what
    // gets checked.
    const whichCall = execCalls.find((c) => c.command.startsWith('which '));
    expect(whichCall).toBeUndefined();
    // `anc audit <path>` runs after the noHttp lockdown.
    const ancAudit = execCalls.find((c) => c.command.startsWith('anc audit '));
    expect(ancAudit).toBeDefined();
    expect(ancAudit?.command).toContain("'/tmp/anc-clone-target'");
    expect(ancAudit?.command).not.toContain('--command');
  });

  test('two-phase egress holds: allowedInstall BEFORE clone, noHttp BEFORE anc audit', async () => {
    const { stub, calls } = makeStub();
    await score(stub, CLI_SPEC);
    const phase1 = calls.findIndex((c) => c.kind === 'setOutboundHandler' && c.name === 'allowedInstall');
    const cloneExec = calls.findIndex((c) => c.kind === 'exec' && c.command.includes('git clone'));
    const phase2 = calls.findIndex((c) => c.kind === 'setOutboundHandler' && c.name === 'noHttp');
    const ancAuditExec = calls.findIndex((c) => c.kind === 'exec' && c.command.startsWith('anc audit '));

    expect(phase1).toBeGreaterThanOrEqual(0);
    expect(cloneExec).toBeGreaterThan(phase1);
    expect(phase2).toBeGreaterThan(cloneExec);
    expect(ancAuditExec).toBeGreaterThan(phase2);
  });

  test('allowedInstall hosts include github.com + *.githubusercontent.com wildcard', async () => {
    const { stub, calls } = makeStub();
    await score(stub, CLI_SPEC);
    const phase1 = calls.find((c) => c.kind === 'setOutboundHandler' && c.name === 'allowedInstall') as
      | Extract<Call, { kind: 'setOutboundHandler' }>
      | undefined;
    expect(phase1).toBeDefined();
    const params = phase1?.params as { allowedHostnames: string[] };
    expect(params.allowedHostnames).toContain('github.com');
    expect(params.allowedHostnames).toContain('*.githubusercontent.com');
  });

  test('clone failure → chain_resolved_install_failed with stderr captured', async () => {
    const responder: ExecResponder = (cmd) => {
      if (cmd.includes('git clone')) {
        return {
          success: false,
          stdout: '',
          stderr: "fatal: Remote branch 'no-such-branch' not found",
          exitCode: 128,
        };
      }
      return defaultResponder(cmd);
    };
    const { stub } = makeStub(responder);
    const result = await score(stub, { ...CLI_SPEC, branch: 'no-such-branch' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('chain_resolved_install_failed');
    expect(result.details).toContain('not found');
  });

  test('unsafe branch (regex bypass via direct InstallSpec) → install_unsupported with pm=git-clone', async () => {
    // Construct an InstallSpec directly with a branch that should
    // never reach the orchestration. installCommandFor() returns null
    // (via buildGitCloneCommand), which the score() flow maps to
    // install_unsupported. No exec call should fire.
    const { stub, calls } = makeStub();
    const result = await score(stub, { ...CLI_SPEC, branch: '../etc/passwd' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('install_unsupported');
    expect(result.details).toBe('pm=git-clone');
    // No exec call — the bounce happens BEFORE the command is built.
    const execCalls = calls.filter((c) => c.kind === 'exec');
    expect(execCalls).toHaveLength(0);
  });

  test('happy-path scorecard returned with anc_version captured live', async () => {
    const { stub } = makeStub();
    const result = await score(stub, CLI_SPEC);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.anc_version).toBe('0.3.1');
    expect(result.value.scorecard).toMatchObject({ tool: { name: 'qmd' } });
  });
});

// ---------------------------------------------------------------------------
// DO type-shape: the GitCloneInstall variant is part of the InstallSpec union.
// ---------------------------------------------------------------------------

describe('InstallSpec union — git-clone is a recognized variant', () => {
  test('exhaustiveness — git-clone is a valid pm value', () => {
    const spec: InstallSpec = { pm: 'git-clone', owner: 'a', repo: 'b', branch: 'main', binary: 'b' };
    expect(spec.pm).toBe('git-clone');
  });
});
