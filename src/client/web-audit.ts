// Web-audit form client. Posts to /api/audit-web and renders the NDJSON
// stream as each check resolves, then links to the shareable
// /web/<domain> result page. No Turnstile: the route is IP-rate-limited.
//
// Event contract (one JSON object per line):
//   { type: "discovery", mcp_endpoint }
//   { type: "check", id, principle, keyword, status, evidence }
//   { type: "complete",   scorecard, share_url }
//   { type: "incomplete", scorecard, share_url: null }
//   { type: "error", message }
// A cache hit returns a single application/json body { cached, scorecard, share_url }.

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
  | { type: 'complete'; scorecard: { badge?: { score_pct?: number } }; share_url: string }
  | { type: 'incomplete'; scorecard: { badge?: { score_pct?: number } }; share_url: null }
  | { type: 'error'; message: string };

function q<T extends Element>(root: ParentNode, sel: string): T | null {
  return root.querySelector<T>(sel);
}

function init(): void {
  const form = q<HTMLFormElement>(document, '[data-web-audit-form]');
  if (!form) return;
  const input = q<HTMLInputElement>(form, '[data-web-audit-input]');
  const submit = q<HTMLButtonElement>(form, '[data-web-audit-submit]');
  const status = q<HTMLElement>(form, '[data-web-audit-status]');
  const results = q<HTMLElement>(document, '[data-web-audit-results]');
  if (!input || !submit || !status || !results) return;

  for (const chip of form.querySelectorAll<HTMLButtonElement>('[data-web-audit-example]')) {
    chip.addEventListener('click', () => {
      input.value = chip.dataset.webAuditExample ?? '';
      input.focus();
    });
  }

  const setStatus = (text: string): void => {
    status.textContent = text;
    status.hidden = text.length === 0;
  };

  const rowFor = (id: string): HTMLElement => {
    let row = q<HTMLElement>(results, `[data-check="${CSS.escape(id)}"]`);
    if (!row) {
      row = document.createElement('tr');
      row.setAttribute('data-check', id);
      results.appendChild(row);
    }
    return row;
  };

  // Reuse the scorecard audit-row markup so the streaming rows share the
  // site's existing .audit / .audit-table styles (no bespoke CSS).
  const renderCheck = (ev: CheckEvent): void => {
    const row = rowFor(ev.id);
    row.className = `audit audit--${ev.status}`;
    row.innerHTML = `<td class="audit__status">${ev.status.toUpperCase()}</td><td class="audit__label">${ev.principle} · ${escapeText(ev.id)}</td><td class="audit__evidence">${escapeText(ev.evidence ?? '')}</td>`;
  };

  const finish = (shareUrl: string | null, pct: number | undefined, complete: boolean): void => {
    if (complete && shareUrl) {
      setStatus(`Done — scored ${pct ?? 0}%. Opening the shareable result…`);
      window.location.href = shareUrl;
    } else {
      setStatus('The audit ran out of time before finishing. Nothing was saved — try again.');
    }
    submit.disabled = false;
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
      finish(ev.share_url, ev.scorecard?.badge?.score_pct, true);
    } else if (ev.type === 'incomplete') {
      finish(null, ev.scorecard?.badge?.score_pct, false);
    } else if (ev.type === 'error') {
      setStatus(`Audit error: ${ev.message}`);
      submit.disabled = false;
    }
  };

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const url = input.value.trim();
    if (!url) return;
    submit.disabled = true;
    results.replaceChildren();
    setStatus('Starting audit…');

    let resp: Response;
    try {
      resp = await fetch('/api/audit-web', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/x-ndjson' },
        body: JSON.stringify({ url }),
      });
    } catch {
      setStatus('Network error — could not reach the audit service.');
      submit.disabled = false;
      return;
    }

    if (resp.status === 503) {
      setStatus('The web audit is currently disabled by the operator. Try again later.');
      submit.disabled = false;
      return;
    }

    const contentType = resp.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      const body = (await resp.json()) as {
        cached?: boolean;
        scorecard?: { badge?: { score_pct?: number } };
        share_url?: string;
        error?: string;
        message?: string;
      };
      if (!resp.ok || body.error) {
        setStatus(body.message ?? body.error ?? 'The audit could not run.');
        submit.disabled = false;
        return;
      }
      finish(body.share_url ?? null, body.scorecard?.badge?.score_pct, true);
      return;
    }

    if (!resp.body) {
      setStatus('The audit service returned no stream.');
      submit.disabled = false;
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
            // skip a partial/garbled line; the stream self-terminates.
          }
        }
        nl = buffer.indexOf('\n');
      }
    }
  });
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
