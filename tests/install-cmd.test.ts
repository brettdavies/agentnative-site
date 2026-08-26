import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { loadInstallCommands } from '../src/build/install-commands.mjs';
import { nextPm, resolvePm } from '../src/client/install-cmd';

const CONTENT_DIR = join(import.meta.dir, '../content');

describe('loadInstallCommands', () => {
  test('reads brew + cargo install + cargo binstall fences from content/install.md', () => {
    const cmds = loadInstallCommands(CONTENT_DIR);
    expect(cmds.brew).toBe('brew install brettdavies/tap/agentnative');
    expect(cmds.cargo).toBe('cargo install agentnative');
    expect(cmds.binstall).toBe('cargo binstall agentnative');
  });
});

describe('resolvePm', () => {
  test('honors a stored brew, cargo, or binstall preference', () => {
    expect(resolvePm('brew')).toBe('brew');
    expect(resolvePm('cargo')).toBe('cargo');
    expect(resolvePm('binstall')).toBe('binstall');
  });

  test('picks randomly when nothing is stored', () => {
    expect(resolvePm(null, () => 0)).toBe('brew');
    expect(resolvePm(null, () => 0.4)).toBe('cargo');
    expect(resolvePm(null, () => 0.9)).toBe('binstall');
    expect(resolvePm('npm', () => 0)).toBe('brew');
  });
});

describe('nextPm', () => {
  test('cycles brew → cargo → binstall → brew', () => {
    expect(nextPm('brew')).toBe('cargo');
    expect(nextPm('cargo')).toBe('binstall');
    expect(nextPm('binstall')).toBe('brew');
  });
});
