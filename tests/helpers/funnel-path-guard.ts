// Scanner behind tests/no-funnel-path-literals.test.ts. Pure over source
// text so the test can feed it fixtures as well as the real tree.

import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import { REPO_ROOT } from './workflows';

export type Hit = { file: string; line: number; literal: string; text: string };
export type GuardMode = 'warn' | 'gate';

const SRC_DIR = join(REPO_ROOT, 'src');
const ROUTE_MODULE = 'src/shared/audit-routes.ts';

// Ordered longest-first within each family so a prefix never wins over
// the path it is a prefix of. A path must start where it is found: the
// lookbehind keeps `audits/web/` (an R2 key) and `./web-audit` (an
// import) out, and the bare names carry a boundary so `/audit` does not
// match `./audit-web/` and `/check` does not match `/checks`.
const FUNNEL_PATH_RE =
  /(?<![\w.])(?:\/web\/scoring|\/web-audit(?![\w-])|\/score\/live(?![\w-])|\/api\/audit-web(?![\w-])|\/api\/score(?![\w-])|\/scoring(?![\w-])|\/scorecards(?![\w-])|\/score\/|\/fix\/|\/web\/|\/web(?![\w-])|\/audit(?![\w-])|\/check(?![\w-]))/g;

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
      hits.push({ file, line: i + 1, literal: match[0], text: line.trim() });
    }
  }
  return hits;
}

/** Scan every source file under src/ except the route module, the vendored spec, and generated types. */
export async function scanTree(root: string = SRC_DIR): Promise<Hit[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && SCANNED_EXTENSIONS.has(extname(entry.name)))
    .map((entry) => relative(REPO_ROOT, join(entry.parentPath, entry.name)))
    .filter((rel) => !EXCLUDED_PREFIXES.some((p) => rel.startsWith(p)))
    .sort();
  const perFile = await Promise.all(
    files.map(async (rel) => scanSource(await readFile(join(REPO_ROOT, rel), 'utf8'), rel)),
  );
  return perFile.flat();
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
