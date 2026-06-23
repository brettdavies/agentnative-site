// Homepage emit. Section 6 of the build pipeline.
//
// Produces dist/index.html (hero + live-score form + principle listing) and
// the trimmed-to-match dist/index.md twin. The live-scoring form is
// server-rendered as an inert shell; /js/live-score.js wires submit +
// Turnstile + redirect on the client side. The Turnstile sitekey is
// injected by the Worker via meta[name=turnstile-sitekey] — only set on
// staging until full promotion (DESIGN.md §3.4).

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { extractDescription, extractFirstParagraph, extractIntroSummary, extractTitle } from './content.mjs';
import { renderMarkdown } from './render.mjs';
import { emitShell, WEBMCP_SCRIPT } from './shell.mjs';
import { absolutifyMarkdownLinks, escHtml } from './util.mjs';

/**
 * Build the homepage body HTML — hero (lede + use-it), live-scoring form
 * section, principle listing, install-anc CTA. The live-score section
 * sits between hero and principles per the wireframe-first placement;
 * layout polish is deferred to /design-review after the basic surface
 * renders.
 *
 * @param {string} introTitle
 * @param {string} introLede
 * @param {string} useItHtml — pre-rendered <p class="hero__use-it">…</p>
 * @param {Array<{n: number, title: string, shortDesc: string}>} principles
 * @returns {string}
 */
function buildHomepageBody(introTitle, introLede, useItHtml, principles) {
  const entries = principles
    .map((p) => {
      const num = String(p.n).padStart(2, '0');
      const title = escHtml(p.title.replace(/^P\d+:\s*/, ''));
      const desc = escHtml(p.shortDesc);
      return `    <li class="principle-entry">
      <a href="/p${p.n}" class="principle-entry__link">
        <span class="principle-entry__num">${num}</span>
        <span class="principle-entry__title">${title}</span>
        <span class="principle-entry__desc">${desc}</span>
      </a>
    </li>`;
    })
    .join('\n');

  return `<section class="hero">
  <h1 class="hero__title">${escHtml(introTitle)}</h1>
  <p class="hero__lede">${escHtml(introLede)}</p>
  ${useItHtml}
</section>
${buildLiveScoreSection()}
<section class="principles-index" aria-label="The eight principles">
  <ol class="principles-index__list">
${entries}
  </ol>
</section>`;
}

/**
 * Live-scoring paste-input form section. Server-rendered shell: the JS at
 * /js/live-score.js (lazy-loaded with the rest of the deferred client
 * bundle) wires submit + Turnstile + theater. The Turnstile sitekey is
 * injected by the Worker at request time via meta[name=turnstile-sitekey]
 * — only set on staging until full promotion, so production HTML carries
 * an empty value and the JS disables the form with a "not yet live"
 * message.
 *
 * R9 CTA framing: install-anc is the PRIMARY surface, not buried. Visible
 * above the form input so a visitor who never engages the form still sees
 * the local-install option first.
 *
 * @returns {string}
 */
function buildLiveScoreSection() {
  return `<section class="live-score" aria-labelledby="live-score-heading" data-live-score-section>
  <div class="live-score__row">
    <span class="live-score__kicker" aria-hidden="true">Try</span>
    <div class="live-score__content">
      <h2 id="live-score-heading" class="live-score__title">Score a binary, live.</h2>
      <p class="live-score__lede">
        <a href="/install">Install <code>anc</code> locally</a> for source + project depth. The demo here is binary and behavioral audits only.
      </p>
      <form class="live-score__form" method="post" action="/api/score" novalidate data-live-score-form>
        <div class="live-score__input-row">
          <input
            id="live-score-input"
            class="live-score__input"
            name="input"
            type="text"
            autocomplete="off"
            spellcheck="false"
            placeholder="ripgrep"
            required
            aria-label="Tool name, install command, or GitHub URL"
            aria-describedby="live-score-help"
          />
          <button type="submit" class="live-score__submit" data-live-score-submit>Score</button>
        </div>
        <p id="live-score-help" class="live-score__help">
          or try
          <button type="button" class="live-score__chip" data-live-score-example="ripgrep" aria-label="Try example: ripgrep"><code>ripgrep</code></button>,
          <button type="button" class="live-score__chip" data-live-score-example="cargo binstall ouch" aria-label="Try example: cargo binstall ouch"><code>cargo binstall ouch</code></button>,
          <button type="button" class="live-score__chip" data-live-score-example="npm install -g cowsay" aria-label="Try example: npm install -g cowsay"><code>npm install -g cowsay</code></button>,
          <button type="button" class="live-score__chip" data-live-score-example="pip install black" aria-label="Try example: pip install black"><code>pip install black</code></button>,
          <button type="button" class="live-score__chip" data-live-score-example="uv tool install rclone" aria-label="Try example: uv tool install rclone"><code>uv tool install rclone</code></button>,
          or
          <button type="button" class="live-score__chip" data-live-score-example="https://github.com/cli/cli" aria-label="Try example: github.com/cli/cli"><code>github.com/cli/cli</code></button>.
        </p>
        <p class="live-score__status" data-live-score-status role="status" aria-live="polite" hidden></p>
      </form>
    </div>
  </div>
</section>`;
}

/**
 * Emit dist/index.html and dist/index.md. The intro is sourced from three
 * single-responsibility sidecars in content/:
 *
 *   _intro.md         — H1 + philosophy lede. Renders as the hero lede;
 *                       sources title / description / summary extractors.
 *   _spec-context.md  — RFC tiers + deep-linking + leaderboard pointers.
 *                       Not rendered on /; concatenated into llms-full.txt
 *                       for agent-facing context.
 *   _use.md           — install/skill/MCP paragraph. Rendered in the hero
 *                       as <p class="hero__use-it">; mirrored in index.md;
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
 * @returns {Promise<{introTitle: string, introSummary: string, introSource: string, specContextSource: string, useSource: string, introLede: string}>}
 */
export async function emitHomepage({ distDir, contentDir, themeInit, principles }) {
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
  const useItHtml = useRendered.replace(/^<p>/, '<p class="hero__use-it">');

  const indexBody = buildHomepageBody(introTitle, introLede, useItHtml, principles);
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
