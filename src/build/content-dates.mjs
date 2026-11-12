// Page content dates. Each built page carries one date: the newest change
// among the content it renders. The same value feeds the sitemap
// `<lastmod>`, the JSON-LD `dateModified`, `article:modified_time`, and the
// markdown twin's `dateModified` frontmatter key.
//
// A file's date is the UTC committer day of the last commit that changed
// it, read from one `git log` walk over the whole history; a file with
// uncommitted changes dates to today.

import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Whether a value is a `YYYY-MM-DD` day string.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isDay(value) {
  return typeof value === 'string' && DAY_RE.test(value);
}

function git(repoRoot, args) {
  return execFileSync('git', ['-C', repoRoot, ...args], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * The UTC calendar day of an instant.
 *
 * @param {string | number | Date} instant — an RFC 3339 string, epoch milliseconds, or a Date
 * @returns {string} `YYYY-MM-DD`
 */
export function utcDay(instant) {
  const date = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`content date: "${instant}" is not a valid timestamp`);
  }
  return date.toISOString().slice(0, 10);
}

/**
 * A scorecard's content date: the UTC day its audit run started. A shared
 * registry or seed file dates every entry alike, so a page built from one
 * entry takes the entry's own date instead.
 *
 * @param {{ run: { started_at: string } }} scorecard
 * @returns {string}
 */
export function scorecardDate(scorecard) {
  return utcDay(scorecard.run.started_at);
}

/**
 * The latest of one or more `YYYY-MM-DD` days.
 *
 * @param {string[]} days
 * @returns {string}
 */
export function newestDate(days) {
  if (days.length === 0) throw new Error('content date: a page needs at least one dated input');
  for (const day of days) {
    if (!isDay(day)) throw new Error(`content date: "${day}" is not a YYYY-MM-DD day`);
  }
  return [...days].sort().at(-1);
}

/** A refusal the build reports as its message alone, without a source frame. */
export class ContentDateError extends Error {}

/**
 * Read every file's content day in one pass: the last commit that changed a
 * committed file, or today for a file with uncommitted changes, since its
 * content is changing today. A clean CI checkout never takes today's date.
 *
 * Throws when git cannot run, when `repoRoot` is not a git checkout, or when
 * it is a shallow clone, naming the fix. On a shallow clone every file looks
 * committed at the clone's boundary, so it is refused rather than read.
 *
 * @param {string} repoRoot — absolute path to the checkout
 * @returns {(...paths: string[]) => string} the newest content day among the
 *   given files (absolute, or relative to `repoRoot`). Throws for a file git
 *   has no record of.
 */
export function loadFileDates(repoRoot) {
  let shallow;
  let toplevel;
  try {
    [shallow, toplevel] = git(repoRoot, ['rev-parse', '--is-shallow-repository', '--show-toplevel']).trim().split('\n');
  } catch (err) {
    const reason = String(err.stderr || err.message)
      .trim()
      .split('\n')[0];
    if (err.code === 'ENOENT') {
      throw new ContentDateError(
        `content dates: git is not installed or not on PATH (${reason}). The build dates each page from git history.`,
      );
    }
    throw new ContentDateError(
      `content dates: ${repoRoot} is not a git checkout (${reason}). The build dates each page from git history; build from a clone of the repository.`,
    );
  }
  if (shallow === 'true') {
    throw new ContentDateError(
      `content dates: ${repoRoot} is a shallow clone, so git history cannot date the pages. ` +
        'Run `git fetch --unshallow`, or check out with `fetch-depth: 0` in CI, then build again.',
    );
  }

  // Each commit opens with a NUL-led timestamp line; git C-quotes control
  // characters in paths, so no path line can start with NUL. `--no-renames`
  // keeps the walk independent of diff.renames and of blob contents, so a
  // blobless clone answers it from trees alone. Paths are relative to the
  // top level, which sits above `repoRoot` when the site is nested.
  const out = git(repoRoot, ['-c', 'core.quotePath=false', 'log', '--no-renames', '--name-only', '--format=%x00%ct']);
  const dayOf = new Map();
  let day = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('\0')) {
      day = utcDay(Number(line.slice(1)) * 1000);
    } else if (line !== '' && day !== null) {
      const known = dayOf.get(line);
      if (known === undefined || day > known) dayOf.set(line, day);
    }
  }
  if (dayOf.size === 0) {
    throw new ContentDateError(
      `content dates: git log in ${repoRoot} listed no files; the build needs the repository history.`,
    );
  }

  // Each `-z` record is `XY <path>`, its path relative to the top level.
  const today = utcDay(Date.now());
  const status = git(repoRoot, ['status', '--porcelain', '-z', '--untracked-files=all', '--no-renames']);
  for (const record of status.split('\0')) {
    if (record.length > 3) dayOf.set(record.slice(3), today);
  }

  return (...paths) =>
    newestDate(
      paths.map((path) => {
        const abs = isAbsolute(path) ? path : join(repoRoot, path);
        const key = relative(toplevel, existsSync(abs) ? realpathSync(abs) : abs);
        const known = dayOf.get(key);
        if (known === undefined) {
          throw new ContentDateError(
            `content dates: git has no record of ${key}: no commit touched it and git status does not list it, so it is ignored or missing.`,
          );
        }
        return known;
      }),
    );
}
