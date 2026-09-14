// The one audit entry form, rendered identically on `/` and `/audit`. The
// host wraps it: the homepage puts it in `.board-controls` beside the board,
// `/audit` in `.audit-hero` under the page's heading and lede. The form owns
// no heading of its own.
//
// Without JavaScript the form is a GET to /audit?lane=&target= that only
// prefills the audit page; nothing transacts. With it, /js/audit-entry.js
// takes the submit click: it validates the target for the lane, flips the
// segment when the target's shape belongs to the other lane, acquires the
// Turnstile token on that click, and navigates to the progress page.
//
// The segment radios carry the page-scope ids (`s-cli`, `s-web`), so the one
// control that picks the lane also swaps every `[data-s]` pane on the page
// and restores the visitor's saved surface.

import { auditPath } from '../shared/audit-routes.ts';
import { escHtml } from '../shared/esc-html.ts';

const CLI_EXAMPLES = [
  'ripgrep',
  'cargo binstall ouch',
  'npm install -g cowsay',
  'pip install black',
  'uv tool install rclone',
  'https://github.com/cli/cli',
];

const WEB_EXAMPLES = ['anc.dev', 'modelcontextprotocol.io'];

function chip(example) {
  const label = example.replace(/^https:\/\//, '');
  return `<button type="button" class="live-score__chip" data-audit-example="${escHtml(example)}" aria-label="Try example: ${escHtml(label)}"><code>${escHtml(label)}</code></button>`;
}

function examples(list) {
  return `or try ${list.map(chip).join(', ')}.`;
}

/**
 * The form markup.
 *
 * @param {object} args
 * @param {string} args.idPrefix - scopes the input and help ids to their page
 * @returns {string}
 */
export function renderAuditForm({ idPrefix }) {
  const inputId = `${idPrefix}-target`;
  const helpId = `${idPrefix}-help`;
  return `<form class="audit-form" method="get" action="${auditPath()}" novalidate data-audit-form>
  <div class="seg" role="radiogroup" aria-label="What to audit">
    <input type="radio" name="lane" value="cli" id="s-cli" checked /><label for="s-cli">CLI</label>
    <input type="radio" name="lane" value="web" id="s-web" /><label for="s-web">Website</label>
  </div>
  <div class="board-try audit-form__row">
    <input id="${inputId}" name="target" type="text" autocomplete="off" spellcheck="false" placeholder="ripgrep" data-placeholder-web="anc.dev" required aria-label="A CLI tool, an install command, a GitHub URL, or a website" aria-describedby="${helpId}" data-audit-target />
    <button type="submit" class="btn btn--primary" data-audit-submit>Audit</button>
  </div>
  <label class="audit-hero__optin" data-s="web">
    <input type="checkbox" name="public_listing" value="true" data-audit-listing />
    List this site on the public web leaderboard
  </label>
  <p id="${helpId}" class="live-score__help">
    <span data-s="cli">${examples(CLI_EXAMPLES)}</span>
    <span data-s="web">${examples(WEB_EXAMPLES)}</span>
  </p>
  <p class="live-score__status" data-audit-status role="status" aria-live="polite" hidden></p>
</form>`;
}
