// Homepage emit. Section 6 of the build pipeline.
//
// Produces dist/index.html (instrument hero + CLI ⇆ Web board section +
// principles/checks spec index) and the trimmed-to-match dist/index.md twin.
//
// The CLI ⇆ Web toggle is CSS-first: hidden radios + `:has()` swap the
// board, the spec index, and the try-form together with zero JS (CLI is
// the no-JS default). Board rows are threaded in from the already-computed
// leaderboard + web entries — build.mjs computes both before this stage.
//
// The live-scoring form is server-rendered as an inert shell; /js/live-score.js
// wires submit + Turnstile + redirect on the client side. The Turnstile
// sitekey is injected by the Worker via meta[name=turnstile-sitekey] — only
// set on staging until full promotion (DESIGN.md §3.4).

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bandOf, principleTier, renderMeter } from '../shared/scorecard-format.mjs';
import { extractDescription, extractFirstParagraph, extractIntroSummary, extractTitle } from './content.mjs';
import { renderMarkdown } from './render.mjs';
import { emitShell, WEBMCP_SCRIPT } from './shell.mjs';
import { absolutifyMarkdownLinks, escHtml } from './util.mjs';
import { rankWebEntries } from './web-leaderboard-render.mjs';

const BOARD_ROWS = 5;

// The five web-audit display categories (ids + names mirror
// src/data/web-audit/registry.yaml `categories`; tier + description are
// homepage display copy). The web surface is an audit against external
// specs — anc does not own these standards (R10).
const WEB_CHECKS = [
  {
    id: 'C1',
    title: 'Discoverability',
    tier: 'MUST',
    desc: '<code>robots.txt</code>, <code>sitemap.xml</code>, Link headers, DNS-AID under <code>_agents</code>.',
  },
  {
    id: 'C2',
    title: 'Content for agents',
    tier: 'MUST',
    desc: '<code>llms.txt</code>, <code>Accept: text/markdown</code>, JSON-LD, semantic landmarks.',
  },
  {
    id: 'C3',
    title: 'Bot &amp; crawl policy',
    tier: 'SHOULD',
    desc: 'AI-crawler rules, Content-Signal, <code>security.txt</code>, Web Bot Auth.',
  },
  {
    id: 'C4',
    title: 'MCP &amp; API',
    tier: 'MUST',
    desc: 'Initialize handshake, <code>tools/list</code>, error codes, <code>.well-known</code> card, OpenAPI.',
  },
  {
    id: 'C5',
    title: 'Agent discovery &amp; auth',
    tier: 'MAY',
    desc: 'A2A agent card, agent-skills index, OAuth discovery, <code>auth.md</code>.',
  },
];

/** Decorate the hero H1: keep "agent-native" unbreakable, accent the last word. */
function decorateTitle(title) {
  const escaped = escHtml(title);
  return escaped
    .replace(/(\S+)\s*$/, '<span class="accent">$1</span>')
    .replace(/agent-native/, '<span class="nowrap">agent-native</span>');
}

/** Hero proof panel — real scorecard data for the top leaderboard tool. */
function buildHeroCard(top, principles) {
  const name = escHtml(top.tool.name);
  const pct = top.scorecard.badge.score_pct;
  const band = bandOf(pct);
  const { met, total, details } = top.principleScore;
  const principleBand = bandOf((met / total) * 100);

  const crowStatus = { pass: 'pass', partial: 'warn', fail: 'fail', skip: 'warn' };
  // Three proof rows: the first two principles plus the first non-passing
  // one (falls back to the third) so the card shows honest texture, not a
  // wall of "pass".
  const firstNonPass = details.findIndex((d) => d.status !== 'pass');
  const rowIdx = [...new Set([0, 1, firstNonPass === -1 ? 2 : firstNonPass])].slice(0, 3);
  const crows = rowIdx
    .map((i) => {
      const d = details[i];
      const st = crowStatus[d.status] ?? 'warn';
      const title = principles[i] ? escHtml(principles[i].title.replace(/^P\d+:\s*/, '')) : escHtml(d.group);
      return `      <div class="crow"><span class="id">P${i + 1}</span> ${title} <span class="st ${st}">${st}</span></div>`;
    })
    .join('\n');

  return `    <aside class="card ${band}" aria-label="Scorecard for ${name}">
      <div class="card__bar"><span aria-hidden="true">●●●</span><span class="card__bar-right">anc · scorecard</span></div>
      <div class="card__cmd"><span class="p">$</span> anc audit ${name} --json</div>
      <div class="card__scores">
        <div class="bigscore ${band}"><span class="bigscore__n">${pct}</span><span class="bigscore__l">score</span>${renderMeter(pct, { num: null })}</div>
        <div class="bigscore ${principleBand}"><span class="bigscore__n">${met}/${total}</span><span class="bigscore__l">principles met</span>${renderMeter((met / total) * 100, { num: null })}</div>
      </div>
      <div class="card__rows">
${crows}
      </div>
    </aside>`;
}

/** Compact board rows — top N entries, each row a link to its result page. */
function buildCliBoardRows(leaderboard) {
  return leaderboard
    .slice(0, BOARD_ROWS)
    .map((entry) => {
      const pct = entry.scorecard.badge.score_pct;
      const name = escHtml(entry.tool.name);
      const desc = escHtml(entry.tool.description ?? '');
      return `        <a class="lrow ${bandOf(pct)}" href="/score/${name}"><span class="rank">${String(entry.rank).padStart(2, '0')}</span><span class="name">${name} <span class="name-sub">${desc}</span></span>${renderMeter(pct)}</a>`;
    })
    .join('\n');
}

function buildWebBoardRows(webEntries) {
  return rankWebEntries(webEntries)
    .slice(0, BOARD_ROWS)
    .map((entry) => {
      const pct = entry.scores.global;
      const domain = escHtml(entry.domain);
      const desc = escHtml(entry.description || entry.name);
      return `        <a class="lrow ${bandOf(pct)}" href="/web/${domain}"><span class="rank">${String(entry.rank).padStart(2, '0')}</span><span class="name">${domain} <span class="name-sub">${desc}</span></span>${renderMeter(pct)}</a>`;
    })
    .join('\n');
}

function buildSpecRows(principles) {
  return principles
    .map((p) => {
      const tier = principleTier(p.n);
      const title = escHtml(p.title.replace(/^P\d+:\s*/, ''));
      const desc = escHtml(p.shortDesc);
      return `      <li class="spec__row tier-${tier.toLowerCase()}"><span class="spec__id">P${p.n}</span><div class="spec__body"><div class="spec__head"><a class="spec__title" href="/p${p.n}">${title}</a><span class="tier">${tier}</span></div><p class="spec__desc">${desc}</p></div></li>`;
    })
    .join('\n');
}

function buildWebCheckRows() {
  return WEB_CHECKS.map(
    (c) =>
      `      <li class="spec__row tier-${c.tier.toLowerCase()}"><span class="spec__id">${c.id}</span><div class="spec__body"><div class="spec__head"><a class="spec__title" href="/web-audit">${c.title}</a><span class="tier">${c.tier}</span></div><p class="spec__desc">${c.desc}</p></div></li>`,
  ).join('\n');
}

/**
 * Build the homepage body HTML — hero with scorecard proof, the toggle-driven
 * board + try-form section, and the principles/checks spec index.
 *
 * @param {string} introTitle
 * @param {string} introLede
 * @param {string} useItHtml — pre-rendered <p class="use-note">…</p>
 * @param {Array<{n: number, title: string, shortDesc: string}>} principles
 * @param {Array} leaderboard — from computeLeaderboard()
 * @param {Array} webEntries — from loadWebSeed()
 * @returns {string}
 */
function buildHomepageBody(introTitle, introLede, useItHtml, principles, leaderboard, webEntries) {
  return `<section class="hero">
  <div class="container hero__grid">
    <div>
      <h1 class="hero__title">${decorateTitle(introTitle)}</h1>
      <p class="hero__lede">${escHtml(introLede)}</p>
      <div class="hero__cta">
        <a class="btn btn--primary" href="/install">Install the linter&nbsp;▸</a>
        <a class="btn btn--ghost" href="#board">See the leaderboards</a>
      </div>
    </div>
${buildHeroCard(leaderboard[0], principles)}
  </div>
</section>
<div class="scope">
  <section class="board-section band-surface" id="board" aria-labelledby="board-heading">
    <div class="container">
      <div class="board-head">
        <div>
          <h2 id="board-heading">See where things stand</h2>
          <p data-s="cli">Curated CLIs, ranked by credit-weighted agent-readiness.</p>
          <p data-s="web">Public sites, ranked by global agent-readiness.</p>
        </div>
        <div class="board-controls">
          <div class="seg" role="radiogroup" aria-label="Surface">
            <input type="radio" name="surface" id="s-cli" checked /><label for="s-cli">CLI</label>
            <input type="radio" name="surface" id="s-web" /><label for="s-web">Website</label>
          </div>
          <form class="board-try" data-s="cli" method="post" action="/api/score" novalidate data-live-score-form>
            <input
              id="live-score-input"
              name="input"
              type="text"
              autocomplete="off"
              spellcheck="false"
              placeholder="ripgrep"
              required
              aria-label="Tool name, install command, or GitHub URL"
              aria-describedby="live-score-help"
            />
            <button type="submit" class="btn btn--primary" data-live-score-submit>Score</button>
          </form>
          <form class="board-try" data-s="web" method="get" action="/web-audit">
            <input name="url" type="text" autocomplete="off" spellcheck="false" placeholder="anc.dev" aria-label="Website URL to audit" />
            <button type="submit" class="btn btn--primary">Audit</button>
          </form>
        </div>
      </div>
      <div class="board" data-s="cli" aria-label="Top CLI tools">
${buildCliBoardRows(leaderboard)}
      </div>
      <div class="board" data-s="web" aria-label="Top websites">
${buildWebBoardRows(webEntries)}
      </div>
      <p class="board-rubric" data-s="cli">Scored against the <strong>8 principles</strong>. Run <code>anc audit &lt;tool&gt;</code> locally for source + project depth. <a href="/scorecards">Full board&nbsp;▸</a></p>
      <p class="board-rubric" data-s="web">Scored against the emerging agent-web standards: <code>MCP</code>, <code>llms.txt</code>, <code>OpenAPI</code>, JSON Schema, discovery. anc audits; it doesn't own them. <a href="/web">Full board&nbsp;▸</a></p>
      <p id="live-score-help" class="live-score__help" data-s="cli">
        or try
        <button type="button" class="live-score__chip" data-live-score-example="ripgrep" aria-label="Try example: ripgrep"><code>ripgrep</code></button>,
        <button type="button" class="live-score__chip" data-live-score-example="cargo binstall ouch" aria-label="Try example: cargo binstall ouch"><code>cargo binstall ouch</code></button>,
        <button type="button" class="live-score__chip" data-live-score-example="npm install -g cowsay" aria-label="Try example: npm install -g cowsay"><code>npm install -g cowsay</code></button>,
        <button type="button" class="live-score__chip" data-live-score-example="pip install black" aria-label="Try example: pip install black"><code>pip install black</code></button>,
        <button type="button" class="live-score__chip" data-live-score-example="uv tool install rclone" aria-label="Try example: uv tool install rclone"><code>uv tool install rclone</code></button>,
        or
        <button type="button" class="live-score__chip" data-live-score-example="https://github.com/cli/cli" aria-label="Try example: github.com/cli/cli"><code>github.com/cli/cli</code></button>.
      </p>
      <p class="live-score__status" data-s="cli" data-live-score-status role="status" aria-live="polite" hidden></p>
    </div>
  </section>
  <section class="spec-section" id="principles">
    <div class="container">
      <div data-s="cli">
        <h2>Eight principles for a CLI</h2>
        <p class="sub">The standard anc.dev authors. Each is a testable contract with a MUST / SHOULD / MAY obligation and a named failure mode.</p>
      </div>
      <div data-s="web">
        <h2>Five checks for a website</h2>
        <p class="sub">Not a standard anc owns; an audit of your agent-facing surface against what the ecosystem is converging on.</p>
      </div>
      <ol class="spec" data-s="cli" aria-label="The eight principles">
${buildSpecRows(principles)}
      </ol>
      <ol class="spec" data-s="web" aria-label="The five web checks">
${buildWebCheckRows()}
      </ol>
    </div>
  </section>
</div>
<section class="use-note-section" aria-label="How to use this standard">
  <div class="container">
    ${useItHtml}
  </div>
</section>`;
}

/**
 * Emit dist/index.html and dist/index.md. The intro is sourced from three
 * single-responsibility sidecars in content/:
 *
 *   _intro.md         — H1 + hero subhead + philosophy paragraph. Sources
 *                       title / description / summary extractors.
 *   _spec-context.md  — RFC tiers + deep-linking + leaderboard pointers.
 *                       Not rendered on /; concatenated into llms-full.txt
 *                       for agent-facing context.
 *   _use.md           — install/skill/MCP paragraph. Mirrored in index.md;
 *                       concatenated into llms-full.txt.
 *
 * The three sidecar sources are returned so 09-llms-emit.mjs can
 * concatenate them in reading order without re-reading the filesystem.
 *
 * @param {object} args
 * @param {string} args.distDir
 * @param {string} args.contentDir
 * @param {string} args.themeInit
 * @param {Array<{n: number, title: string, shortDesc: string}>} args.principles
 * @param {Array} args.leaderboard — ranked entries from computeLeaderboard()
 * @param {Array} args.webEntries — loaded seed entries from loadWebSeed()
 * @returns {Promise<{introTitle: string, introSummary: string, introSource: string, specContextSource: string, useSource: string, introLede: string}>}
 */
export async function emitHomepage({ distDir, contentDir, themeInit, principles, leaderboard, webEntries }) {
  if (!Array.isArray(leaderboard) || leaderboard.length === 0) {
    throw new Error('emitHomepage: leaderboard is empty — board data must be computed before the homepage emits');
  }
  if (!Array.isArray(webEntries) || webEntries.length === 0) {
    throw new Error('emitHomepage: webEntries is empty — web seed must be loaded before the homepage emits');
  }
  const [introSource, specContextSource, useSource] = await Promise.all([
    readFile(join(contentDir, '_intro.md'), 'utf8'),
    readFile(join(contentDir, '_spec-context.md'), 'utf8'),
    readFile(join(contentDir, '_use.md'), 'utf8'),
  ]);
  const introTitle = extractTitle(introSource);
  const introSummary = extractIntroSummary(introSource);
  const introDescription = extractDescription(introSource);
  const introLede = extractFirstParagraph(introSource);

  const useRendered = (await renderMarkdown(useSource)).trim();
  // Single-paragraph sidecar: renderMarkdown emits exactly one top-level
  // <p>. Inject the BEM class onto it; any other shape is a content bug.
  if (!useRendered.startsWith('<p>')) {
    throw new Error(`_use.md must render as a single <p>; got: ${useRendered.slice(0, 80)}`);
  }
  const useItHtml = useRendered.replace(/^<p>/, '<p class="use-note">');

  const indexBody = buildHomepageBody(introTitle, introLede, useItHtml, principles, leaderboard, webEntries);
  await writeFile(
    join(distDir, 'index.html'),
    emitShell({
      title: introTitle,
      description: introDescription,
      canonicalPath: '/',
      bodyHtml: indexBody,
      themeInitJs: themeInit,
      isIndex: true,
      // Homepage carries the live-scoring form. /js/live-score.js is
      // bundled in assets.mjs alongside theme/clipboard/leaderboard and
      // loads with `defer`. Lazy-loads Turnstile + handles submit/redirect.
      extraScripts: ['/js/live-score.js', WEBMCP_SCRIPT],
    }),
  );

  // index.md — content-only markdown twin. The live-score form is
  // interactive (button-based chip examples); content extractors and
  // agents fetching the twin need the same examples surfaced as inline
  // code so the homepage contract holds without JavaScript.
  const indexMdLines = [
    `# ${introTitle}`,
    '',
    introLede,
    '',
    useSource.trim(),
    '',
    '## Score a binary, live.',
    '',
    '[Install `anc` locally](/install) for source + project depth. The demo here is binary and behavioral audits only.',
    '',
    'Paste a tool name, install command, or GitHub URL into the homepage form to score it. Examples: `ripgrep`, `cargo binstall ouch`, `npm install -g cowsay`, `pip install black`, `uv tool install rclone`, `github.com/cli/cli`.',
    '',
    '## Principles',
    '',
    ...principles.map((p) => `- [${p.title}](/p${p.n}) — ${p.shortDesc}`),
    '',
  ];
  await writeFile(join(distDir, 'index.md'), absolutifyMarkdownLinks(indexMdLines.join('\n')));

  return { introTitle, introSummary, introSource, specContextSource, useSource, introLede };
}
