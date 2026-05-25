import { describe, expect, test } from 'bun:test';
import { parseInstallCommand } from '../src/worker/score/parse-install';

describe('parseInstallCommand — happy paths from plan U4 table', () => {
  test('brew install <pkg>', () => {
    expect(parseInstallCommand('brew install ripgrep')).toEqual({
      ok: true,
      value: { pm: 'brew', package: 'ripgrep', binary: 'ripgrep' },
    });
  });

  test('brew <pkg> shorthand', () => {
    expect(parseInstallCommand('brew ripgrep')).toEqual({
      ok: true,
      value: { pm: 'brew', package: 'ripgrep', binary: 'ripgrep' },
    });
  });

  test('cargo install <pkg> normalizes to cargo-binstall', () => {
    expect(parseInstallCommand('cargo install ripgrep')).toEqual({
      ok: true,
      value: { pm: 'cargo-binstall', package: 'ripgrep', binary: 'ripgrep' },
    });
  });

  test('cargo binstall <pkg>', () => {
    expect(parseInstallCommand('cargo binstall ripgrep')).toEqual({
      ok: true,
      value: { pm: 'cargo-binstall', package: 'ripgrep', binary: 'ripgrep' },
    });
  });

  test('bun add -g <pkg>', () => {
    expect(parseInstallCommand('bun add -g hyperfine')).toEqual({
      ok: true,
      value: { pm: 'bun', package: 'hyperfine', binary: 'hyperfine' },
    });
  });

  test('bun install -g <pkg>', () => {
    expect(parseInstallCommand('bun install -g hyperfine')).toEqual({
      ok: true,
      value: { pm: 'bun', package: 'hyperfine', binary: 'hyperfine' },
    });
  });

  test('bun i -g <pkg>', () => {
    expect(parseInstallCommand('bun i -g hyperfine')).toEqual({
      ok: true,
      value: { pm: 'bun', package: 'hyperfine', binary: 'hyperfine' },
    });
  });

  test('uv tool install <pkg> resolves to pm=uv (split from pip in U6 rework)', () => {
    expect(parseInstallCommand('uv tool install black')).toEqual({
      ok: true,
      value: { pm: 'uv', package: 'black', binary: 'black' },
    });
  });

  test('pip install <pkg>', () => {
    expect(parseInstallCommand('pip install black')).toEqual({
      ok: true,
      value: { pm: 'pip', package: 'black', binary: 'black' },
    });
  });

  test('pip3 install <pkg>', () => {
    expect(parseInstallCommand('pip3 install black')).toEqual({
      ok: true,
      value: { pm: 'pip', package: 'black', binary: 'black' },
    });
  });

  test('pipx install <pkg>', () => {
    expect(parseInstallCommand('pipx install black')).toEqual({
      ok: true,
      value: { pm: 'pip', package: 'black', binary: 'black' },
    });
  });

  test('npm install -g <pkg>', () => {
    expect(parseInstallCommand('npm install -g typescript')).toEqual({
      ok: true,
      value: { pm: 'npm', package: 'typescript', binary: 'typescript' },
    });
  });

  test('npm i -g <pkg>', () => {
    expect(parseInstallCommand('npm i -g typescript')).toEqual({
      ok: true,
      value: { pm: 'npm', package: 'typescript', binary: 'typescript' },
    });
  });

  test('yarn global add <pkg> normalizes to npm', () => {
    expect(parseInstallCommand('yarn global add typescript')).toEqual({
      ok: true,
      value: { pm: 'npm', package: 'typescript', binary: 'typescript' },
    });
  });

  test('pnpm add -g <pkg> normalizes to npm', () => {
    expect(parseInstallCommand('pnpm add -g typescript')).toEqual({
      ok: true,
      value: { pm: 'npm', package: 'typescript', binary: 'typescript' },
    });
  });

  test('go install <module>@latest derives binary from module path', () => {
    expect(parseInstallCommand('go install github.com/charmbracelet/glow@latest')).toEqual({
      ok: true,
      value: { pm: 'go', package: 'github.com/charmbracelet/glow', binary: 'glow' },
    });
  });

  test('go install <module>@v1.2.3 strips version pin from package', () => {
    expect(parseInstallCommand('go install github.com/charmbracelet/glow@v1.2.3')).toEqual({
      ok: true,
      value: { pm: 'go', package: 'github.com/charmbracelet/glow', binary: 'glow' },
    });
  });
});

describe('parseInstallCommand — flag handling', () => {
  test('flags between verb and pkg are skipped (npm install -g <pkg>)', () => {
    expect(parseInstallCommand('npm install -g --silent typescript').ok).toBe(true);
  });

  test('multiple flags before pkg', () => {
    const r = parseInstallCommand('pip install --upgrade --user black');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.package).toBe('black');
  });

  test('flag tokens after pkg are ignored (pkg is first non-flag)', () => {
    const r = parseInstallCommand('npm install -g typescript --foo');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.package).toBe('typescript');
  });
});

describe('parseInstallCommand — leading whitespace + shell prompts', () => {
  test('leading whitespace tolerated', () => {
    expect(parseInstallCommand('   brew install ripgrep').ok).toBe(true);
  });

  test('leading $ shell prompt stripped', () => {
    expect(parseInstallCommand('$ brew install ripgrep').ok).toBe(true);
  });

  test('leading $ + space stripped', () => {
    expect(parseInstallCommand('$ pip install black').ok).toBe(true);
  });
});

describe('parseInstallCommand — error paths', () => {
  test('empty string', () => {
    expect(parseInstallCommand('')).toEqual({ ok: false, error: 'unparseable_install_command' });
  });

  test('unknown package manager', () => {
    expect(parseInstallCommand('yum install foo')).toEqual({ ok: false, error: 'unparseable_install_command' });
  });

  test('apt-get install (intentionally unsupported)', () => {
    expect(parseInstallCommand('apt-get install foo').ok).toBe(false);
  });

  test('cargo without install/binstall verb', () => {
    expect(parseInstallCommand('cargo build').ok).toBe(false);
  });

  test('brew without a package', () => {
    expect(parseInstallCommand('brew install').ok).toBe(false);
  });

  test('go install without a module', () => {
    expect(parseInstallCommand('go install').ok).toBe(false);
  });

  test('uv without tool install verb', () => {
    expect(parseInstallCommand('uv install black').ok).toBe(false);
  });

  test('yarn without global add', () => {
    expect(parseInstallCommand('yarn add typescript').ok).toBe(false);
  });

  test('flags-only with no positional pkg', () => {
    expect(parseInstallCommand('npm install -g --silent --no-fund').ok).toBe(false);
  });
});
