// Page content dates: the git walk behind every page's date, and the build's
// refusal to run on a clone without history.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSitemap } from '../src/build/10-sitemap.mjs';
import { loadFileDates, newestDate, scorecardDate, utcDay } from '../src/build/content-dates.mjs';
import { emitShell } from '../src/build/shell.mjs';

const REPO_ROOT = join(import.meta.dir, '..');

// Git's repository variables outrank `-C` and `cwd`. A run that inherits them
// would commit the fixtures, and write a shallow marker, into that repository,
// so they are held out of this file's environment while it runs.
const GIT_REPO_ENV = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_PREFIX',
  'GIT_NAMESPACE',
];
const heldGitEnv = new Map<string, string>();
beforeAll(() => {
  for (const key of GIT_REPO_ENV) {
    const value = process.env[key];
    if (value !== undefined) heldGitEnv.set(key, value);
    delete process.env[key];
  }
});

const scratch: string[] = [];
afterAll(async () => {
  for (const [key, value] of heldGitEnv) process.env[key] = value;
  for (const dir of scratch) await rm(dir, { recursive: true, force: true });
});

async function scratchDir(label: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `content-dates-${label}-`));
  scratch.push(dir);
  return dir;
}

// Isolated from the machine's git config: no signing, no hooks.
function git(cwd: string, args: string[], committerDate?: string): string {
  return execFileSync(
    'git',
    [
      '-c',
      'user.name=content-dates test',
      '-c',
      'user.email=test@example.invalid',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.hooksPath=/dev/null',
      ...args,
    ],
    {
      cwd,
      encoding: 'utf8',
      env: committerDate
        ? { ...process.env, GIT_COMMITTER_DATE: committerDate, GIT_AUTHOR_DATE: committerDate }
        : process.env,
    },
  );
}

/** A repo whose two commits land on known days, the second one late in a UTC-5 evening. */
async function datedRepo(): Promise<string> {
  const dir = await scratchDir('repo');
  git(dir, ['init', '-q']);
  await mkdir(join(dir, 'content'));
  await writeFile(join(dir, 'content', 'a.md'), 'a\n');
  await writeFile(join(dir, 'content', 'b.md'), 'b\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'first'], '2026-03-01T12:00:00Z');
  await writeFile(join(dir, 'content', 'b.md'), 'b, edited\n');
  git(dir, ['commit', '-q', '-am', 'second'], '2026-04-10T21:30:00-05:00');
  return dir;
}

/** A depth-1 fetch of `source`: the history a default CI checkout gets. */
async function shallowRepo(source: string): Promise<string> {
  const dir = await scratchDir('shallow');
  git(dir, ['init', '-q']);
  git(dir, ['fetch', '-q', '--depth', '1', `file://${source}`, 'HEAD']);
  return dir;
}

describe('loadFileDates — one git walk dates every file', () => {
  test('a file takes the UTC day of the last commit that changed it', async () => {
    const dir = await datedRepo();
    const fileDate = loadFileDates(dir);
    expect(fileDate('content/a.md')).toBe('2026-03-01');
    // 21:30 at UTC-5 is 02:30 the next day in UTC.
    expect(fileDate(join(dir, 'content', 'b.md'))).toBe('2026-04-11');
    expect(fileDate('content/a.md', 'content/b.md')).toBe('2026-04-11');
  });

  test('a content file with uncommitted changes takes today: untracked or edited', async () => {
    const dir = await datedRepo();
    await writeFile(join(dir, 'content', 'new.md'), 'new\n');
    await writeFile(join(dir, 'content', 'a.md'), 'a, edited\n');
    const today = new Date().toISOString().slice(0, 10);
    const fileDate = loadFileDates(dir);
    expect(fileDate('content/new.md')).toBe(today);
    expect(fileDate('content/a.md')).toBe(today);
    expect(fileDate('content/b.md')).toBe('2026-04-11');
  });

  test('a file git has no record of, such as an ignored one, is refused', async () => {
    const dir = await datedRepo();
    await writeFile(join(dir, '.gitignore'), 'content/ignored.md\n');
    await writeFile(join(dir, 'content', 'ignored.md'), 'ignored\n');
    const fileDate = loadFileDates(dir);
    expect(() => fileDate('content/ignored.md')).toThrow(
      'git has no record of content/ignored.md: no commit touched it and git status does not list it, so it is ignored or missing.',
    );
  });

  test('a shallow clone is refused with the commands that fix it', async () => {
    const dir = await shallowRepo(await datedRepo());
    expect(() => loadFileDates(dir)).toThrow(/is a shallow clone, so git history cannot date the pages/);
    expect(() => loadFileDates(dir)).toThrow('Run `git fetch --unshallow`, or check out with `fetch-depth: 0` in CI');
  });

  test('a site nested below the git top level resolves its paths from the site root', async () => {
    const parent = await scratchDir('parent');
    git(parent, ['init', '-q']);
    await mkdir(join(parent, 'site', 'content'), { recursive: true });
    await writeFile(join(parent, 'site', 'content', 'a.md'), 'a\n');
    git(parent, ['add', '.']);
    git(parent, ['commit', '-q', '-m', 'nested'], '2026-06-15T08:00:00Z');
    const fileDate = loadFileDates(join(parent, 'site'));
    expect(fileDate('content/a.md')).toBe('2026-06-15');
    expect(fileDate(join(parent, 'site', 'content', 'a.md'))).toBe('2026-06-15');
  });

  test('a missing git binary is named as such', async () => {
    const dir = await datedRepo();
    const path = process.env.PATH;
    process.env.PATH = join(dir, 'no-such-bin');
    try {
      expect(() => loadFileDates(dir)).toThrow('content dates: git is not installed or not on PATH');
    } finally {
      process.env.PATH = path;
    }
  });

  test('a directory outside any git checkout is refused', async () => {
    const dir = await scratchDir('nogit');
    expect(() => loadFileDates(dir)).toThrow(/is not a git checkout/);
  });
});

describe('date helpers', () => {
  test('newestDate picks the latest day and rejects a non-day', () => {
    expect(newestDate(['2026-03-01', '2026-11-02', '2026-10-28'])).toBe('2026-11-02');
    expect(() => newestDate([])).toThrow(/at least one dated input/);
    expect(() => newestDate(['2026-3-1'])).toThrow(/not a YYYY-MM-DD day/);
  });

  test('a scorecard dates to the UTC day its audit run started', () => {
    expect(scorecardDate({ run: { started_at: '2026-10-28T23:53:58.414771832Z' } })).toBe('2026-10-28');
    expect(scorecardDate({ run: { started_at: '2026-10-28T23:00:00-02:00' } })).toBe('2026-10-29');
    expect(() => utcDay('not a time')).toThrow(/not a valid timestamp/);
  });
});

describe('the outputs refuse a missing or malformed date', () => {
  test('the sitemap refuses a listed path with no date, and a lastmod that is not a day', () => {
    expect(() => buildSitemap({ principleNumbers: [1], lastmodOf: () => undefined })).toThrow(/no content date for \//);
    expect(() => buildSitemap({ principleNumbers: [1], lastmodOf: () => '2026-10-28T00:00:00Z' })).toThrow(
      /is not a day/,
    );
  });

  test('the shell refuses a dateModified that is not a day', () => {
    const page = {
      title: 'T',
      description: 'D',
      canonicalPath: '/about',
      breadcrumb: 'About',
      bodyHtml: '',
      themeInitJs: '',
    };
    expect(() => emitShell({ ...page, dateModified: '28 Oct 2026' })).toThrow(/is not a YYYY-MM-DD day/);
  });
});

describe('the build refuses a shallow clone', () => {
  test('`bun src/build/build.mjs` on a depth-1 history exits non-zero before any stage runs', async () => {
    // The real build entry, run from a copy of the tree whose .git is a
    // depth-1 fetch. REPO_ROOT derives from the entry's own path, so the copy
    // is the repository the build inspects.
    const site = await shallowRepo(await datedRepo());
    await cp(join(REPO_ROOT, 'src'), join(site, 'src'), { recursive: true });
    await cp(join(REPO_ROOT, 'content'), join(site, 'content'), { recursive: true });
    await symlink(join(REPO_ROOT, 'node_modules'), join(site, 'node_modules'));

    const run = spawnSync(process.execPath, ['src/build/build.mjs'], { cwd: site, encoding: 'utf8' });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('is a shallow clone, so git history cannot date the pages');
    expect(run.stderr).toContain('git fetch --unshallow');
    // Only the refusal itself: no source frame quoting the other refusals' text.
    expect(run.stderr).not.toContain('is not a git checkout');
    expect(existsSync(join(site, 'dist'))).toBe(false);
  }, 30_000);
});
