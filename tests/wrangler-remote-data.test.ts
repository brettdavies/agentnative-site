// Guard: every wrangler command that reads or writes KV or R2 data names its store.
//
// Without --remote these commands act on a local store and exit 0, so they report
// success having never touched deployed data. A kill-switch flip that ran this way
// reported `ok` and left production serving. Scripts and the runbooks an operator
// pastes from both count.

import { describe, expect, test } from 'bun:test';
import { lstatSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { REPO_ROOT } from './helpers/workflows';

const DATA_COMMAND = /(?:^\s*|\bbun x )wrangler (?:kv (?:key|bulk)|r2 object) \w+/;
const NAMES_ITS_STORE = /\s--(?:remote|local)\b/;
const SHEBANG = /^#!.*\b(?:ba)?sh\b/;

/** Lines that run a data command without naming a store. A `\`-continued command is one line. */
function unnamedStore(text: string): string[] {
  return text
    .replace(/\\\n\s*/g, ' ')
    .split('\n')
    .filter((line) => !line.trim().startsWith('#') || line.includes('bun x wrangler'))
    .filter((line) => DATA_COMMAND.test(line) && !NAMES_ITS_STORE.test(line))
    .map((line) => line.trim());
}

function trackedOperatorFiles(): Map<string, string> {
  const listing = Bun.spawnSync(['git', 'ls-files'], { cwd: REPO_ROOT });
  if (listing.exitCode !== 0) throw new Error(`git ls-files failed: ${listing.stderr.toString()}`);
  const files = new Map<string, string>();
  for (const path of listing.stdout.toString().split('\n').filter(Boolean)) {
    const extension = extname(path);
    const isDoc = /^RELEASES[^/]*\.md$|^AGENTS\.md$|^docs\/runbooks\/.*\.md$|^scripts\/.*\.md$/.test(path);
    if (!isDoc && extension !== '' && extension !== '.sh' && extension !== '.bash') continue;
    const absolute = join(REPO_ROOT, path);
    if (!lstatSync(absolute, { throwIfNoEntry: false })?.isFile()) continue;
    const text = readFileSync(absolute, 'utf8');
    if (isDoc || extension !== '' || SHEBANG.test(text)) files.set(path, text);
  }
  return files;
}

describe('unnamedStore', () => {
  test.each([
    'bun x wrangler kv key put --binding=SCORE_KV scoring_disabled true',
    '  wrangler kv key delete --binding=SCORE_KV --env staging scoring_disabled',
    'WRANGLER_STDOUT="$(bun x wrangler kv key get --binding=SCORE_KV "$FLAG" key 2>"$F")"',
    'bun x wrangler r2 object list bucket --prefix=scores/ | head -20',
    'bun x wrangler kv bulk put file.json',
    'bun x wrangler kv key put \\\n  --binding=SCORE_KV key value',
  ])('reports %j', (line) => {
    expect(unnamedStore(line)).toHaveLength(1);
  });

  test.each([
    'bun x wrangler kv key put --remote --binding=SCORE_KV scoring_disabled true',
    'wrangler kv key get --binding SCORE_KV --remote key',
    'bun x wrangler kv key put \\\n  --binding=SCORE_KV --remote key value',
    'bun x wrangler kv key get --local --binding=SCORE_KV key',
    'Flip via `wrangler kv key put`:',
    'bun x wrangler r2 bucket lifecycle list bucket',
    '# wrangler kv key put in a comment',
  ])('allows %j', (line) => {
    expect(unnamedStore(line)).toEqual([]);
  });
});

describe('wrangler data commands name their store', () => {
  const files = trackedOperatorFiles();

  test('the scan reaches the kill-switch scripts and the runbooks that document them', () => {
    expect([...files.keys()]).toEqual(
      expect.arrayContaining([
        'scripts/ops/flip-kill-switch.sh',
        'scripts/monitoring/check-kill-switch.sh',
        'scripts/monitoring/check-r2-cache.sh',
        'docs/runbooks/live-scoring-monitoring.md',
        'RELEASES.md',
      ]),
    );
  });

  test('none in a script or runbook leaves the store unnamed', () => {
    const offenders = [...files].flatMap(([path, text]) => unnamedStore(text).map((line) => `${path}: ${line}`));
    expect(offenders, 'without --remote wrangler acts on a local store and exits 0').toEqual([]);
  });
});
