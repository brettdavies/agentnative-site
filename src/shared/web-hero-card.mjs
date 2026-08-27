// Homepage hero web proof card — build-time HTML for the Website toggle.
// Snapshot: src/data/web-audit/hero-anc.dev.json (not live R2).

import { bandOf, escHtml, renderMeter } from './scorecard-format.mjs';

export const HERO_WEB_DOMAIN = 'anc.dev';

const WEB_HERO_CATEGORIES = [
  { id: 'discoverability', short: 'C1', title: 'Discoverability' },
  { id: 'content-for-agents', short: 'C2', title: 'Content for agents' },
  { id: 'bot-crawl-policy', short: 'C3', title: 'Bot & crawl policy' },
  { id: 'api', short: 'C4', title: 'API' },
  { id: 'mcp', short: 'C5', title: 'MCP' },
  { id: 'agent-discovery-auth', short: 'C6', title: 'Agent discovery & auth' },
];

/**
 * @param {{ passed: number, counted: number }} c
 * @returns {'pass' | 'warn' | 'fail'}
 */
function categoryCrowStatus(c) {
  if (c.counted <= 0) return 'warn';
  if (c.passed === c.counted) return 'pass';
  if (c.passed === 0) return 'fail';
  return 'warn';
}

/**
 * @param {{ score_pct: number, categories: Array<{ id: string, name: string, passed: number, counted: number }> }} scorecard
 * @returns {string}
 */
export function buildWebHeroCard(scorecard) {
  const pct = Math.round(scorecard.score_pct);
  const band = bandOf(pct);
  const byId = new Map(scorecard.categories.map((c) => [c.id, c]));
  const ordered = WEB_HERO_CATEGORIES.map((meta) => ({
    ...meta,
    rollup: byId.get(meta.id) ?? { id: meta.id, name: meta.title, passed: 0, counted: 0 },
  }));
  const counted = ordered.filter((o) => o.rollup.counted > 0);
  const met = counted.filter((o) => o.rollup.passed === o.rollup.counted).length;
  const total = counted.length > 0 ? counted.length : ordered.length;
  const categoriesBand = bandOf(total > 0 ? (met / total) * 100 : 0);

  const firstNonPass = ordered.findIndex((o) => o.rollup.counted > 0 && o.rollup.passed !== o.rollup.counted);
  const rowIdx = [...new Set([0, 1, firstNonPass === -1 ? 2 : firstNonPass])].slice(0, 3);
  const crows = rowIdx
    .map((i) => {
      const o = ordered[i];
      const st = categoryCrowStatus(o.rollup);
      return `      <div class="crow"><span class="id">${o.short}</span> ${escHtml(o.title)} <span class="st ${st}">${st}</span></div>`;
    })
    .join('\n');

  return `    <aside class="card ${band}" data-s="web" aria-label="Web scorecard for ${HERO_WEB_DOMAIN}">
      <div class="card__bar"><span aria-hidden="true">●●●</span><span class="card__bar-right">${HERO_WEB_DOMAIN} · web scorecard</span></div>
      <div class="card__cmd"><span class="p">$</span> audit_website ${HERO_WEB_DOMAIN}</div>
      <div class="card__scores">
        <div class="bigscore ${band}"><span class="bigscore__n">${pct}</span><span class="bigscore__l">score</span>${renderMeter(pct, { num: null })}</div>
        <div class="bigscore ${categoriesBand}"><span class="bigscore__n">${met}/${total}</span><span class="bigscore__l">categories met</span>${renderMeter(total > 0 ? (met / total) * 100 : 0, { num: null })}</div>
      </div>
      <div class="card__rows">
${crows}
      </div>
    </aside>`;
}

/** Fallback when the committed hero snapshot is missing or malformed. */
export function buildWebHeroCardEmptyState() {
  return `    <aside class="card band-mid" data-s="web" aria-label="Web scorecard for ${HERO_WEB_DOMAIN}">
      <div class="card__bar"><span aria-hidden="true">●●●</span><span class="card__bar-right">${HERO_WEB_DOMAIN} · web scorecard</span></div>
      <div class="card__cmd"><span class="p">$</span> audit_website ${HERO_WEB_DOMAIN}</div>
      <p class="card__pending">Scoring in progress. <a href="/web/${HERO_WEB_DOMAIN}">See the scorecard</a> or <a href="/web-audit">run a fresh audit</a>.</p>
    </aside>`;
}

/**
 * @param {unknown} raw
 * @returns {string}
 */
export function buildWebHeroCardFromSnapshot(raw) {
  if (!raw || typeof raw !== 'object') return buildWebHeroCardEmptyState();
  const scorecard = /** @type {{ score_pct?: unknown, categories?: unknown }} */ (raw);
  if (typeof scorecard.score_pct !== 'number' || !Array.isArray(scorecard.categories)) {
    return buildWebHeroCardEmptyState();
  }
  return buildWebHeroCard(
    /** @type {{ score_pct: number, categories: Array<{ id: string, name: string, passed: number, counted: number }> }} */ (
      scorecard
    ),
  );
}
