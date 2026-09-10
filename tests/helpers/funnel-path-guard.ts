// Scanner behind tests/no-funnel-path-literals.test.ts. Pure over source
// text so the test can feed it fixtures as well as the real tree.

import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import {
  API_SCORE_PATH,
  AUDIT_PATH,
  FIX_PREFIX,
  SCORE_PREFIX,
  SCORECARDS_PATH,
  SCORING_PATH,
} from '../../src/shared/audit-routes';
import { CANONICAL_SITE_URL } from '../../src/shared/site-url';
import { REPO_ROOT } from './workflows';

export type Hit = { file: string; line: number; literal: string; text: string };
export type GuardMode = 'warn' | 'gate';

const SRC_DIR = join(REPO_ROOT, 'src');
const ROUTE_MODULE = 'src/shared/audit-routes.ts';

/** The live funnel vocabulary, read from the module the guard protects so a rename cannot un-guard it. */
export const CURRENT_PATHS: readonly string[] = [
  SCORING_PATH,
  SCORECARDS_PATH,
  AUDIT_PATH,
  API_SCORE_PATH,
  SCORE_PREFIX,
  FIX_PREFIX,
];

/** Retired paths have no constant to import; they are literals by definition. */
const RETIRED_PATHS: readonly string[] = [
  '/web/scoring',
  '/web-audit',
  '/score/live',
  '/api/audit-web',
  '/web/',
  '/web',
  '/check',
];

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// One alternative per path. A slash may carry a regex escape so route
// dispatchers such as /^\/score\/live\// count; a bare name carries a
// boundary so `/audit` does not match `./audit-web/` and `/check` does
// not match `/checks`. Longest first, so a prefix never wins over the
// path it is a prefix of.
function pathAlternative(path: string): string {
  const body = escapeRegex(path).replace(/\//g, '\\\\?\\/');
  return path.endsWith('/') ? body : `${body}(?![\\w-])`;
}

// A path must start where it is found: after a non-word, non-dot
// character (so `audits/web/`, an R2 key, and `./web-audit`, an import,
// stay out), or after one of the site's own hosts (so an absolute URL
// to this site counts while an external URL such as
// `https://example.com/check` does not).
const OWN_HOSTS = [escapeRegex(new URL(CANONICAL_SITE_URL).host), '\\.workers\\.dev', 'localhost(?::\\d+)?'];

const FUNNEL_PATH_RE = new RegExp(
  `(?:(?<![\\w.])|(?<=${OWN_HOSTS.join('|')}))(?:${[...CURRENT_PATHS, ...RETIRED_PATHS]
    .slice()
    .sort((a, b) => b.length - a.length)
    .map(pathAlternative)
    .join('|')})`,
  'g',
);

const SCANNED_EXTENSIONS = new Set(['.ts', '.mjs', '.js', '.yaml', '.yml']);
const EXCLUDED_PREFIXES = ['src/data/spec/', 'src/worker-configuration.d.ts', ROUTE_MODULE];

function isCommentLine(line: string): boolean {
  const stripped = line.trim();
  return stripped.startsWith('//') || stripped.startsWith('*') || stripped.startsWith('/*') || stripped.startsWith('#');
}

/** Every funnel path literal in `source`, one hit per occurrence, comment lines skipped. */
export function scanSource(source: string, file: string): Hit[] {
  const hits: Hit[] = [];
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isCommentLine(line)) continue;
    for (const match of line.matchAll(FUNNEL_PATH_RE)) {
      hits.push({ file, line: i + 1, literal: match[0].replace(/\\/g, ''), text: line.trim() });
    }
  }
  return hits;
}

/** Repo-relative source files under src/ except the route module, the vendored spec, and generated types. */
export async function listScannedFiles(root: string = SRC_DIR): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && SCANNED_EXTENSIONS.has(extname(entry.name)))
    .map((entry) => relative(REPO_ROOT, join(entry.parentPath, entry.name)))
    .filter((rel) => !EXCLUDED_PREFIXES.some((p) => rel.startsWith(p)))
    .sort();
}

/** Scan every file listScannedFiles names. */
export async function scanTree(root: string = SRC_DIR): Promise<Hit[]> {
  const files = await listScannedFiles(root);
  const perFile = await Promise.all(
    files.map(async (rel) => scanSource(await readFile(join(REPO_ROOT, rel), 'utf8'), rel)),
  );
  return perFile.flat();
}

/** The guard mode an environment value selects; unset means warn, anything but warn or gate is an error. */
export function resolveMode(value: string | undefined): GuardMode {
  if (value === undefined || value === '' || value === 'warn') return 'warn';
  if (value === 'gate') return 'gate';
  throw new Error(`FUNNEL_PATH_GUARD_MODE must be 'warn' or 'gate', got ${JSON.stringify(value)}`);
}

function summarize(hits: Hit[]): string {
  const byFile = new Map<string, number>();
  for (const h of hits) byFile.set(h.file, (byFile.get(h.file) ?? 0) + 1);
  const lines = hits.map((h) => `  ${h.file}:${h.line}: ${h.literal}  ${h.text}`);
  const files = [...byFile.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([f, n]) => `  ${n.toString().padStart(3)}  ${f}`);
  return `${hits.length} funnel path literal(s) outside ${ROUTE_MODULE} in ${byFile.size} file(s):\n${lines.join('\n')}\n\nby file:\n${files.join('\n')}`;
}

/** Warn and return in warning mode; throw in gate mode. `report` defaults to console.warn. */
export function enforce(hits: Hit[], mode: GuardMode, report: (msg: string) => void = console.warn): void {
  if (hits.length === 0) return;
  const summary = summarize(hits);
  if (mode === 'gate') {
    throw new Error(`funnel path literal guard (gate mode): route every path through ${ROUTE_MODULE}\n${summary}`);
  }
  report(`WARNING: funnel path literal guard (warning mode)\n${summary}`);
}
