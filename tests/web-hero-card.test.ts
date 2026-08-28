// Homepage web hero card — baked at build from src/data/web-audit/hero-anc.dev.json.

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  buildWebHeroCard,
  buildWebHeroCardEmptyState,
  buildWebHeroCardFromSnapshot,
  HERO_WEB_DOMAIN,
} from '../src/shared/web-hero-card.mjs';

const SNAPSHOT_PATH = join(import.meta.dir, '..', 'src', 'data', 'web-audit', 'hero-anc.dev.json');

describe('buildWebHeroCard', () => {
  test('renders score, categories met, and three crow rows from a scorecard', () => {
    const html = buildWebHeroCard({
      score_pct: 97,
      categories: [
        { id: 'discoverability', name: 'Discoverability', passed: 7, counted: 7 },
        { id: 'content-for-agents', name: 'Content for agents', passed: 16, counted: 16 },
        { id: 'bot-crawl-policy', name: 'Bot & crawl policy', passed: 4, counted: 4 },
        { id: 'api', name: 'API', passed: 0, counted: 0 },
        { id: 'mcp', name: 'MCP', passed: 9, counted: 11 },
        { id: 'agent-discovery-auth', name: 'Agent discovery & auth', passed: 4, counted: 4 },
      ],
    });
    expect(html).toContain(`data-s="web"`);
    expect(html).toContain(`aria-label="Web scorecard for ${HERO_WEB_DOMAIN}"`);
    expect(html).toContain(`audit_website ${HERO_WEB_DOMAIN}`);
    expect(html).toContain('bigscore__n">97');
    expect(html).toContain('4/5'); // counted categories with checks; api counted=0 excluded
    expect(html).toContain('class="st warn">warn'); // mcp partial
  });

  test('empty state keeps the web slot and points at /web and /web-audit', () => {
    const html = buildWebHeroCardEmptyState();
    expect(html).toContain(`data-s="web"`);
    expect(html).toContain('card__pending');
    expect(html).toContain(`/web/${HERO_WEB_DOMAIN}`);
    expect(html).toContain('/web-audit');
  });

  test('committed snapshot produces a scored card, not the empty state', async () => {
    const raw = JSON.parse(await readFile(SNAPSHOT_PATH, 'utf8'));
    const html = buildWebHeroCardFromSnapshot(raw);
    expect(html).not.toContain('card__pending');
    expect(html).toContain('bigscore__n">97');
    expect(html).toContain(HERO_WEB_DOMAIN);
  });

  test('malformed snapshot falls back to empty state', () => {
    expect(buildWebHeroCardFromSnapshot(null)).toContain('card__pending');
    expect(buildWebHeroCardFromSnapshot({})).toContain('card__pending');
    expect(buildWebHeroCardFromSnapshot({ score_pct: '97', categories: [] })).toContain('card__pending');
  });
});
