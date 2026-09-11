// The spine every `/score/<target>` page opens with, and the score head
// under it. The lanes differ in content, not layout: the crumb, the mono
// h1 with its lane chip, one meta line (tier, freshness, the two
// representation links, the Re-audit control), then one headline numeral
// with its meter and a secondary numeral. Curated pages carry no control;
// an inline render carries no crumb and no links because it has no page.

import { type Lane, leaderboardPath, scoreJsonPath, scoreMarkdownPath } from './audit-routes';
import { escHtml } from './esc-html';
import { bandOf, renderMeter } from './meter';

export type ResultTier = 'registry' | 'cache' | 'live';

export const TIER_LABELS: Readonly<Record<ResultTier, string>> = { registry: 'Curated', cache: 'Cached', live: 'Live' };
export const LANE_LABELS: Readonly<Record<Lane, string>> = { cli: 'CLI', web: 'Website' };

export type ReauditControl =
  /** Enabled at load; the click passes `refresh: true`. */
  | { kind: 'refresh'; target: string; lane: Lane }
  /** Disabled with a countdown until `refreshAfter`; enabled once it has passed. */
  | { kind: 'countdown'; target: string; refreshAfter: string; secondsLeft: number };

export type SpineInput = {
  target: string;
  lane: Lane;
  tier: ResultTier;
  /** The lane's freshness sentence, already escaped HTML. */
  freshnessHtml: string;
  /** False for the inline render, which has no page: no crumb, no links. */
  linked: boolean;
  control: ReauditControl | null;
};

/** The Re-audit control; `aria-disabled`, never `disabled`, so it stays focusable while counting down. */
export function renderReauditControl(control: ReauditControl): string {
  const common = `type="button" class="btn btn--ghost reaudit" data-reaudit data-target="${escHtml(control.target)}"`;
  if (control.kind === 'refresh') {
    return `<button ${common} data-lane="${control.lane}" data-refresh="1">Re-audit</button>`;
  }
  const after = `data-refresh-after="${escHtml(control.refreshAfter)}"`;
  if (control.secondsLeft <= 0) return `<button ${common} data-lane="web" ${after}>Re-audit</button>`;
  return `<button ${common} data-lane="web" ${after} aria-disabled="true">Re-audit<span class="reaudit__countdown" data-reaudit-countdown aria-hidden="true"> in ${control.secondsLeft} s</span></button>`;
}

export function renderResultSpine(input: SpineInput): string {
  const crumb = input.linked
    ? `<nav class="crumb" aria-label="Breadcrumb"><a href="${escHtml(leaderboardPath({ lane: input.lane }))}">Leaderboard</a><span class="sep" aria-hidden="true">›</span><span>${escHtml(input.target)}</span></nav>\n`
    : '';
  const links = input.linked
    ? `<span class="result-spine__links"><a href="${escHtml(scoreMarkdownPath(input.target))}">Markdown</a> · <a href="${escHtml(scoreJsonPath(input.target))}">JSON</a></span>`
    : '';
  const control = input.control ? renderReauditControl(input.control) : '';
  return `${crumb}<header class="result-spine">
  <h1 class="result-spine__title"><span class="result-spine__target">${escHtml(input.target)}</span> <span class="tier result-spine__lane">${LANE_LABELS[input.lane]}</span></h1>
  <div class="live-score-summary__meta result-spine__meta"><span class="result-spine__tier">${TIER_LABELS[input.tier]}</span><span class="result-spine__freshness">${input.freshnessHtml}</span>${links}${control}</div>
</header>
`;
}

export type BigScoreInput = {
  pct: number;
  label: string;
  secondary: { value: string; label: string } | null;
};

/** The headline numeral with its meter, and the secondary numeral beside it. */
export function renderBigScore(input: BigScoreInput): string {
  const secondary = input.secondary
    ? `\n  <p class="result-score__secondary"><span class="result-score__secondary-n">${escHtml(input.secondary.value)}</span> ${escHtml(input.secondary.label)}</p>`
    : '';
  return `<section class="result-score ${bandOf(input.pct)}" aria-label="Score">
  <div class="bigscore"><span class="bigscore__n">${Math.round(input.pct)}</span><span class="bigscore__l">${escHtml(input.label)}</span></div>
  ${renderMeter(input.pct, { num: null, className: 'result-score__meter' })}${secondary}
</section>
`;
}

/** `YYYY-MM-DD` for a scoring instant, or null when the instant is unknown or unparseable. */
export function shortDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  return Number.isNaN(at) ? null : new Date(at).toISOString().slice(0, 10);
}

export type ResultLinks = { scorecard: string | null; markdown: string | null; json: string | null };

/**
 * The front matter every markdown twin opens with: the page, the twin,
 * the JSON envelope, and the two `Accept` values the bare path honors, so
 * a fetch-only agent finds every representation from the twin alone.
 */
export function resultFrontMatter(input: { target: string; lane: Lane; tier: ResultTier; links: ResultLinks }): string {
  const page = input.links.scorecard;
  const lines = ['---', `target: ${yamlString(input.target)}`, `lane: ${input.lane}`, `tier: ${input.tier}`];
  if (page) lines.push(`scorecard_url: ${yamlString(page)}`);
  if (input.links.markdown) lines.push(`markdown_url: ${yamlString(input.links.markdown)}`);
  if (input.links.json) lines.push(`json_url: ${yamlString(input.links.json)}`);
  if (page) {
    lines.push(
      `negotiate: ${yamlString(`Accept: text/markdown or Accept: application/json on ${page} serve the twin and the JSON`)}`,
    );
  }
  lines.push('---', '');
  return lines.join('\n');
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}
