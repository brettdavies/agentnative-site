import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GitCloneInstall, InstallSpec } from '../src/worker/score/discover-binary';
import { type ContainerLike, type ExecLike, score } from '../src/worker/score/sandbox-exec';
import { ANC_VERSION, SPEC_VERSION } from '../src/worker/spec-version.gen';
import { plainCommand } from './helpers/sandbox-command';
import { validScorecard } from './helpers/scorecard-fixture';

const DROP = 'setpriv --reuid=1000 --regid=1000 --clear-groups --no-new-privs --bounding-set=-all --inh-caps=-all ';
const AUDIT_BIN = '/home/anc-audit/.local/bin';
const SCORECARD = JSON.stringify(
  validScorecard({ spec_version: SPEC_VERSION, tool: { name: 'rg', binary: 'rg', version: '14.1.0' } }),
);

const ok = (stdout = ''): ExecLike => ({ success: true, stdout, stderr: '' });

const COMMAND_SPECS: InstallSpec[] = [
  { pm: 'cargo-binstall', package: 'ripgrep', binary: 'rg' },
  { pm: 'pip', package: 'black', binary: 'black' },
  { pm: 'uv', package: 'ruff', binary: 'ruff' },
  { pm: 'npm', package: 'typescript', binary: 'tsc' },
  { pm: 'bun', package: 'prettier', binary: 'prettier' },
  { pm: 'direct', url: 'https://example.com/tool.tar.gz', binary: 'tool' },
];
const GIT_CLONE: GitCloneInstall = { pm: 'git-clone', owner: 'cli', repo: 'cli', branch: 'main', binary: 'cli' };
const CARGO = COMMAND_SPECS[0];

type Override = (plain: string) => ExecLike | undefined;

function record(override: Override = () => undefined): { stub: ContainerLike; commands: string[] } {
  const commands: string[] = [];
  const stub: ContainerLike = {
    async setOutboundHandler(): Promise<void> {},
    async exec(command: string): Promise<ExecLike> {
      commands.push(command);
      const plain = plainCommand(command);
      const replaced = override(plain);
      if (replaced) return replaced;
      if (plain.startsWith('which ')) return ok(`${AUDIT_BIN}/rg\n`);
      if (plain === 'anc --version') return ok(`anc ${ANC_VERSION}\n`);
      if (plain.startsWith('anc audit ')) return ok(SCORECARD);
      return ok();
    },
  };
  return { stub, commands };
}

const isCheck = (c: string): boolean => c.includes('/usr/bin/test ');
const isWhich = (c: string): boolean => plainCommand(c).startsWith('which ');
const isAuditor = (c: string): boolean => /^anc( |$)/.test(plainCommand(c));
const isInstall = (c: string): boolean => !isCheck(c) && !isWhich(c) && !isAuditor(c);
const label = (spec: InstallSpec): string => spec.pm;

function pathOf(command: string): string[] {
  const value = /(?:^| )PATH=(\S+)/.exec(command)?.[1];
  if (value === undefined) throw new Error(`no PATH in ${command}`);
  return value.split(':');
}

describe('every sandbox command runs as the audit user', () => {
  test.each(COMMAND_SPECS.map((spec) => [label(spec), spec] as const))('%s audit', async (_pm, spec) => {
    const { stub, commands } = record();
    await score(stub, spec);
    expect(commands.length).toBeGreaterThanOrEqual(4);
    for (const command of commands) {
      expect(command.replace(/^unshare --net -- /, '').startsWith(DROP)).toBe(true);
    }
  });

  test('git-clone audit', async () => {
    const { stub, commands } = record();
    await score(stub, GIT_CLONE);
    expect(commands.length).toBeGreaterThanOrEqual(3);
    for (const command of commands) {
      expect(command.replace(/^unshare --net -- /, '').startsWith(DROP)).toBe(true);
    }
  });
});

describe("installs stay in the audit user's home", () => {
  test.each(COMMAND_SPECS.map((spec) => [label(spec), spec] as const))(
    '%s names no system bin directory',
    async (_pm, spec) => {
      const { stub, commands } = record();
      await score(stub, spec);
      const install = commands.find(isInstall);
      expect(install).toBeDefined();
      expect(plainCommand(install ?? '')).not.toContain('/usr/local/bin');
    },
  );

  test.each(COMMAND_SPECS.map((spec) => [label(spec), spec] as const))(
    '%s install PATH holds only root-owned directories',
    async (_pm, spec) => {
      const { stub, commands } = record();
      await score(stub, spec);
      const entries = pathOf(commands.find(isInstall) ?? '');
      expect(entries.length).toBeGreaterThan(0);
      for (const entry of entries) {
        expect(entry.startsWith('/home/')).toBe(false);
        expect(entry.startsWith('/tmp')).toBe(false);
      }
    },
  );

  test('uv refuses source builds', async () => {
    const { stub, commands } = record();
    await score(stub, { pm: 'uv', package: 'ruff', binary: 'ruff' });
    expect(commands.find(isInstall)).toContain('uv tool install --no-build ');
  });

  test('npm cannot clone a git dependency', async () => {
    const { stub, commands } = record();
    await score(stub, { pm: 'npm', package: 'typescript', binary: 'tsc' });
    expect(commands.find(isInstall)).toContain('--git=/bin/false');
  });

  test('the install environment carries ignore-scripts into the inner npm a dependency starts', async () => {
    const { stub, commands } = record();
    await score(stub, { pm: 'npm', package: 'typescript', binary: 'tsc' });
    expect(commands.find(isInstall)).toContain('npm_config_ignore_scripts=true');
  });

  test('verification starts which by absolute path', async () => {
    const { stub, commands } = record();
    await score(stub, CARGO);
    expect(commands.find(isWhich)).toContain(' /usr/bin/which ');
  });
});

describe('the auditor runs isolated from the audited code', () => {
  test('anc --version and the audit carry a network namespace', async () => {
    const { stub, commands } = record();
    await score(stub, CARGO);
    const auditor = commands.filter(isAuditor);
    expect(auditor).toHaveLength(2);
    for (const command of auditor) expect(command.startsWith('unshare --net -- ')).toBe(true);
  });

  test('install and verification do not', async () => {
    const { stub, commands } = record();
    await score(stub, CARGO);
    for (const command of commands.filter((c) => !isAuditor(c))) expect(command).not.toContain('unshare');
  });

  test("the audit PATH leads with the audit user's bin directory", async () => {
    const { stub, commands } = record();
    await score(stub, CARGO);
    for (const command of commands.filter(isAuditor)) expect(pathOf(command)[0]).toBe(AUDIT_BIN);
  });

  test('the auditor starts by absolute path with no shell', async () => {
    const { stub, commands } = record();
    await score(stub, CARGO);
    for (const command of commands.filter(isAuditor)) {
      expect(command).toContain(' /usr/local/bin/anc ');
      expect(command).not.toMatch(/\b(?:ba)?sh -c\b/);
    }
  });

  test('a command audit reads no package-supplied config', async () => {
    const { stub, commands } = record();
    await score(stub, CARGO);
    const audit = commands.find((c) => plainCommand(c).startsWith('anc audit '));
    expect(audit).toContain(' AGENTNATIVE_REPO=/opt/anc-empty ');
    expect(audit).toContain(' AGENTNATIVE_HOME_CONFIG=/dev/null ');
  });

  test('a git-clone audit keeps the repository config', async () => {
    const { stub, commands } = record();
    await score(stub, GIT_CLONE);
    const audit = commands.find((c) => plainCommand(c).startsWith('anc audit '));
    expect(audit).toBeDefined();
    expect(audit).not.toContain('AGENTNATIVE_');
  });
});

describe('the auditor stays unwritable', () => {
  test('the write check runs before install', async () => {
    const { stub, commands } = record();
    await score(stub, CARGO);
    expect(isCheck(commands[0] ?? '')).toBe(true);
    expect(commands[0]).toContain('! -w /usr/local/bin/anc -a ! -w /usr/local/bin');
  });

  test('a run whose write check reports the auditor as writable starts no install', async () => {
    const { stub, commands } = record((plain) =>
      plain.includes('/usr/bin/test ') ? { success: false, stdout: '', stderr: '' } : undefined,
    );
    await expect(score(stub, CARGO)).rejects.toThrow();
    expect(commands.filter((c) => !isCheck(c))).toHaveLength(0);
  });
});

describe('failed setup names itself', () => {
  test('an anc --version failure carries its stderr', async () => {
    const { stub } = record((plain) =>
      plain === 'anc --version'
        ? { success: false, stdout: '', stderr: 'unshare: Operation not permitted' }
        : undefined,
    );
    const result = await score(stub, CARGO);
    expect(result).toMatchObject({
      ok: false,
      error: 'anc_version_unreadable',
      details: 'unshare: Operation not permitted',
    });
  });
});

describe('the image and the Worker agree', () => {
  const dockerfile = readFileSync(join(import.meta.dir, '..', 'docker', 'sandbox', 'Dockerfile'), 'utf8');

  test('on the audit user, its bin directory and the empty directory', async () => {
    const { stub, commands } = record();
    await score(stub, CARGO);
    const audit = commands.find((c) => plainCommand(c).startsWith('anc audit ')) ?? '';
    expect(dockerfile).toContain('--uid 1000 ');
    expect(audit).toContain('--reuid=1000 ');
    expect(dockerfile).toContain(AUDIT_BIN);
    expect(audit).toContain(`PATH=${AUDIT_BIN}:`);
    expect(dockerfile).toContain('/opt/anc-empty');
    expect(audit).toContain('AGENTNATIVE_REPO=/opt/anc-empty');
  });
});
