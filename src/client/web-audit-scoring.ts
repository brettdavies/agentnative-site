// In-progress web-audit page (/web/scoring/<domain>). Reads the domain from
// the URL, acquires a Turnstile token on load, POSTs to /api/audit-web,
// streams the per-check rows, and forwards to /web/<domain> with
// location.replace() when the audit completes (or on a cache hit). The
// scoring page never enters history, so the browser back button returns to
// the form. Non-happy terminal states render a status message with a retry
// link and never redirect — /web/<domain> would 404 on an incomplete run.
//
// Event contract (one JSON object per NDJSON line):
//   { type: "discovery", mcp_endpoint }
//   { type: "check", id, principle, keyword, status, evidence }
//   { type: "complete",   scorecard, share_url }
//   { type: "incomplete", scorecard, share_url: null }
//   { type: "error", message }
// A cache hit returns a single application/json body { cached, scorecard, share_url }.

import { getTurnstileToken, readSitekey, takeTurnstileToken } from './turnstile';

interface CheckEvent {
  type: 'check';
  id: string;
  principle: string;
  keyword: string;
  status: string;
  evidence: string;
}
type StreamEvent =
  | { type: 'discovery'; mcp_endpoint: string | null }
  | CheckEvent
  | { type: 'complete'; scorecard: { score_pct?: number }; share_url: string }
  | { type: 'incomplete'; scorecard: { score_pct?: number }; share_url: null }
  | { type: 'error'; message: string };

function q<T extends Element>(root: ParentNode, sel: string): T | null {
  return root.querySelector<T>(sel);
}

/** The audited host lives in the path: /web/scoring/<host>. */
function hostFromPath(): string | null {
  const m = window.location.pathname.match(/^\/web\/scoring\/([^/]+)$/);
  return m ? m[1] : null;
}

function init(): void {
  const scope = q<HTMLElement>(document, '[data-web-audit-scoring]');
  if (!scope) return;
  const status = q<HTMLElement>(scope, '[data-web-audit-status]');
  const results = q<HTMLElement>(scope, '[data-web-audit-results]');
  const retry = q<HTMLElement>(scope, '[data-web-audit-retry]');
  const host = hostFromPath();
  if (!status || !results || !host) return;

  const setStatus = (text: string): void => {
    status.textContent = text;
  };
  const showRetry = (): void => {
    if (retry) retry.hidden = false;
  };

  const sitekey = readSitekey();
  if (!sitekey) {
    // Unprovisioned env (production pre-promotion): no widget to render.
    // Point at the surfaces that work without the browser flow.
    setStatus(
      'Live web scoring is available on staging only. Fetch the saved result at /web/' +
        host +
        '.md, or run the audit_website MCP tool.',
    );
    showRetry();
    return;
  }

  const rowFor = (id: string): HTMLElement => {
    let row = q<HTMLElement>(results, `[data-check="${CSS.escape(id)}"]`);
    if (!row) {
      row = document.createElement('tr');
      row.setAttribute('data-check', id);
      results.appendChild(row);
    }
    return row;
  };

  const renderCheck = (ev: CheckEvent): void => {
    const row = rowFor(ev.id);
    row.className = `audit audit--${ev.status}`;
    row.innerHTML = `<td class="audit__status">${ev.status.toUpperCase()}</td><td class="audit__label">${ev.principle} · ${escapeText(ev.id)}</td><td class="audit__evidence">${escapeText(ev.evidence ?? '')}</td>`;
  };

  const forward = (shareUrl: string): void => {
    // location.replace so the scoring page never enters history: the back
    // button from the result page lands on the form, not here.
    window.location.replace(shareUrl);
  };

  const handleEvent = (ev: StreamEvent): void => {
    if (ev.type === 'discovery') {
      setStatus(
        ev.mcp_endpoint
          ? `MCP endpoint found at ${ev.mcp_endpoint}. Running checks…`
          : 'No MCP endpoint found. Running checks…',
      );
    } else if (ev.type === 'check') {
      renderCheck(ev);
    } else if (ev.type === 'complete') {
      setStatus(`Done — scored ${ev.scorecard?.score_pct ?? 0}%. Opening the saved result…`);
      forward(ev.share_url);
    } else if (ev.type === 'incomplete') {
      setStatus('The audit ran out of time before finishing. Nothing was saved — try again.');
      showRetry();
    } else if (ev.type === 'error') {
      setStatus(`Audit error: ${ev.message}`);
      showRetry();
    }
  };

  const renderErrorResponse = (
    statusCode: number,
    body: { error?: string; message?: string; retry_after?: number },
  ): void => {
    if (statusCode === 503) {
      setStatus('The web audit is currently disabled by the operator. Try again later.');
    } else if (body.error === 'turnstile_failed') {
      setStatus('Verification failed. Try again.');
    } else if (body.error === 'rate_limit') {
      const retryAfter = body.retry_after ?? 60;
      setStatus(`Too many audits right now. Try again in ${retryAfter}s.`);
    } else if (body.error === 'service_misconfigured') {
      setStatus('Live scoring is misconfigured on our side. Run the audit_website MCP tool for now.');
    } else {
      setStatus(body.message ?? body.error ?? 'The audit could not run. Try again.');
    }
    showRetry();
  };

  void run({ host, sitekey, scope, setStatus, handleEvent, renderErrorResponse });
}

interface RunArgs {
  host: string;
  sitekey: string;
  scope: HTMLElement;
  setStatus: (text: string) => void;
  handleEvent: (ev: StreamEvent) => void;
  renderErrorResponse: (statusCode: number, body: { error?: string; message?: string; retry_after?: number }) => void;
}

async function run(args: RunArgs): Promise<void> {
  const { host, sitekey, scope, setStatus, handleEvent, renderErrorResponse } = args;
  const url = `https://${host}/`;

  // Prefer the token the form acquired on the submit gesture; fall back to a
  // fresh on-load acquire for direct or shared /web/scoring links (no gesture,
  // so invisible Turnstile clears less reliably there).
  let token: string;
  const carried = takeTurnstileToken(host);
  if (carried) {
    token = carried;
  } else {
    try {
      token = await getTurnstileToken(sitekey, scope);
    } catch {
      setStatus('Verification challenge failed to load. Reload to try again.');
      return;
    }
  }

  let resp: Response;
  try {
    resp = await fetch('/api/audit-web', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/x-ndjson' },
      body: JSON.stringify({ url, turnstile_token: token }),
    });
  } catch {
    setStatus('Network error — could not reach the audit service.');
    return;
  }

  const contentType = resp.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    const body = (await resp.json().catch(() => ({}))) as {
      cached?: boolean;
      scorecard?: { score_pct?: number };
      share_url?: string;
      error?: string;
      message?: string;
      retry_after?: number;
    };
    if (!resp.ok || body.error || !body.share_url) {
      renderErrorResponse(resp.status, body);
      return;
    }
    // Cache hit: forward immediately, also via replace().
    window.location.replace(body.share_url);
    return;
  }

  if (!resp.body) {
    setStatus('The audit service returned no stream.');
    return;
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl = buffer.indexOf('\n');
    while (nl !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line.length > 0) {
        try {
          handleEvent(JSON.parse(line) as StreamEvent);
        } catch {
          // Skip a partial/garbled line; the stream self-terminates.
        }
      }
      nl = buffer.indexOf('\n');
    }
  }
}

function escapeText(s: string): string {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
