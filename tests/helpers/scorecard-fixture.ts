import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const FIXTURE_DIR = join(new URL('..', import.meta.url).pathname, 'fixtures', 'cli-scorecards-0.9');

export const SCORECARD_FIXTURES = ['uv-v0.12.21.json', 'docker-v29.4.1.json'] as const;

export function loadScorecardFixture(file: (typeof SCORECARD_FIXTURES)[number]): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, file), 'utf8')) as Record<string, unknown>;
}

/** A real anc scorecard with top-level fields replaced. */
export function validScorecard(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...loadScorecardFixture('uv-v0.12.21.json'), ...overrides };
}
