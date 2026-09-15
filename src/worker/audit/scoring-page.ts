// GET /scoring?target=<t>: the one progress page for both lanes. The Worker
// renders the first paint from the target alone; the client
// (/js/scoring.js) owns every state after it: it spends a stashed token,
// probes without one, or waits for the Start click, then renders the stream
// and forwards to the result.
//
//   GET /scoring ................... no target: the prose pointer to the audit page
//   GET /scoring?target=t .......... accepted target: the page for its lane
//                                    refused target: the pointer with the reason (400)
//   GET /scoring.md, or markdown ... the prose pointer naming the read tools
//   any other method ............... 405
//
// The page carries a request-time sitekey and exists for one run, so no
// representation is stored at the edge or indexed. It never loads the
// WebMCP script: a tool that could reach this page could make it transact.

import {
  auditPath,
  classifyTarget,
  isResultTarget,
  type Lane,
  SCORING_PATH,
  scoreMarkdownPath,
} from '../../shared/audit-routes';
import { escHtml } from '../../shared/esc-html';
import { LANE_EXPECTATION, scoringHeadingHtml, scoringTitle, TITLE_SUFFIX } from '../../shared/scoring-copy';
import { detectPreference } from '../accept';
import { loadWebAuditRegistry, type WebAuditRegistryEnv } from '../audit-web/registry';
import { applyHeaders } from '../headers';
import { loadShellTemplate, substituteShell } from '../shell-template';

export type ScoringPageEnv = WebAuditRegistryEnv & { TURNSTILE_SITEKEY?: string };

const SCRIPT_SRC = '/js/scoring.js';

type Accepted = { lane: Lane; target: string };
type Page = { title: string; description: string; body: string };

export async function handleScoringPage(request: Request, env: ScoringPageEnv): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('method not allowed\n', {
      status: 405,
      headers: { Allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    });
  }
  const url = new URL(request.url);
  const raw = url.searchParams.get('target');
  const classified = raw ? classifyTarget(raw) : null;
  // A target the classifier accepts is not always one the result routes can
  // express. Building the saved-result link for one of those throws, so an
  // unroutable target takes the pointer rather than a 500.
  const routable = classified?.ok === true && isResultTarget(classified.target);
  const accepted: Accepted | null =
    classified?.ok && routable ? { lane: classified.lane, target: classified.target } : null;
  const refused =
    classified && !classified.ok
      ? classified.message
      : classified?.ok && !routable
        ? 'That target has no result page. Start the audit from the audit page.'
        : null;

  if (url.pathname.endsWith('.md') || detectPreference(request) === 'markdown') {
    const body = pointerMarkdown(url.origin, accepted, refused);
    // The twin answers a refusal with the status the page gives it: an agent
    // reading 200 here would take a rejection for a result.
    return transient(request, new Response(body, { status: refused ? 400 : 200 }), true);
  }

  let template: string;
  try {
    template = await loadShellTemplate(env);
  } catch (err) {
    return new Response(`shell template unavailable: ${err instanceof Error ? err.message : String(err)}`, {
      status: 500,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    });
  }
  const refresh = url.searchParams.get('refresh') === '1';
  const page = accepted ? await progressPage(env, accepted, refresh) : pointerPage(refused);
  const html = substituteShell(template, {
    title: page.title,
    description: page.description,
    canonicalPath: SCORING_PATH,
    breadcrumb: 'Scoring',
    body: page.body,
  });
  const status = refused ? 400 : 200;
  return transient(
    request,
    new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8' } }),
    false,
  );
}

function transient(request: Request, response: Response, servedMarkdown: boolean): Response {
  const headed = applyHeaders(response, { request, servedMarkdown, pathname: SCORING_PATH });
  headed.headers.set('Cache-Control', 'no-store');
  headed.headers.set('Cloudflare-CDN-Cache-Control', 'no-store');
  headed.headers.set('X-Robots-Tag', 'noindex');
  headed.headers.delete('Cache-Tag');
  return headed;
}

// The website lane's status line reads "N of M checks"; M is the registry's
// check count, and a registry that fails to load drops it to "N checks".
async function checkTotal(env: ScoringPageEnv): Promise<number | null> {
  try {
    return (await loadWebAuditRegistry(env)).checks.length;
  } catch {
    return null;
  }
}

async function progressPage(env: ScoringPageEnv, accepted: Accepted, refresh: boolean): Promise<Page> {
  const { lane, target } = accepted;
  const t = escHtml(target);
  const total = lane === 'web' ? await checkTotal(env) : null;
  const attrs = [
    'data-scoring',
    `data-target="${t}"`,
    `data-lane="${lane}"`,
    refresh ? 'data-refresh="1"' : '',
    total ? `data-check-total="${total}"` : '',
  ]
    .filter(Boolean)
    .join(' ');
  const saved = escHtml(scoreMarkdownPath(target));
  const readTool = lane === 'cli' ? 'get_scorecard' : 'get_website_audit';
  const body = `<article class="container scorecard-page scoring" ${attrs}>
  <meta name="turnstile-sitekey" content="${escHtml(env.TURNSTILE_SITEKEY ?? '')}" />
  <header class="scorecard-header">
    <h1 tabindex="-1" data-scoring-heading>${scoringHeadingHtml('running', target, lane)}</h1>
    <p class="live-score-summary__meta" data-scoring-subline>${escHtml(LANE_EXPECTATION[lane])}</p>
  </header>
  <p class="live-score__status" data-scoring-status role="status" aria-live="polite">Checking for a recent result&hellip;</p>
  <div class="scoring__body" data-scoring-body></div>
  <div class="scoring__actions" data-scoring-actions>
    <button type="button" class="btn btn--primary" data-scoring-start hidden>Start</button>
    <span class="scoring__countdown" data-scoring-countdown aria-hidden="true"></span>
    <a class="btn btn--ghost" href="${auditPath()}" data-scoring-other hidden>Audit something else</a>
  </div>
  <noscript>
    <p>This page runs a live audit with JavaScript. Without it, read the saved result at <a href="${saved}">${saved}</a>, or call the <code>${readTool}</code> MCP tool at <a href="/mcp">/mcp</a>.</p>
  </noscript>
  <script defer src="${SCRIPT_SRC}"></script>
</article>`;
  const kind = lane === 'cli' ? 'CLI' : 'website';
  return { title: scoringTitle('running', target), description: `The live ${kind} audit of ${target}.`, body };
}

function pointerPage(refused: string | null): Page {
  const reason = refused
    ? `\n  <p class="live-score__status live-score__status--error" role="alert">${escHtml(refused)}</p>`
    : '';
  return {
    title: `Audit progress${TITLE_SUFFIX}`,
    description: 'The progress page for an audit started from the audit page.',
    body: `<article class="container scorecard-page">
  <header class="scorecard-header">
    <h1>Audit progress</h1>
    <p class="live-score-summary__meta">This page follows an audit started from the audit page.</p>
  </header>${reason}
  <p><a class="btn btn--primary" href="${auditPath()}">Audit a CLI tool or a website</a></p>
</article>`,
  };
}

function pointerMarkdown(origin: string, accepted: Accepted | null, refused: string | null): string {
  const audit = `${origin}${auditPath()}`;
  const lines = [
    '# Audit progress',
    '',
    `This page follows a live audit in a browser and has no content of its own for an agent. Start an audit at [${audit}](${audit}).`,
    '',
  ];
  if (refused) lines.push(refused, '');
  if (accepted) {
    const saved = `${origin}${scoreMarkdownPath(accepted.target)}`;
    lines.push(`The saved result for \`${accepted.target}\`, once the audit finishes, is at [${saved}](${saved}).`, '');
  }
  lines.push(
    `From an agent, read results with the \`get_scorecard\` (CLI tools) or \`get_website_audit\` (websites) MCP tool at \`${origin}/mcp\`.`,
    '',
  );
  return lines.join('\n');
}
