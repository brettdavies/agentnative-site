// Sandbox DO + two-phase egress orchestration tests.
//
// Plan U6 verification — covers the three test scenarios the plan body
// specifies as MUST:
//
//   (a) Sandbox.outboundHandlers static map has both `allowedInstall`
//       and `noHttp` keys BEFORE any setOutboundHandler call runs.
//       Catches misnamed-key regressions that would silently degrade
//       egress policy.
//
//   (b) Two-phase egress order: setOutboundHandler('allowedInstall', ...)
//       fires BEFORE exec(installCmd), AND setOutboundHandler('noHttp')
//       fires BEFORE exec('anc check ...'). Asserted via a call log on a
//       hand-rolled Container-like stub. This is the load-bearing
//       security invariant for R7.
//
//   (c) Per-request handler log shape: each invocation emits
//       `{phase, host, allowed|blocked}` so attempted-but-blocked egress
//       surfaces in Workers Logs (the rationale for Pattern Y over the
//       simpler static-allowlist Pattern X).
//
// Plus happy-path + every install-table branch + each bounce class.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { InstallSpec } from '../src/worker/score/discover-binary';
import { handlers, Sandbox } from '../src/worker/score/do';
import { type ContainerLike, type ExecLike, score } from '../src/worker/score/sandbox-exec';

// ---------------------------------------------------------------------------
// Stub Sandbox — records every setOutboundHandler + exec call.
// ---------------------------------------------------------------------------

type Call =
  | { kind: 'setOutboundHandler'; name: string; params?: unknown }
  | { kind: 'exec'; command: string; timeout?: number };

type ExecResponder = (command: string) => ExecLike;

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

const ANC_CHECK_OK = JSON.stringify({
  spec_version: '0.4.0',
  anc_version: '0.3.1',
  tool: { name: 'ripgrep', version: '14.1.0' },
  score: { value: 87 },
});

function defaultResponder(command: string): ExecLike {
  if (command.startsWith('which ')) {
    return { success: true, stdout: '/usr/local/bin/rg\n', stderr: '' };
  }
  if (command === 'anc --version') {
    return { success: true, stdout: 'anc 0.3.1\n', stderr: '' };
  }
  if (command.startsWith('anc check ')) {
    return { success: true, stdout: ANC_CHECK_OK, stderr: '' };
  }
  // install command — default success
  return { success: true, stdout: '', stderr: '' };
}

const CARGO_SPEC: InstallSpec = { pm: 'cargo-binstall', package: 'ripgrep', binary: 'rg' };

// ---------------------------------------------------------------------------
// (a) Static outboundHandlers map presence
// ---------------------------------------------------------------------------

describe('Sandbox.outboundHandlers — static map presence (test scenario a)', () => {
  test('declares both allowedInstall and noHttp BEFORE any setOutboundHandler call', () => {
    const map = Sandbox.outboundHandlers;
    expect(map).toBeDefined();
    expect(typeof map?.allowedInstall).toBe('function');
    expect(typeof map?.noHttp).toBe('function');
  });

  test('handler keys match the names sandbox-exec.ts references at runtime', () => {
    // Defends against the silent-degrade class: if someone renames a
    // handler in do.ts without updating sandbox-exec.ts (or vice versa),
    // setOutboundHandler('name') resolves to undefined and the SDK
    // falls back to default egress.
    const expected = ['allowedInstall', 'noHttp'];
    const actual = Object.keys(Sandbox.outboundHandlers ?? {}).sort();
    expect(actual).toEqual(expected.sort());
  });
});

// ---------------------------------------------------------------------------
// (b) Two-phase egress ordering — setOutbound BEFORE exec
// ---------------------------------------------------------------------------

describe('sandbox-exec.score() — two-phase egress ordering (test scenario b)', () => {
  test("setOutboundHandler('allowedInstall') fires BEFORE exec(installCmd)", async () => {
    const { stub, calls } = makeStub();
    await score(stub, CARGO_SPEC);
    const phase1 = calls.findIndex((c) => c.kind === 'setOutboundHandler' && c.name === 'allowedInstall');
    const installExec = calls.findIndex((c) => c.kind === 'exec' && c.command.startsWith('cargo-binstall '));
    expect(phase1).toBeGreaterThanOrEqual(0);
    expect(installExec).toBeGreaterThan(phase1);
  });

  test("setOutboundHandler('noHttp') fires BEFORE exec('anc check ...')", async () => {
    const { stub, calls } = makeStub();
    await score(stub, CARGO_SPEC);
    const phase2 = calls.findIndex((c) => c.kind === 'setOutboundHandler' && c.name === 'noHttp');
    const ancCheckExec = calls.findIndex((c) => c.kind === 'exec' && c.command.startsWith('anc check '));
    expect(phase2).toBeGreaterThanOrEqual(0);
    expect(ancCheckExec).toBeGreaterThan(phase2);
  });

  test('Phase 1 setOutboundHandler carries the install host allowlist via params', async () => {
    const { stub, calls } = makeStub();
    await score(stub, CARGO_SPEC);
    const phase1 = calls.find((c) => c.kind === 'setOutboundHandler' && c.name === 'allowedInstall');
    expect(phase1).toBeDefined();
    const params = (phase1 as Extract<Call, { kind: 'setOutboundHandler' }>).params as { allowedHostnames: string[] };
    expect(params.allowedHostnames).toContain('crates.io');
    expect(params.allowedHostnames).toContain('static.crates.io');
  });

  test('noHttp call has no params (catch-all 403)', async () => {
    const { stub, calls } = makeStub();
    await score(stub, CARGO_SPEC);
    const phase2 = calls.find((c) => c.kind === 'setOutboundHandler' && c.name === 'noHttp');
    expect(phase2).toBeDefined();
    expect((phase2 as Extract<Call, { kind: 'setOutboundHandler' }>).params).toBeUndefined();
  });

  test('every Phase 2 exec runs AFTER the noHttp swap (no install command between)', async () => {
    const { stub, calls } = makeStub();
    await score(stub, CARGO_SPEC);
    const phase2Idx = calls.findIndex((c) => c.kind === 'setOutboundHandler' && c.name === 'noHttp');
    // After noHttp swap, the only execs should be `anc --version` and `anc check ...`
    const afterPhase2 = calls.slice(phase2Idx + 1).filter((c) => c.kind === 'exec') as Array<
      Extract<Call, { kind: 'exec' }>
    >;
    for (const exec of afterPhase2) {
      expect(
        exec.command === 'anc --version' || exec.command.startsWith('anc check '),
        `unexpected exec under noHttp egress: ${exec.command}`,
      ).toBe(true);
    }
  });
});

describe('allowedInstall handler — wildcard hostname matcher', () => {
  // GitHub moved release assets from objects.githubusercontent.com to
  // release-assets.githubusercontent.com mid-2024; may shift again.
  // Allowlist entries supporting `*.githubusercontent.com` cover the
  // moving target without per-CDN-host churn. Defends the matcher
  // semantics so the wildcard never accidentally widens (a regex bug
  // that matched `evil.example.com.attacker.tld` as `*.com` would be
  // catastrophic).
  test('exact hostname match still works', async () => {
    const captured: string[] = [];
    const orig = console.log;
    console.log = (m: string) => captured.push(m);
    try {
      const resp = await handlers.allowedInstall(new Request('https://crates.io/api/v1/crates/ripgrep'), {} as never, {
        containerId: 'x',
        className: 'Sandbox',
        params: { allowedHostnames: ['crates.io'] },
      });
      expect(resp.status).not.toBe(403); // would 403 only if blocked
    } finally {
      console.log = orig;
    }
    expect(JSON.parse(captured[0]).allowed).toBe(true);
  });

  test('*.githubusercontent.com matches release-assets, objects, raw, codeload subdomains', async () => {
    const captured: string[] = [];
    const orig = console.log;
    console.log = (m: string) => captured.push(m);
    const allowlist = ['*.githubusercontent.com'];
    const subs = [
      'objects.githubusercontent.com',
      'release-assets.githubusercontent.com',
      'raw.githubusercontent.com',
      'codeload.githubusercontent.com',
    ];
    try {
      for (const sub of subs) {
        await handlers.allowedInstall(new Request(`https://${sub}/foo`), {} as never, {
          containerId: 'x',
          className: 'Sandbox',
          params: { allowedHostnames: allowlist },
        });
      }
    } finally {
      console.log = orig;
    }
    expect(captured.length).toBe(subs.length);
    for (const line of captured) {
      expect(JSON.parse(line).allowed).toBe(true);
    }
  });

  test('*.githubusercontent.com rejects evil.com.githubusercontent.com.attacker.tld (no suffix-extension attack)', async () => {
    const captured: string[] = [];
    const orig = console.log;
    console.log = (m: string) => captured.push(m);
    try {
      const resp = await handlers.allowedInstall(
        new Request('https://githubusercontent.com.attacker.tld/payload'),
        {} as never,
        { containerId: 'x', className: 'Sandbox', params: { allowedHostnames: ['*.githubusercontent.com'] } },
      );
      expect(resp.status).toBe(403);
    } finally {
      console.log = orig;
    }
    expect(JSON.parse(captured[0]).allowed).toBe(false);
  });

  test('*.githubusercontent.com does NOT match bare githubusercontent.com (apex must be explicit)', async () => {
    // Defensive: the wildcard is for SUBdomains only. Bare apex hits
    // would surprise an operator who allowlisted the wildcard expecting
    // CDN coverage. If apex coverage is needed, add it explicitly.
    const captured: string[] = [];
    const orig = console.log;
    console.log = (m: string) => captured.push(m);
    try {
      const resp = await handlers.allowedInstall(new Request('https://githubusercontent.com/foo'), {} as never, {
        containerId: 'x',
        className: 'Sandbox',
        params: { allowedHostnames: ['*.githubusercontent.com'] },
      });
      expect(resp.status).toBe(403);
    } finally {
      console.log = orig;
    }
    expect(JSON.parse(captured[0]).allowed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (c) Per-request handler log shape
// ---------------------------------------------------------------------------

describe('Outbound handlers — per-request log shape (test scenario c)', () => {
  const originalLog = console.log;
  let captured: string[] = [];

  beforeEach(() => {
    captured = [];
    console.log = (...args: unknown[]) => {
      captured.push(args.map((a) => String(a)).join(' '));
    };
  });
  afterEach(() => {
    console.log = originalLog;
  });

  test('allowedInstall logs {phase: "install", host, allowed: true} for an allowed host', async () => {
    const req = new Request('https://crates.io/api/v1/crates/ripgrep');
    // The actual handler calls real fetch() for allowed hosts; stub it so
    // the test doesn't egress.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('ok', { status: 200 })) as unknown as typeof fetch;
    try {
      await handlers.allowedInstall(req, {} as never, {
        containerId: 'test',
        className: 'Sandbox',
        params: { allowedHostnames: ['crates.io'] },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(captured).toHaveLength(1);
    const log = JSON.parse(captured[0]);
    expect(log).toEqual({ phase: 'install', host: 'crates.io', allowed: true });
  });

  test('allowedInstall logs allowed:false and returns 403 for a non-allowed host', async () => {
    const req = new Request('https://evil.example.com/payload');
    const resp = await handlers.allowedInstall(req, {} as never, {
      containerId: 'test',
      className: 'Sandbox',
      params: { allowedHostnames: ['crates.io'] },
    });
    expect(resp.status).toBe(403);
    expect(captured).toHaveLength(1);
    const log = JSON.parse(captured[0]);
    expect(log).toEqual({ phase: 'install', host: 'evil.example.com', allowed: false });
  });

  test('noHttp logs {phase: "noHttp", host, blocked: true} and returns 403 unconditionally', async () => {
    const req = new Request('https://crates.io/api/v1/crates/ripgrep');
    const resp = await handlers.noHttp(req, {} as never, { containerId: 'test', className: 'Sandbox' });
    expect(resp.status).toBe(403);
    expect(captured).toHaveLength(1);
    const log = JSON.parse(captured[0]);
    expect(log).toEqual({ phase: 'noHttp', host: 'crates.io', blocked: true });
  });
});

// ---------------------------------------------------------------------------
// Happy path + install-table coverage
// ---------------------------------------------------------------------------

describe('sandbox-exec.score() — happy path', () => {
  test('cargo-binstall ripgrep → returns scorecard + anc_version', async () => {
    const { stub } = makeStub();
    const result = await score(stub, CARGO_SPEC);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.anc_version).toBe('0.3.1');
    expect(result.value.scorecard).toMatchObject({ tool: { name: 'ripgrep' } });
  });

  test('audit_profile from registry passes through as --audit-profile flag', async () => {
    const { stub, calls } = makeStub();
    await score(stub, { ...CARGO_SPEC, audit_profile: 'cli-tool' } as InstallSpec & { audit_profile: string });
    const ancCheck = calls.find((c) => c.kind === 'exec' && c.command.startsWith('anc check '));
    expect(ancCheck).toBeDefined();
    expect((ancCheck as Extract<Call, { kind: 'exec' }>).command).toContain("--audit-profile 'cli-tool'");
  });

  test('no audit_profile → anc check invoked WITHOUT --audit-profile flag', async () => {
    const { stub, calls } = makeStub();
    await score(stub, CARGO_SPEC);
    const ancCheck = calls.find((c) => c.kind === 'exec' && c.command.startsWith('anc check '));
    expect(ancCheck).toBeDefined();
    expect((ancCheck as Extract<Call, { kind: 'exec' }>).command).not.toContain('--audit-profile');
  });
});

describe('sandbox-exec.score() — install table per PM', () => {
  // Each case pins the EXACT command string the orchestration emits.
  // First-token alignment with an actual binary in the sandbox image is
  // the load-bearing invariant: `cargo-binstall` (one word, hyphenated)
  // matches the Dockerfile's standalone binary, NOT `cargo binstall`
  // (which assumes a rust toolchain we don't ship). Bug A surfaced when
  // these tests pinned the wrong form; do not relax to a startsWith
  // match — exact equality keeps the binary-name regression alarm loud.
  const cases: Array<{ spec: InstallSpec; expected: string }> = [
    {
      spec: { pm: 'cargo-binstall', package: 'ripgrep', binary: 'rg' },
      // --install-path /usr/local/bin forces binary onto PATH (Bug L).
      expected: "cargo-binstall --no-confirm --no-symlinks --install-path /usr/local/bin 'ripgrep'",
    },
    {
      spec: { pm: 'pip', package: 'black', binary: 'black' },
      // PIP_NO_COLOR=1: ANSI suppression in pip output (Bug D).
      // --break-system-packages: overrides Debian PEP 668 refusal (no-op
      // on the python:3.12-slim-trixie base, retained for safety).
      // --no-binary=pyperclip,pycparser: selective sdist allowlist for
      // known sdist-only transitive deps in the agent-tool ecosystem.
      // pyperclip (Aider #4105) and pycparser (cffi dep, pyperclip #288)
      // are both pure-Python with mature upstreams. The list lives in
      // src/worker/score/sdist-allowlist.ts; if entries change, this
      // expectation must move with it.
      // PIP_UPLOADED_PRIOR_TO=$(date -u -d '7 days ago' ...): supply-chain
      // release-delay gate. Date computed at exec time so image age
      // doesn't widen the gate. pip v26.0+ honors the env var; older
      // pip ignores it harmlessly.
      expected:
        "PIP_UPLOADED_PRIOR_TO=$(date -u -d '7 days ago' +%Y-%m-%dT%H:%M:%SZ) " +
        'PIP_NO_COLOR=1 pip install --only-binary=:all: --no-binary=pyperclip,pycparser --no-cache-dir ' +
        "--break-system-packages 'black'",
    },
    {
      spec: { pm: 'uv', package: 'black', binary: 'black' },
      // Native uv path (split from pm=pip). uv's resolver sidesteps
      // pip 24+'s PEP 658 metadata fast-path (Bug M).
      expected: "uv tool install 'black'",
    },
    {
      spec: { pm: 'bun', package: 'prettier', binary: 'prettier' },
      // Native bun runtime (post-rework). --ignore-scripts matches the
      // npm path's lifecycle-script suppression.
      expected: "bun add -g --ignore-scripts 'prettier'",
    },
    {
      spec: { pm: 'npm', package: 'typescript', binary: 'tsc' },
      expected: "npm install -g --ignore-scripts 'typescript'",
    },
    {
      spec: { pm: 'direct', url: 'https://example.com/foo.tar.gz', binary: 'foo' },
      // direct install: extract to tmp, find binary by name, install
      // to /usr/local/bin. Handles flat AND nested archive layouts
      // (csvlens-style `<tool-arch>/csvlens` nesting).
      expected:
        `( set -e; tmp=$(mktemp -d); mkdir "$tmp/x"; ` +
        `curl -fsSL 'https://example.com/foo.tar.gz' -o "$tmp/a"; ` +
        `tar xzf "$tmp/a" -C "$tmp/x"; ` +
        `found=$(find "$tmp/x" -type f -name 'foo' -perm /111 -print -quit); ` +
        `test -n "$found"; install -m 0755 "$found" /usr/local/bin/'foo'; rm -rf "$tmp" )`,
    },
    {
      spec: { pm: 'direct', url: 'https://example.com/foo.tgz', binary: 'foo' },
      expected:
        `( set -e; tmp=$(mktemp -d); mkdir "$tmp/x"; ` +
        `curl -fsSL 'https://example.com/foo.tgz' -o "$tmp/a"; ` +
        `tar xzf "$tmp/a" -C "$tmp/x"; ` +
        `found=$(find "$tmp/x" -type f -name 'foo' -perm /111 -print -quit); ` +
        `test -n "$found"; install -m 0755 "$found" /usr/local/bin/'foo'; rm -rf "$tmp" )`,
    },
    {
      // Bug N: many newer Rust tools (csvlens) ship .tar.xz only,
      // often with the binary nested in a `<tool>-<arch>/` directory.
      spec: { pm: 'direct', url: 'https://example.com/foo.tar.xz', binary: 'foo' },
      expected:
        `( set -e; tmp=$(mktemp -d); mkdir "$tmp/x"; ` +
        `curl -fsSL 'https://example.com/foo.tar.xz' -o "$tmp/a"; ` +
        `tar xJf "$tmp/a" -C "$tmp/x"; ` +
        `found=$(find "$tmp/x" -type f -name 'foo' -perm /111 -print -quit); ` +
        `test -n "$found"; install -m 0755 "$found" /usr/local/bin/'foo'; rm -rf "$tmp" )`,
    },
    {
      spec: { pm: 'direct', url: 'https://example.com/foo.tar.bz2', binary: 'foo' },
      expected:
        `( set -e; tmp=$(mktemp -d); mkdir "$tmp/x"; ` +
        `curl -fsSL 'https://example.com/foo.tar.bz2' -o "$tmp/a"; ` +
        `tar xjf "$tmp/a" -C "$tmp/x"; ` +
        `found=$(find "$tmp/x" -type f -name 'foo' -perm /111 -print -quit); ` +
        `test -n "$found"; install -m 0755 "$found" /usr/local/bin/'foo'; rm -rf "$tmp" )`,
    },
  ];

  for (const { spec, expected } of cases) {
    test(`pm=${spec.pm} → '${expected}'`, async () => {
      const { stub, calls } = makeStub();
      await score(stub, spec);
      const installCmds = calls.filter(
        (c) =>
          c.kind === 'exec' &&
          !c.command.startsWith('which ') &&
          c.command !== 'anc --version' &&
          !c.command.startsWith('anc check '),
      ) as Array<Extract<Call, { kind: 'exec' }>>;
      expect(installCmds).toHaveLength(1);
      expect(installCmds[0].command).toBe(expected);
    });
  }

  test('install table first binaries match binaries present in the sandbox Dockerfile', async () => {
    // Systemic catch: every install command in the table MUST invoke a
    // binary name that actually exists on the sandbox container PATH.
    // The set below mirrors docker/sandbox/Dockerfile's apt install line
    // + the standalone tarballs. Keep in sync with the Dockerfile.
    //
    // Tokens that look like `NAME=value` are env-var prefixes (e.g.
    // `PIP_NO_COLOR=1`, `PIP_UPLOADED_PRIOR_TO=$(date ...)` — the latter
    // spans multiple whitespace tokens because of the $(...) command
    // substitution). The matcher skips env-var prefixes (and the inner
    // tokens of any command substitution they contain) until it finds
    // the actual binary name.
    const knownBinaries = new Set([
      'cargo-binstall', // tarball at /usr/local/bin/
      'pip', // provided by the python:3.12-slim-trixie base
      'uv', // tarball at /usr/local/bin/
      'npm', // npm apt
      'bun', // tarball at /usr/local/bin/
      'curl', // curl apt
      '(', // direct install wraps the pipeline in a `( set -e; … )` subshell
    ]);

    // Find the first token that is NOT an env-var assignment (NAME=...)
    // AND is not inside a $(...) command substitution. Handles
    // multi-word `$(...)` interiors by skipping until the closing `)`.
    function firstBinary(cmd: string): string {
      const tokens = cmd.split(/\s+/);
      let inCommandSub = false;
      for (const t of tokens) {
        if (inCommandSub) {
          if (t.includes(')')) inCommandSub = false;
          continue;
        }
        if (t.includes('$(') && !t.includes(')')) {
          inCommandSub = true;
          continue;
        }
        if (/^[A-Z_][A-Z0-9_]*=/.test(t)) continue; // env-var prefix
        return t;
      }
      return tokens[0];
    }

    for (const { spec, expected } of cases) {
      const binary = firstBinary(expected);
      expect(
        knownBinaries.has(binary),
        `pm=${spec.pm} install command first binary "${binary}" not in known binaries; ` +
          `update docker/sandbox/Dockerfile or sandbox-exec.ts install table`,
      ).toBe(true);
    }
  });
});

describe('sandbox-exec.score() — bounce classes', () => {
  test('brew passed to score() bounces install_unsupported (resolveSpec should translate first)', async () => {
    // Direct invocation of score() with pm=brew is a contract violation
    // — resolveSpec in do.ts is supposed to run the discovery-fallback
    // before this layer is reached. Keeping the bounce guards against a
    // future caller that skips resolveSpec.
    const { stub } = makeStub();
    const result = await score(stub, { pm: 'brew', package: 'bat', binary: 'bat' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('install_unsupported');
    expect(result.details).toContain('brew');
  });

  test('go passed to score() bounces install_unsupported (resolveSpec should translate first)', async () => {
    // Parallel to the brew bounce: `go install` would compile from
    // source, violating U2's binary-only premise. resolveSpec's
    // resolveGoFallback in do.ts redirects github.com/<owner>/<repo>
    // module paths through the discovery chain so a GitHub release
    // binary substitutes for the compile. Direct invocation of
    // score() with pm=go is a contract violation and bounces.
    const { stub } = makeStub();
    const result = await score(stub, { pm: 'go', package: 'github.com/charmbracelet/glow', binary: 'glow' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('install_unsupported');
    expect(result.details).toContain('go');
  });

  test('install command non-zero → chain_resolved_install_failed', async () => {
    const responder: ExecResponder = (cmd) => {
      if (cmd.startsWith('cargo-binstall ')) {
        return { success: false, stdout: '', stderr: 'no binary asset for x86_64-musl', exitCode: 1 };
      }
      return defaultResponder(cmd);
    };
    const { stub } = makeStub(responder);
    const result = await score(stub, CARGO_SPEC);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('chain_resolved_install_failed');
    expect(result.details).toContain('no binary asset');
  });

  test('install stderr with ANSI color codes → details field strips them (Bug D)', async () => {
    // pip emits CSI escape sequences in progress output. The truncate()
    // helper strips them before returning so the user-facing details
    // field is plain text — no `\x1b[31m` artifacts visible in the API
    // response or downstream CLI / browser renderings.
    const responder: ExecResponder = (cmd) => {
      if (cmd.includes('pip install ')) {
        return {
          success: false,
          stdout: '',
          stderr: '\x1b[31mERROR\x1b[0m: Could not find a version that satisfies the requirement nonexistent',
          exitCode: 1,
        };
      }
      return defaultResponder(cmd);
    };
    const { stub } = makeStub(responder);
    const result = await score(stub, { pm: 'pip', package: 'nonexistent', binary: 'nonexistent' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('chain_resolved_install_failed');
    expect(result.details).toBe('ERROR: Could not find a version that satisfies the requirement nonexistent');
    expect(result.details).not.toContain('\x1b');
  });

  test('which check misses → chain_resolved_no_binary_produced (pallets/click case)', async () => {
    const responder: ExecResponder = (cmd) => {
      if (cmd.startsWith('which ')) {
        return { success: false, stdout: '', stderr: '', exitCode: 1 };
      }
      return defaultResponder(cmd);
    };
    const { stub } = makeStub(responder);
    const result = await score(stub, { pm: 'pip', package: 'click', binary: 'click' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('chain_resolved_no_binary_produced');
    expect(result.details).toBe('binary=click');
  });

  test('anc --version returns non-zero → anc_version_unreadable', async () => {
    const responder: ExecResponder = (cmd) => {
      if (cmd === 'anc --version') {
        return { success: false, stdout: '', stderr: 'segfault', exitCode: 139 };
      }
      return defaultResponder(cmd);
    };
    const { stub } = makeStub(responder);
    const result = await score(stub, CARGO_SPEC);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('anc_version_unreadable');
  });

  test('anc --version stdout unparseable → anc_version_unreadable with details', async () => {
    const responder: ExecResponder = (cmd) => {
      if (cmd === 'anc --version') return { success: true, stdout: 'garbage', stderr: '' };
      return defaultResponder(cmd);
    };
    const { stub } = makeStub(responder);
    const result = await score(stub, CARGO_SPEC);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('anc_version_unreadable');
    expect(result.details).toBe('garbage');
  });

  test('anc check returns non-JSON → anc_check_failed', async () => {
    const responder: ExecResponder = (cmd) => {
      if (cmd.startsWith('anc check ')) {
        return { success: true, stdout: 'definitely not json', stderr: '' };
      }
      return defaultResponder(cmd);
    };
    const { stub } = makeStub(responder);
    const result = await score(stub, CARGO_SPEC);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('anc_check_failed');
  });

  test('anc check non-zero but valid JSON envelope → still returns scorecard', async () => {
    // anc emits structured envelopes on stderr-exit when checks produce
    // findings; the orchestration treats a parseable envelope as the
    // authoritative response regardless of exit code.
    const responder: ExecResponder = (cmd) => {
      if (cmd.startsWith('anc check ')) {
        return { success: false, stdout: ANC_CHECK_OK, stderr: '', exitCode: 1 };
      }
      return defaultResponder(cmd);
    };
    const { stub } = makeStub(responder);
    const result = await score(stub, CARGO_SPEC);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.scorecard).toMatchObject({ tool: { name: 'ripgrep' } });
  });
});

describe('sandbox-exec.score() — shell injection safety', () => {
  test('single-quote in package name is shell-escaped', async () => {
    const { stub, calls } = makeStub();
    await score(stub, { pm: 'npm', package: "foo'; rm -rf /;'", binary: 'foo' });
    const installCmd = calls.find((c) => c.kind === 'exec' && c.command.startsWith('npm install ')) as
      | Extract<Call, { kind: 'exec' }>
      | undefined;
    expect(installCmd).toBeDefined();
    // POSIX escape: foo'\''; rm -rf /;'\''   wrapped in '...'
    expect(installCmd?.command).toContain("'foo'\\''; rm -rf /;'\\'''");
  });
});

describe('sandbox-exec.score() — supply-chain release-delay gate (pip exec-time)', () => {
  // The pip install command must carry a PIP_UPLOADED_PRIOR_TO env-var
  // prefix that refuses to install packages published less than 7 days
  // ago. Date computed at exec time via shell substitution so a long-
  // running image doesn't widen the gate. pip v26.0+ honors the env
  // var; older pip versions ignore it (no-op). The companion uv gate
  // (UV_EXCLUDE_NEWER) is asserted at the image layer in
  // tests/dockerfile-sandbox.test.ts.

  test('pip install command prepends PIP_UPLOADED_PRIOR_TO with a 7-day shell-computed date', async () => {
    const { stub, calls } = makeStub();
    await score(stub, { pm: 'pip', package: 'black', binary: 'black' });
    const installCmd = calls.find((c) => c.kind === 'exec' && c.command.includes(' pip install ')) as
      | Extract<Call, { kind: 'exec' }>
      | undefined;
    expect(installCmd).toBeDefined();
    // The env-var prefix MUST be present and MUST use shell command
    // substitution so the date refreshes on every exec rather than
    // being frozen at image-build time.
    expect(installCmd?.command).toMatch(/^PIP_UPLOADED_PRIOR_TO=\$\(date -u -d '7 days ago' \+%Y-%m-%dT%H:%M:%SZ\) /);
  });

  test('PIP_UPLOADED_PRIOR_TO precedes PIP_NO_COLOR and the pip binary in the command string', async () => {
    // Token order matters because env-var prefixes only apply to the
    // command they precede. Putting the date AFTER `pip` would invoke
    // pip without the gate and then set an unused shell variable.
    const { stub, calls } = makeStub();
    await score(stub, { pm: 'pip', package: 'httpie', binary: 'http' });
    const installCmd = calls.find((c) => c.kind === 'exec' && c.command.includes(' pip install ')) as
      | Extract<Call, { kind: 'exec' }>
      | undefined;
    expect(installCmd).toBeDefined();
    const cmd = installCmd?.command ?? '';
    const priorIdx = cmd.indexOf('PIP_UPLOADED_PRIOR_TO=');
    const colorIdx = cmd.indexOf('PIP_NO_COLOR=');
    const pipIdx = cmd.indexOf(' pip install ');
    expect(priorIdx).toBe(0);
    expect(colorIdx).toBeGreaterThan(priorIdx);
    expect(pipIdx).toBeGreaterThan(colorIdx);
  });

  test('shell substitution uses GNU date syntax compatible with the debian-trixie base', async () => {
    // `date -u -d '<relative>' +<format>` is GNU-date syntax; BSD date
    // would need `-v-7d`. The python:3.12-slim-trixie base ships GNU
    // coreutils, so the -d form is correct. Pin the syntax so a future
    // base swap to a non-GNU coreutils image surfaces here.
    const { stub, calls } = makeStub();
    await score(stub, { pm: 'pip', package: 'pylint', binary: 'pylint' });
    const installCmd = calls.find((c) => c.kind === 'exec' && c.command.includes(' pip install ')) as
      | Extract<Call, { kind: 'exec' }>
      | undefined;
    expect(installCmd).toBeDefined();
    // GNU form: -d '<relative>'.  BSD form (rejected): -v-7d.
    expect(installCmd?.command).toContain("date -u -d '7 days ago'");
    expect(installCmd?.command).not.toContain('date -u -v-7d');
  });

  test('non-pip install paths do NOT carry PIP_UPLOADED_PRIOR_TO (env-var is pip-scoped only)', async () => {
    // Leaking the pip env-var into npm/bun/cargo/uv installs would be
    // dead weight at best and could mask a missing real implementation
    // for those PMs. uv's gate is set via image ENV (UV_EXCLUDE_NEWER),
    // not via this prefix.
    const npmStub = makeStub();
    await score(npmStub.stub, { pm: 'npm', package: 'cowsay', binary: 'cowsay' });
    const npmCmd = npmStub.calls.find((c) => c.kind === 'exec' && c.command.includes('npm install')) as
      | Extract<Call, { kind: 'exec' }>
      | undefined;
    expect(npmCmd?.command).not.toContain('PIP_UPLOADED_PRIOR_TO');

    const uvStub = makeStub();
    await score(uvStub.stub, { pm: 'uv', package: 'black', binary: 'black' });
    const uvCmd = uvStub.calls.find((c) => c.kind === 'exec' && c.command.includes('uv tool install')) as
      | Extract<Call, { kind: 'exec' }>
      | undefined;
    expect(uvCmd?.command).not.toContain('PIP_UPLOADED_PRIOR_TO');
  });
});
