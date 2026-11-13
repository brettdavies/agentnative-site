// The client guide's example answers are what an agent copies its expectations
// from. A live or cached answer carries the spec version the server sends; a
// curated answer carries the spec its committed scorecard was scored against,
// so that example is held to the committed scorecard instead.

import { describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SPEC_VERSION } from '../src/worker/spec-version.gen';

const ROOT = join(import.meta.dir, '..');
const GUIDE = join(ROOT, 'content', 'mcp-skill.md');
const SCORECARDS = join(ROOT, 'scorecards');
const CURATED_CALL = 'tools/call get_scorecard { "slug": "ripgrep" }';

type CuratedExample = {
  spec_version?: string;
  score_pct?: number;
  freshness?: { scored_at?: string };
};

type CommittedScorecard = {
  spec_version: string;
  badge: { score_pct: number };
  run: { started_at: string };
};

function jsonBlocks(guide: string): string[] {
  return [...guide.matchAll(/```json\n([\s\S]*?)```/g)].map((match) => match[1] ?? '');
}

function curatedBlock(guide: string): string {
  const blocks = jsonBlocks(guide).filter((block) => block.includes(CURATED_CALL));
  expect(blocks).toHaveLength(1);
  return blocks[0] ?? '';
}

async function committedRipgrep(): Promise<CommittedScorecard> {
  const files = (await readdir(SCORECARDS)).filter((file) => /^ripgrep-v.+\.json$/.test(file));
  expect(files).toHaveLength(1);
  return JSON.parse(await readFile(join(SCORECARDS, files[0] ?? ''), 'utf8')) as CommittedScorecard;
}

describe('content/mcp-skill.md examples', () => {
  test('every spec_version outside the curated example is the version the server sends', async () => {
    const guide = await readFile(GUIDE, 'utf8');
    const rest = guide.replace(curatedBlock(guide), '');
    const literals = [...rest.matchAll(/"spec_version":\s*"([^"]*)"/g)].map((match) => match[1]);
    expect(literals.length).toBeGreaterThan(0);
    expect(literals.filter((value) => value !== SPEC_VERSION)).toEqual([]);
  });

  test('the curated get_scorecard example carries the committed scorecard spec version, score, and scored_at', async () => {
    const guide = await readFile(GUIDE, 'utf8');
    const example = JSON.parse(
      curatedBlock(guide)
        .split('\n')
        .filter((line) => !line.startsWith('//'))
        .join('\n'),
    ) as CuratedExample;
    const scorecard = await committedRipgrep();
    expect(example.spec_version).toBe(scorecard.spec_version);
    expect(example.score_pct).toBe(scorecard.badge.score_pct);
    expect(example.freshness?.scored_at).toBe(scorecard.run.started_at);
  });
});
