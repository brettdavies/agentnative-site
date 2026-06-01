// Sandbox DO + two-phase egress orchestration tests.
//
// Covers three MUST-hold scenarios for the egress-handler contract:
//
//   (a) Sandbox.outboundHandlers static map has both `allowedInstall`
//       and `noHttp` keys BEFORE any setOutboundHandler call runs.
//       Catches misnamed-key regressions that would silently degrade
//       egress policy.
//
//   (b) Two-phase egress order: setOutboundHandler('allowedInstall', ...)
//       fires BEFORE exec(installCmd), AND setOutboundHandler('noHttp')
//       fires BEFORE exec('anc audit ...'). Asserted via a call log on a
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
import { SPEC_VERSION } from '../src/worker/spec-version.gen';

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
  spec_version: SPEC_VERSION,
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
  if (command.startsWith('anc audit ')) {
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

  test("setOutboundHandler('noHttp') fires BEFORE exec('anc audit ...')", async () => {
    const { stub, calls } = makeStub();
    await score(stub, CARGO_SPEC);
    const phase2 = calls.findIndex((c) => c.kind === 'setOutboundHandler' && c.name === 'noHttp');
    const ancAuditExec = calls.findIndex((c) => c.kind === 'exec' && c.command.startsWith('anc audit '));
    expect(phase2).toBeGreaterThanOrEqual(0);
    expect(ancAuditExec).toBeGreaterThan(phase2);
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
    // After noHttp swap, the only execs should be `anc --version` and `anc audit ...`
    const afterPhase2 = calls.slice(phase2Idx + 1).filter((c) => c.kind === 'exec') as Array<
      Extract<Call, { kind: 'exec' }>
    >;
    for (const exec of afterPhase2) {
      expect(
        exec.command === 'anc --version' || exec.command.startsWith('anc audit '),
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
    const ancAudit = calls.find((c) => c.kind === 'exec' && c.command.startsWith('anc audit '));
    expect(ancAudit).toBeDefined();
    expect((ancAudit as Extract<Call, { kind: 'exec' }>).command).toContain("--audit-profile 'cli-tool'");
  });

  test('no audit_profile → anc audit invoked WITHOUT --audit-profile flag', async () => {
    const { stub, calls } = makeStub();
    await score(stub, CARGO_SPEC);
    const ancAudit = calls.find((c) => c.kind === 'exec' && c.command.startsWith('anc audit '));
    expect(ancAudit).toBeDefined();
    expect((ancAudit as Extract<Call, { kind: 'exec' }>).command).not.toContain('--audit-profile');
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

  // Direct-install command shape (auto-detect + gate-markers — Fix 1/3):
  // build the expected string from URL + extract verb + preferred binary
  // so each tested archive extension stays a one-line spec while the
  // (long) shell pipeline lives in one place.
  function directExpected(url: string, extract: string, preferred: string): string {
    const qUrl = `'${url}'`;
    const qPref = `'${preferred}'`;
    return (
      `( set -e; tmp=$(mktemp -d); mkdir "$tmp/x"; ` +
      `echo 'GATE:download' >&2; ` +
      `curl -fsSL ${qUrl} -o "$tmp/a" 2>"$tmp/curl_err" || ` +
      `{ echo "DETAILS:Download failed: $(cat "$tmp/curl_err" | head -c 200)" >&2; exit 10; }; ` +
      `echo 'GATE:extract' >&2; ` +
      `${extract} 2>"$tmp/ext_err" || ` +
      `{ echo "DETAILS:Extract failed: $(cat "$tmp/ext_err" | head -c 200)" >&2; exit 12; }; ` +
      `echo 'GATE:find_binary' >&2; ` +
      `candidates=$(find "$tmp/x" -type f -perm /111 -printf '%P\\n' 2>/dev/null | ` +
      `grep -viE '(^|/)(LICEN[CS]E|README|CHANGELOG|NOTICE|AUTHORS|COPYING|MANIFEST|Makefile|\\.gitignore)([._-].*)?$' | ` +
      `grep -viE '\\.(md|markdown|txt|html|htm|json|yml|yaml|toml|xml|cfg|ini|sh|bat|cmd|py|rb|pl)$' | ` +
      `grep -vE '(^|/)\\.\\.(/|$)' | ` +
      `grep -vE '^/' || true); ` +
      `if [ -z "$candidates" ]; then ` +
      `all=$(find "$tmp/x" -type f -printf '%P\\n' 2>/dev/null | head -10 | tr '\\n' ' '); ` +
      `echo "DETAILS:Archive contains no binary named ${preferred}. Files seen: $all" >&2; ` +
      `exit 11; ` +
      `fi; ` +
      `best=$(printf '%s\\n' "$candidates" | awk -v pref=${qPref} '` +
      `{ ` +
      `n=split($0, parts, "/"); name=parts[n]; ` +
      `score=0; ` +
      `if (name == pref) score=1000; ` +
      `else if (index(name, pref) > 0) score=500; ` +
      `if (name !~ /\\./) score+=10; ` +
      `score -= length(name); ` +
      `if (score > best_score || best == "") { best_score=score; best=$0 } ` +
      `} END { print best }'); ` +
      `detected=$(basename "$best"); ` +
      `echo 'GATE:install_binary' >&2; ` +
      `install -m 0755 "$tmp/x/$best" "/usr/local/bin/$detected" 2>"$tmp/inst_err" || ` +
      `{ echo "DETAILS:Install staging failed: $(cat "$tmp/inst_err" | head -c 200)" >&2; exit 13; }; ` +
      `rm -rf "$tmp"; ` +
      `echo "DETECTED_BINARY=$detected" )`
    );
  }

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
      // PIP_DISABLE_PIP_VERSION_CHECK=1: suppresses pip's "A new release
      // of pip is available" stderr notice so the scorecard evidence +
      // bounce-panel details stay clean. Also baked as image ENV in
      // docker/sandbox/Dockerfile; the inline pass keeps the
      // currently-deployed image quiet until the next rebuild lands.
      expected:
        "PIP_UPLOADED_PRIOR_TO=$(date -u -d '7 days ago' +%Y-%m-%dT%H:%M:%SZ) " +
        'PIP_DISABLE_PIP_VERSION_CHECK=1 ' +
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
      // direct install: extract to tmp, auto-detect binary (Fix 1) by
      // listing executables + filtering docs + scoring against the
      // preferred name. Installs the chosen file under its OWN basename
      // and echoes DETECTED_BINARY=<name> so runScore overrides
      // spec.binary before the `which` gate runs. Each pipeline step
      // emits a GATE:<name> marker (Fix 3) for failure classification.
      expected: directExpected('https://example.com/foo.tar.gz', `tar xzf "$tmp/a" -C "$tmp/x"`, 'foo'),
    },
    {
      spec: { pm: 'direct', url: 'https://example.com/foo.tgz', binary: 'foo' },
      expected: directExpected('https://example.com/foo.tgz', `tar xzf "$tmp/a" -C "$tmp/x"`, 'foo'),
    },
    {
      // Bug N: many newer Rust tools (csvlens) ship .tar.xz only,
      // often with the binary nested in a `<tool>-<arch>/` directory.
      spec: { pm: 'direct', url: 'https://example.com/foo.tar.xz', binary: 'foo' },
      expected: directExpected('https://example.com/foo.tar.xz', `tar xJf "$tmp/a" -C "$tmp/x"`, 'foo'),
    },
    {
      spec: { pm: 'direct', url: 'https://example.com/foo.tar.bz2', binary: 'foo' },
      expected: directExpected('https://example.com/foo.tar.bz2', `tar xjf "$tmp/a" -C "$tmp/x"`, 'foo'),
    },
    {
      // .txz alias for .tar.xz — same xJ flag.
      spec: { pm: 'direct', url: 'https://example.com/foo.txz', binary: 'foo' },
      expected: directExpected('https://example.com/foo.txz', `tar xJf "$tmp/a" -C "$tmp/x"`, 'foo'),
    },
    {
      // .tbz2 alias for .tar.bz2 — same xj flag.
      spec: { pm: 'direct', url: 'https://example.com/foo.tbz2', binary: 'foo' },
      expected: directExpected('https://example.com/foo.tbz2', `tar xjf "$tmp/a" -C "$tmp/x"`, 'foo'),
    },
    {
      // .zip — unzip into the tmp dir, then auto-detect + install.
      // Mirrors how GitHub Windows-style release artifacts (and the
      // occasional Linux tool, e.g. bun) get extracted. The post-extract
      // find walk is recursive, so an archive that expands to
      // `extracted-dir/bin/<tool>` resolves identically to a flat archive.
      spec: { pm: 'direct', url: 'https://example.com/foo.zip', binary: 'foo' },
      expected: directExpected('https://example.com/foo.zip', `unzip -q "$tmp/a" -d "$tmp/x"`, 'foo'),
    },
    {
      // Unknown / no recognized extension: falls back to `tar xz` so
      // legacy tar.gz-without-extension URLs keep working. Fails loud
      // if the archive isn't actually gzip-tar, which surfaces as a
      // chain_resolved_install_failed bounce with the curl/tar stderr
      // visible to the user.
      spec: { pm: 'direct', url: 'https://example.com/foo-release', binary: 'foo' },
      expected: directExpected('https://example.com/foo-release', `tar xzf "$tmp/a" -C "$tmp/x"`, 'foo'),
    },
    {
      // Binary in subfolder coverage: the find walk under "$tmp/x" has
      // no -maxdepth, so an archive whose binary lives at
      // `<arch-dir>/bin/<binary>` (or any nesting depth) resolves
      // identically. The command-shape assertion above pins the
      // recursive walk; this case pins it explicitly so a future
      // refactor that adds `-maxdepth 1` breaks here loudly. URL is a
      // .tar.gz with a binary name that implies a release-folder layout.
      spec: { pm: 'direct', url: 'https://example.com/nested-binary.tar.gz', binary: 'nested-binary' },
      expected: directExpected(
        'https://example.com/nested-binary.tar.gz',
        `tar xzf "$tmp/a" -C "$tmp/x"`,
        'nested-binary',
      ),
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
          !c.command.startsWith('anc audit '),
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
    // source, violating the binary-only premise. resolveSpec's
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

  test('anc audit returns non-JSON → anc_audit_failed', async () => {
    const responder: ExecResponder = (cmd) => {
      if (cmd.startsWith('anc audit ')) {
        return { success: true, stdout: 'definitely not json', stderr: '' };
      }
      return defaultResponder(cmd);
    };
    const { stub } = makeStub(responder);
    const result = await score(stub, CARGO_SPEC);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('anc_audit_failed');
  });

  test('anc audit non-zero but valid JSON envelope → still returns scorecard', async () => {
    // anc emits structured envelopes on stderr-exit when checks produce
    // findings; the orchestration treats a parseable envelope as the
    // authoritative response regardless of exit code.
    const responder: ExecResponder = (cmd) => {
      if (cmd.startsWith('anc audit ')) {
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
  // (UV_EXCLUDE_NEWER) lives at the image layer.

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

  test('pip install command carries PIP_DISABLE_PIP_VERSION_CHECK=1 to suppress upgrade notice', async () => {
    // The Dockerfile bakes this as an image ENV so future builds are
    // quiet at the OS level, but the currently-deployed image predates
    // that change. Prepending the env var inline at exec time gives
    // the currently-deployed sandbox the suppression immediately,
    // without a rebuild.
    const { stub, calls } = makeStub();
    await score(stub, { pm: 'pip', package: 'black', binary: 'black' });
    const installCmd = calls.find((c) => c.kind === 'exec' && c.command.includes(' pip install ')) as
      | Extract<Call, { kind: 'exec' }>
      | undefined;
    expect(installCmd).toBeDefined();
    expect(installCmd?.command).toContain('PIP_DISABLE_PIP_VERSION_CHECK=1');
    // Ordering: must precede `pip install` so it applies to the pip
    // invocation rather than being set as an unused shell variable
    // afterward.
    const cmd = installCmd?.command ?? '';
    expect(cmd.indexOf('PIP_DISABLE_PIP_VERSION_CHECK=1')).toBeLessThan(cmd.indexOf(' pip install '));
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

  // The remaining tests in this group execute the shell substitution
  // directly (via Bun.spawn) and assert the runtime output, not just
  // the literal string baked into the install command. The static
  // tests above pin "the right string is in the command"; these
  // dynamic tests pin "the string actually produces what pip wants".
  // Together they catch a future change that swaps `+%Y-%m-%dT%H:%M:%SZ`
  // for something pip 26+ wouldn't accept.

  test('shell substitution produces an ISO 8601 string pip will accept', async () => {
    // The exact shell substitution embedded in sandbox-exec.ts.
    const proc = Bun.spawn(['bash', '-c', "date -u -d '7 days ago' +%Y-%m-%dT%H:%M:%SZ"], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const out = (await new Response(proc.stdout).text()).trim();
    await proc.exited;
    // ISO 8601 with second-precision and Zulu suffix — the shape pip
    // 26+ accepts for PIP_UPLOADED_PRIOR_TO. A future change that
    // emits a different format (e.g. local timezone, fractional
    // seconds, or +HH:MM offset) will fail this match before reaching
    // the sandbox.
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  test('shell substitution computes a timestamp ~7 days in the past', async () => {
    // Sanity: the substitution must actually produce a 7-days-ago
    // timestamp, not "now" or some other arithmetic. Tolerance is
    // ±10 minutes to absorb test-runtime clock drift and DST quirks.
    const proc = Bun.spawn(['bash', '-c', "date -u -d '7 days ago' +%Y-%m-%dT%H:%M:%SZ"], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const out = (await new Response(proc.stdout).text()).trim();
    await proc.exited;
    const producedMs = Date.parse(out);
    expect(Number.isFinite(producedMs)).toBe(true);
    const expectedMs = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const driftMinutes = Math.abs(producedMs - expectedMs) / 60_000;
    expect(driftMinutes).toBeLessThan(10);
  });

  test('shell substitution is the EXACT form embedded in the install command (no drift)', async () => {
    // Defends against a partial refactor that updates the install
    // command in sandbox-exec.ts but forgets to update the shell
    // executed at runtime (or vice versa). Re-extract the substitution
    // from the live install command and run it; assert it succeeds.
    const { stub, calls } = makeStub();
    await score(stub, { pm: 'pip', package: 'mypy', binary: 'mypy' });
    const installCmd = calls.find((c) => c.kind === 'exec' && c.command.includes(' pip install ')) as
      | Extract<Call, { kind: 'exec' }>
      | undefined;
    expect(installCmd).toBeDefined();
    // Extract the `$(...)` substitution from the install command.
    const match = installCmd?.command.match(/^PIP_UPLOADED_PRIOR_TO=\$\(([^)]+)\)/);
    expect(match).not.toBeNull();
    const substitution = match?.[1];
    expect(substitution).toBeTruthy();
    if (!substitution) return;
    // Run it.
    const proc = Bun.spawn(['bash', '-c', substitution], { stdout: 'pipe', stderr: 'pipe' });
    const out = (await new Response(proc.stdout).text()).trim();
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });
});

// ---------------------------------------------------------------------------
// Fix 1 — auto-detect archive binary
// Fix 3 — gate-capture in directInstallCommand
// ---------------------------------------------------------------------------

describe('sandbox-exec.score() — direct-install auto-detect (Fix 1)', () => {
  // The install command is what the orchestration tells the container to
  // run; the container then echoes `DETECTED_BINARY=<name>` to stdout
  // and runScore() overrides spec.binary before the `which` gate. These
  // tests stub the container, return a canned auto-detect result, and
  // assert the `which` + `anc audit` calls reference the detected name.

  test('archive auto-detect picks gog when repo=gogcli (the gogcli/openclaw fix)', async () => {
    // gogcli/openclaw case: GitHub Releases ships a `gog` binary, but
    // the repo is `gogcli`. Pre-fix Step 2 hardcoded binary=ctx.repo,
    // and the post-extract `find -name gogcli` missed. Now the install
    // command does its own listing + scoring + emits the chosen name.
    const responder: ExecResponder = (cmd) => {
      if (cmd.startsWith('(') && cmd.includes('GATE:download')) {
        // Auto-detect picked `gog` from the archive.
        return { success: true, stdout: 'DETECTED_BINARY=gog\n', stderr: '' };
      }
      if (cmd.startsWith('which ')) {
        return { success: true, stdout: '/usr/local/bin/gog\n', stderr: '' };
      }
      return defaultResponder(cmd);
    };
    const { stub, calls } = makeStub(responder);
    const result = await score(stub, {
      pm: 'direct',
      url: 'https://example.com/gog-linux-amd64.tar.gz',
      binary: 'gogcli', // the repo name, NOT the actual binary
    });
    expect(result.ok).toBe(true);
    // The which gate must run against the DETECTED name, not the
    // pre-fix repo name. This is the load-bearing assertion for Fix 1.
    const whichCall = calls.find((c) => c.kind === 'exec' && c.command.startsWith('which ')) as
      | Extract<Call, { kind: 'exec' }>
      | undefined;
    expect(whichCall?.command).toBe("which 'gog'");
    const ancCall = calls.find((c) => c.kind === 'exec' && c.command.startsWith('anc audit ')) as
      | Extract<Call, { kind: 'exec' }>
      | undefined;
    expect(ancCall?.command).toContain("--command 'gog'");
  });

  test('no DETECTED_BINARY in stdout → spec.binary stays the preferred name', async () => {
    // Backward-compat: any non-direct PM install command, or a future
    // direct-install variant that doesn't emit the marker, keeps the
    // existing spec.binary value. (npm / pip / cargo-binstall already
    // print package-manager-specific noise without the marker.)
    const { stub, calls } = makeStub();
    const result = await score(stub, CARGO_SPEC);
    expect(result.ok).toBe(true);
    const whichCall = calls.find((c) => c.kind === 'exec' && c.command.startsWith('which ')) as
      | Extract<Call, { kind: 'exec' }>
      | undefined;
    expect(whichCall?.command).toBe("which 'rg'");
  });

  test('DETECTED_BINARY with shell-meta in name → rejected, spec.binary unchanged', async () => {
    // Defense in depth: the install command's own filter rejects
    // path-traversal candidates upstream. The extractDetectedBinary
    // parser whitelists [A-Za-z0-9._-] so any smuggled bytes (e.g.
    // `gog; rm -rf /`) don't reach the shell-quoted `anc audit
    // --command <binary>` slot.
    const responder: ExecResponder = (cmd) => {
      if (cmd.startsWith('(') && cmd.includes('GATE:download')) {
        return { success: true, stdout: 'DETECTED_BINARY=gog; rm -rf /\n', stderr: '' };
      }
      return defaultResponder(cmd);
    };
    const { stub, calls } = makeStub(responder);
    await score(stub, {
      pm: 'direct',
      url: 'https://example.com/x.tar.gz',
      binary: 'safe',
    });
    const whichCall = calls.find((c) => c.kind === 'exec' && c.command.startsWith('which ')) as
      | Extract<Call, { kind: 'exec' }>
      | undefined;
    // Stays 'safe' (the original spec.binary) because the malicious
    // detected name failed the [A-Za-z0-9._-] whitelist.
    expect(whichCall?.command).toBe("which 'safe'");
  });
});

describe('sandbox-exec.score() — gate-capture in install details (Fix 3)', () => {
  // Each direct-install pipeline step emits a GATE:<name> marker to
  // stderr BEFORE running, and on failure also emits a step-specific
  // DETAILS:<text> line. extractGateDetails() in sandbox-exec.ts picks
  // up the LAST GATE marker and the DETAILS line; runScore threads
  // them into the user-facing details field instead of the raw stderr.

  test('curl-fail surfaces "Download failed:" in details', async () => {
    const responder: ExecResponder = (cmd) => {
      if (cmd.startsWith('(') && cmd.includes('GATE:download')) {
        return {
          success: false,
          stdout: '',
          stderr: 'GATE:download\nDETAILS:Download failed: curl: (22) The requested URL returned error: 404\n',
          exitCode: 10,
        };
      }
      return defaultResponder(cmd);
    };
    const { stub } = makeStub(responder);
    const result = await score(stub, {
      pm: 'direct',
      url: 'https://example.com/missing.tar.gz',
      binary: 'missing',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('chain_resolved_install_failed');
    expect(result.details).toMatch(/^Download failed:/);
  });

  test('extract-fail surfaces "Extract failed:" in details', async () => {
    const responder: ExecResponder = (cmd) => {
      if (cmd.startsWith('(') && cmd.includes('GATE:download')) {
        return {
          success: false,
          stdout: '',
          stderr: 'GATE:download\nGATE:extract\nDETAILS:Extract failed: gzip: stdin: not in gzip format\n',
          exitCode: 12,
        };
      }
      return defaultResponder(cmd);
    };
    const { stub } = makeStub(responder);
    const result = await score(stub, {
      pm: 'direct',
      url: 'https://example.com/notarchive.tar.gz',
      binary: 'foo',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('chain_resolved_install_failed');
    expect(result.details).toMatch(/^Extract failed:/);
  });

  test('no-binary-candidates → chain_resolved_no_binary_produced + lists archive contents', async () => {
    // Red-team case: an archive that ships only docs. The auto-detect
    // filter strips every entry, the pipeline exits 11, and the
    // orchestration re-classifies as no_binary_produced (it's an
    // "archive shipped no executable" miss, not an "install failed"
    // miss).
    const responder: ExecResponder = (cmd) => {
      if (cmd.startsWith('(') && cmd.includes('GATE:download')) {
        return {
          success: false,
          stdout: '',
          stderr:
            'GATE:download\nGATE:extract\nGATE:find_binary\nDETAILS:Archive contains no binary named foo. Files seen: LICENSE README.md\n',
          exitCode: 11,
        };
      }
      return defaultResponder(cmd);
    };
    const { stub } = makeStub(responder);
    const result = await score(stub, {
      pm: 'direct',
      url: 'https://example.com/docs-only.tar.gz',
      binary: 'foo',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('chain_resolved_no_binary_produced');
    expect(result.details).toContain('Archive contains no binary named foo');
    expect(result.details).toContain('LICENSE');
  });

  test('install-staging-fail surfaces "Install staging failed:" in details', async () => {
    const responder: ExecResponder = (cmd) => {
      if (cmd.startsWith('(') && cmd.includes('GATE:download')) {
        return {
          success: false,
          stdout: '',
          stderr:
            'GATE:download\nGATE:extract\nGATE:find_binary\nGATE:install_binary\nDETAILS:Install staging failed: install: cannot stat file\n',
          exitCode: 13,
        };
      }
      return defaultResponder(cmd);
    };
    const { stub } = makeStub(responder);
    const result = await score(stub, {
      pm: 'direct',
      url: 'https://example.com/x.tar.gz',
      binary: 'foo',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('chain_resolved_install_failed');
    expect(result.details).toMatch(/^Install staging failed:/);
  });

  test('no GATE markers in stderr → falls back to raw truncated stderr (back-compat)', async () => {
    // Non-direct PMs (npm, pip, cargo-binstall) don't emit GATE
    // markers. Existing behavior — surface the raw stderr — must be
    // preserved so we don't regress error messages for the registry-
    // install paths.
    const responder: ExecResponder = (cmd) => {
      if (cmd.startsWith('cargo-binstall ')) {
        return { success: false, stdout: '', stderr: 'plain stderr without markers', exitCode: 1 };
      }
      return defaultResponder(cmd);
    };
    const { stub } = makeStub(responder);
    const result = await score(stub, CARGO_SPEC);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('chain_resolved_install_failed');
    expect(result.details).toBe('plain stderr without markers');
  });

  test('extractGateDetails + extractDetectedBinary export shape', async () => {
    // Sanity-check the parser exports so client-side users can rely on
    // them. Keeps the module surface stable.
    const m = await import('../src/worker/score/sandbox-exec');
    expect(typeof m.extractDetectedBinary).toBe('function');
    expect(typeof m.extractGateDetails).toBe('function');
    expect(m.extractDetectedBinary('foo\nDETECTED_BINARY=gog\n')).toBe('gog');
    expect(m.extractDetectedBinary('no marker')).toBeNull();
    expect(m.extractGateDetails('GATE:download\nDETAILS:Download failed: 404')?.kind).toBe('download');
    expect(
      m.extractGateDetails('GATE:find_binary\nDETAILS:Archive contains no binary named x. Files seen:')?.kind,
    ).toBe('no_binary_candidates');
    expect(m.extractGateDetails('')).toBeNull();
  });
});
