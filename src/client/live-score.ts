// Homepage live-scoring form — paste-input, lazy-loaded Turnstile, 2 s
// theater floor, redirect on success.
//
// Behavior contract:
//   - Turnstile script (https://challenges.cloudflare.com/turnstile/v0/api.js)
//     is NOT loaded on every homepage visit. Lazy-load on first focus/click/
//     paste against the form input. A Playwright regression asserts the
//     script is NOT requested when the user scrolls past without engaging.
//   - On submit: render the invisible Turnstile widget, await token, POST
//     to /api/score with {input, turnstile_token}. Promise.all with a 2 s
//     timer enforces the cached-theater minimum from
//     docs/solutions/architecture-patterns/cached-theater-live-fallback-2026-04-17.md.
//   - Response branches:
//       kind=='registry_hit'  → window.location = scorecard_url
//       inline scorecard      → window.location = share_url (/score/live/<binary>)
//       4xx with chain_*       → render class-specific bounce panel
//       other errors          → inline error message
//
// Turnstile sitekey comes from <meta name="turnstile-sitekey" content="...">,
// substituted at request time by the Worker. Production pre-promotion ships
// empty content — the form disables itself with a "not yet live" notice
// rather than rendering a non-functional widget.

interface TurnstileApi {
  render(
    element: HTMLElement | string,
    options: {
      sitekey: string;
      size?: 'invisible' | 'normal' | 'compact';
      callback?: (token: string) => void;
      'error-callback'?: () => void;
      'expired-callback'?: () => void;
    },
  ): string;
  execute(widgetId?: string): void;
  reset(widgetId?: string): void;
  remove(widgetId?: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const TURNSTILE_SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
const THEATER_MIN_MS = 2000;
const STDERR_TRUNCATE_CHARS = 300;

const form = document.querySelector<HTMLFormElement>('[data-live-score-form]');
const input = document.querySelector<HTMLInputElement>('#live-score-input');
const submitBtn = document.querySelector<HTMLButtonElement>('[data-live-score-submit]');
const statusEl = document.querySelector<HTMLParagraphElement>('[data-live-score-status]');

if (form && input && submitBtn && statusEl) {
  initLiveScore({ form, input, submitBtn, statusEl });
}

function initLiveScore(els: {
  form: HTMLFormElement;
  input: HTMLInputElement;
  submitBtn: HTMLButtonElement;
  statusEl: HTMLParagraphElement;
}): void {
  const sitekey = readSitekey();
  if (!sitekey) {
    // Production pre-promotion path: TURNSTILE_SITEKEY var is not set.
    // Disable the form so a click can't dispatch a request that will
    // fail siteverify with no actionable error.
    disableFormWithMessage(els, 'Live scoring is available on staging only — install anc locally to score.');
    return;
  }

  let turnstilePromise: Promise<TurnstileApi> | null = null;
  let widgetId: string | null = null;

  function ensureTurnstileLoaded(): Promise<TurnstileApi> {
    if (turnstilePromise) return turnstilePromise;
    turnstilePromise = new Promise<TurnstileApi>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = TURNSTILE_SCRIPT_URL;
      script.async = true;
      script.defer = true;
      script.onload = () => {
        if (window.turnstile) resolve(window.turnstile);
        else reject(new Error('Turnstile failed to attach to window'));
      };
      script.onerror = () => reject(new Error('Turnstile script failed to load'));
      document.head.appendChild(script);
    }).catch((err) => {
      // Reset on failure so the next interaction retries — common cause
      // is a transient network blip on first paint.
      turnstilePromise = null;
      throw err;
    });
    return turnstilePromise;
  }

  // Lazy-load: first interaction wins. Once the script is in-flight we
  // don't re-add it on subsequent events.
  const lazyLoad = () => {
    void ensureTurnstileLoaded();
  };
  els.input.addEventListener('focus', lazyLoad, { once: true });
  els.input.addEventListener('paste', lazyLoad, { once: true });
  els.input.addEventListener('click', lazyLoad, { once: true });

  // bfcache restore: when the user browser-backs from /score/live/<binary>
  // (or any successor page) into this homepage, the browser may restore
  // the page from the back-forward cache with the form still in its
  // submitting state — input + button disabled, status slot showing the
  // curated-reward or phase-progression text from the previous submit.
  // Reset to a clean state so the form is immediately usable again.
  // Standard a11y pattern, no copy change needed.
  window.addEventListener('pageshow', (event) => {
    if (!event.persisted) return;
    setSubmitting(els, false);
    clearStatus(els.statusEl);
  });

  // Example chips fill the input + trigger the lazy-load (since the user
  // is clearly engaging with the form). Mirrors the paste interaction.
  for (const chip of document.querySelectorAll<HTMLButtonElement>('[data-live-score-example]')) {
    chip.addEventListener('click', () => {
      const value = chip.dataset.liveScoreExample ?? '';
      els.input.value = value;
      els.input.focus();
      lazyLoad();
    });
  }

  els.form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const value = els.input.value.trim();
    if (!value) {
      renderInlineError(els.statusEl, 'Paste a tool name, install command, or GitHub URL.');
      return;
    }

    setSubmitting(els, true);
    renderStatus(els.statusEl, 'Queued…');

    let token: string;
    try {
      token = await acquireTurnstileToken(sitekey, await ensureTurnstileLoaded(), els.form, (id) => {
        widgetId = id;
      });
    } catch {
      setSubmitting(els, false);
      renderInlineError(els.statusEl, 'Verification challenge failed to load. Please try again.');
      return;
    }

    // Phase progression: while we wait for /api/score, the status line
    // cycles through realistic prose phases. Timings approximate real
    // sandbox runs — too long is misleading, too short reads as frantic.
    // The cycle is cancelled the moment the response arrives so the user
    // never sees an obviously-stale phase after the work is done.
    const phaseTimer = startPhaseProgression(els.statusEl);
    const start = Date.now();

    let response: Response;
    let payload: Record<string, unknown>;
    try {
      response = await fetch('/api/score', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input: value, turnstile_token: token }),
      });
      payload = await response.json().catch(() => ({}) as Record<string, unknown>);
    } catch (err) {
      phaseTimer.cancel();
      setSubmitting(els, false);
      renderInlineError(els.statusEl, networkErrorMessage(err));
      return;
    } finally {
      if (widgetId && window.turnstile) {
        window.turnstile.reset(widgetId);
      }
    }

    phaseTimer.cancel();

    // Curated-hit reward: when /api/score short-circuits via the registry-
    // fast-path (slug, install-command-with-curated-binary, or github-url
    // matching a curated owner/repo), surface a small "you found one of
    // ours" moment before the redirect. The reward shows for the
    // remainder of the 2 s theater floor — long enough to read, not long
    // enough to annoy. score_pct is enriched into the registry-index at
    // build time (build.mjs + registry-index.mjs), so this needs no
    // second round-trip.
    const sc = payload.scorecard as { kind?: string; scorecard_url?: string; score_pct?: number | null } | undefined;
    if (response.status === 200 && sc?.kind === 'registry_hit' && typeof sc.scorecard_url === 'string') {
      const reward =
        typeof sc.score_pct === 'number'
          ? `Curated · ${sc.score_pct}% pass rate · opening the audited scorecard…`
          : 'Curated · opening the audited scorecard…';
      renderCuratedReward(els.statusEl, reward);
      const elapsed = Date.now() - start;
      const remaining = Math.max(0, THEATER_MIN_MS - elapsed);
      window.setTimeout(() => {
        window.location.href = sc.scorecard_url as string;
      }, remaining);
      return;
    }

    // All other branches (inline scorecard, error, bounce) flow through
    // the existing handler. Honor the theater floor first so a fast
    // cached response doesn't snap the user through before they've
    // registered that anything happened.
    const elapsed = Date.now() - start;
    const remaining = Math.max(0, THEATER_MIN_MS - elapsed);
    if (remaining > 0) await new Promise((r) => window.setTimeout(r, remaining));
    setSubmitting(els, false);
    handleScoreResponse(els, response.status, payload);
  });
}

function readSitekey(): string | null {
  const meta = document.querySelector<HTMLMetaElement>('meta[name=turnstile-sitekey]');
  const value = meta?.content?.trim();
  // Empty string (production pre-promotion) is treated as absent, so the
  // form short-circuits to the local-install copy without a network round-trip.
  return value ? value : null;
}

// Module-scope state for the Turnstile widget. The widget is rendered
// exactly once per page session; subsequent acquires reset and re-execute
// the existing widget rather than rendering again. Re-rendering on the
// same container while a prior execution is still settling triggers
// Turnstile's "Call to execute() on a widget that is already executing"
// warning and a 400020 from challenges.cloudflare.com on the second
// submit. The Turnstile callback is fixed at render time, so the pending
// resolver/rejector is swapped here per acquire.
let turnstileWidget: { id: string; container: HTMLDivElement } | null = null;
let pendingTurnstile: { resolve: (token: string) => void; reject: (err: Error) => void } | null = null;

function settleTurnstile(result: { token: string } | { error: Error }): void {
  const p = pendingTurnstile;
  pendingTurnstile = null;
  if (!p) return;
  if ('token' in result) p.resolve(result.token);
  else p.reject(result.error);
}

function acquireTurnstileToken(
  sitekey: string,
  api: TurnstileApi,
  formEl: HTMLFormElement,
  onWidget: (id: string) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    // Defense-in-depth: if a prior acquire is still pending (submit-button
    // disable should have prevented this) reject the new caller rather
    // than dropping the prior resolver on the floor.
    if (pendingTurnstile) {
      reject(new Error('turnstile_already_pending'));
      return;
    }
    pendingTurnstile = { resolve, reject };

    if (turnstileWidget) {
      api.reset(turnstileWidget.id);
      onWidget(turnstileWidget.id);
      api.execute(turnstileWidget.id);
      return;
    }

    let container = formEl.querySelector<HTMLDivElement>('[data-turnstile-mount]');
    if (!container) {
      container = document.createElement('div');
      container.setAttribute('data-turnstile-mount', '');
      container.style.cssText = 'position:absolute;left:-9999px;width:0;height:0;overflow:hidden';
      formEl.appendChild(container);
    }
    const id = api.render(container, {
      sitekey,
      size: 'invisible',
      callback: (token: string) => settleTurnstile({ token }),
      'error-callback': () => settleTurnstile({ error: new Error('turnstile_error') }),
      'expired-callback': () => settleTurnstile({ error: new Error('turnstile_expired') }),
    });
    turnstileWidget = { id, container };
    onWidget(id);
    api.execute(id);
  });
}

function handleScoreResponse(
  els: { statusEl: HTMLParagraphElement },
  status: number,
  payload: Record<string, unknown>,
): void {
  // Registry hit: the curated /score/<slug> page is the share surface.
  const scorecard = payload.scorecard as { kind?: string; scorecard_url?: string } | undefined;
  if (status === 200 && scorecard?.kind === 'registry_hit' && typeof scorecard.scorecard_url === 'string') {
    window.location.href = scorecard.scorecard_url;
    return;
  }

  // Inline scorecard: redirect to the shareable /live-score/<binary> page.
  if (status === 200 && typeof payload.share_url === 'string') {
    window.location.href = payload.share_url;
    return;
  }

  // 200 but no share_url AND no registry_hit redirect (github-url-without-hint
  // live run). Show a fallback message — the user got a result, but the
  // shareable URL surface isn't available for this input shape.
  if (status === 200) {
    renderInlineError(
      els.statusEl,
      "Scored, but this input doesn't have a shareable result URL yet. Run anc locally for a saved scorecard.",
    );
    return;
  }

  // 4xx / 5xx: branch on error.code for the three bounce panels + the
  // common error tags. Anything else falls through to a generic message.
  const err = payload.error as { code?: string; details?: string; retry_after?: number; pm?: string } | undefined;

  // Issue-1 reclassification: the DO currently returns
  // `chain_resolved_install_failed` even when the package manager couldn't
  // find the package at all (cargo: "X is not found"; brew: "No available
  // formula"; pip: "No matching distribution"). In those cases no install
  // path was ever resolved — the "didn't run" headline is misleading.
  // Detect the pattern in stderr and render a registry-not-found bounce
  // instead. Backend follow-up: the DO classifier should emit
  // `chain_no_resolve` (or a new `chain_resolved_package_not_found`)
  // directly so the client doesn't have to second-guess.
  if (err?.code === 'chain_resolved_install_failed' && isPackageNotFoundStderr(err.details)) {
    renderBouncePanel(els.statusEl, {
      headline: "That package isn't in the registry.",
      body: 'The package manager couldn\'t find a package by that name. Check the spelling, or paste a GitHub URL if the project ships releases there. <a href="/install">Install anc locally</a> to score private or unpublished tools.',
      details: truncateStderr(err.details),
    });
    return;
  }

  switch (err?.code) {
    case 'chain_no_resolve':
      renderBouncePanel(els.statusEl, {
        headline: "We couldn't find a pre-built binary for that.",
        body: 'anc only scores tools with a published binary release. <a href="/install">Install anc locally</a> to score source + project depth.',
      });
      return;
    case 'github_repo_not_accessible':
      renderBouncePanel(els.statusEl, {
        headline: "GitHub couldn't find that repo.",
        body: 'It may be private, renamed, or never existed. <a href="/install">Install anc locally</a> to score private repos directly — the live sandbox has no GitHub credentials.',
      });
      return;
    case 'chain_resolved_install_failed':
      renderBouncePanel(els.statusEl, {
        headline: "Found an install path, but it didn't run.",
        body: 'The install command returned a non-zero exit. <a href="/install">Install anc locally</a> for more flexible install options.',
        details: truncateStderr(err?.details),
      });
      return;
    case 'chain_resolved_no_binary_produced':
      // Two distinct shapes land under this code:
      //   - "Archive contains no binary named ..." — the direct-install
      //     auto-detect filter found zero executable candidates after
      //     stripping docs/manifests. The archive shipped only docs OR
      //     all candidates failed the path/extension guard. Render the
      //     archive-specific bounce so the user can see the file list.
      //   - Otherwise — a registry install succeeded but no entry point
      //     ended up on PATH (pallets/click-class library miss).
      if (isArchiveNoBinaryDetails(err?.details)) {
        renderBouncePanel(els.statusEl, {
          headline: "The archive doesn't contain the binary we expected.",
          body: 'The release ships files but no executable that matches our auto-detector. <a href="/install">Install anc locally</a> to score this tool directly — the auto-detector picks the most-likely binary, but humans pick better.',
          details: truncateStderr(err?.details),
        });
        return;
      }
      renderBouncePanel(els.statusEl, {
        headline: 'That looks like a library, not a CLI.',
        body: 'We installed it, but no command-line entry point appeared on PATH. anc only scores binaries. If this is wrong, paste the actual binary name as <code>&lt;command&gt;</code> to retry. <a href="/install">Install anc locally</a> for full project depth.',
      });
      return;
    case 'install_unsupported':
      renderInstallUnsupportedBounce(els.statusEl, err?.pm);
      return;
    case 'rate_limited': {
      const retry = err?.retry_after ?? 60;
      renderInlineError(els.statusEl, `Too many requests. Try again in ${retry}s.`);
      return;
    }
    case 'turnstile_failed':
      renderInlineError(els.statusEl, 'Verification failed. Please try again.');
      return;
    case 'scoring_disabled':
      renderInlineError(els.statusEl, 'Live scoring is paused. Run anc locally — see the install copy above.');
      return;
    case 'sandbox_stub_until_u6':
      renderInlineError(
        els.statusEl,
        'Live scoring is still rolling out for this input shape. Run anc locally for the full check.',
      );
      return;
    case 'non_github_host':
      renderInlineError(els.statusEl, 'Only public GitHub repos are supported.');
      return;
    case 'discovery_redirect_loop':
      renderInlineError(
        els.statusEl,
        'GitHub redirected us in a loop while resolving releases. Try again, or paste the exact owner/repo URL.',
      );
      return;
    case 'non_https_url':
      renderInlineError(els.statusEl, "Use https://. The scoring sandbox won't fetch http:// URLs.");
      return;
    case 'invalid_url_path':
      renderInlineError(
        els.statusEl,
        'Paste the repo root, not a branch or release link. Example: https://github.com/owner/repo.',
      );
      return;
    case 'unparseable_install_command':
      renderInlineError(
        els.statusEl,
        "That looks like an install command, but the package manager isn't supported. Try cargo, brew, npm, pip, bun, uv, or go.",
      );
      return;
    case 'invalid_url':
    case 'unrecognized_input':
      renderInlineError(els.statusEl, 'That input is not a recognized tool, install command, or GitHub URL.');
      return;
    case 'timeout':
      renderInlineError(els.statusEl, 'The scan ran past the time budget. Run anc locally for unconstrained scoring.');
      return;
    case 'service_misconfigured':
      renderInlineError(
        els.statusEl,
        "Live scoring is misconfigured on our side. We've been notified. Run anc locally for now.",
      );
      return;
    case 'incomplete_response_contract':
      renderInlineError(
        els.statusEl,
        'The scoring service returned an incomplete response. Try again, or run anc locally.',
      );
      return;
    default:
      renderInlineError(els.statusEl, 'Scoring failed. Please try again or run anc locally.');
  }
}

/** Heuristic: does this stderr text indicate "the package manager could
 * not find the package" (as opposed to "found it but install failed")?
 * Patterns cover cargo, brew, pip, npm, pipx, go. Case-insensitive.
 * Kept conservative — a false positive here re-labels a real install
 * failure as a registry miss, which is less honest than the inverse. */
function isPackageNotFoundStderr(details: string | undefined): boolean {
  if (typeof details !== 'string' || details.length === 0) return false;
  const haystack = details.toLowerCase();
  return (
    /\bis not found\b/.test(haystack) ||
    /\bno matching (package|distribution|formula)\b/.test(haystack) ||
    /\bcould not find\b/.test(haystack) ||
    /\bno available formula\b/.test(haystack) ||
    /\bunknown package\b/.test(haystack) ||
    /\bdoes not exist\b/.test(haystack) ||
    /\bnot found in (the )?registry\b/.test(haystack) ||
    /\b404 not found\b/.test(haystack)
  );
}

/** Heuristic: does this stderr text indicate "the archive extracted but
 * contained no recognizable binary"? The direct-install path emits a
 * specific `DETAILS:Archive contains no binary named ...` line when the
 * auto-detect filter finds zero candidates (a release that ships only
 * docs, or whose binary name + filename were both filtered out as
 * non-executable). When this fires we render a more specific bounce
 * panel than the generic install_failed one — the user sees the actual
 * archive listing and understands why a manual hint is needed. */
function isArchiveNoBinaryDetails(details: string | undefined): boolean {
  if (typeof details !== 'string' || details.length === 0) return false;
  return /\bArchive contains no binary named\b/i.test(details);
}

/** install_unsupported variant rendering. pm carries the specific install
 * mechanism the sandbox refused; copy is tailored per pm so the user gets
 * a concrete alternative instead of a generic "try something else". */
function renderInstallUnsupportedBounce(statusEl: HTMLParagraphElement, pm: string | undefined): void {
  switch (pm) {
    case 'brew':
    case 'brew_only':
      renderBouncePanel(statusEl, {
        headline: "Homebrew installs aren't sandboxed yet.",
        body: 'Homebrew isn\'t available in the scoring sandbox. Try a <code>cargo install</code>, <code>pipx install</code>, or <code>npm i -g</code> equivalent, or paste a GitHub URL. <a href="/install">Install anc locally</a> to score brew-only tools.',
      });
      return;
    case 'bun':
      renderBouncePanel(statusEl, {
        headline: "`bun install` isn't sandboxed yet.",
        body: 'The sandbox doesn\'t wire Bun\'s global install path onto PATH. Try an <code>npm i -g</code> or <code>pipx install</code> equivalent, or <a href="/install">install anc locally</a>.',
      });
      return;
    case 'go_no_binary':
      renderBouncePanel(statusEl, {
        headline: "That Go module doesn't expose a CLI binary.",
        body: 'anc only scores tools that produce a command on PATH. Paste a binary-producing package, or <a href="/install">install anc locally</a> to score libraries.',
      });
      return;
    default:
      renderBouncePanel(statusEl, {
        headline: "That install path isn't supported in the sandbox.",
        body: 'Paste a <code>cargo install</code>, <code>pipx install</code>, <code>npm i -g</code>, or GitHub URL instead, or <a href="/install">install anc locally</a>.',
      });
  }
}

function truncateStderr(input: unknown): string | undefined {
  if (typeof input !== 'string' || input.length === 0) return undefined;
  if (input.length <= STDERR_TRUNCATE_CHARS) return input;
  return `${input.slice(0, STDERR_TRUNCATE_CHARS)}… (truncated)`;
}

function renderBouncePanel(
  statusEl: HTMLParagraphElement,
  panel: { headline: string; body: string; details?: string },
): void {
  statusEl.hidden = false;
  statusEl.classList.add('live-score__status--bounce');
  statusEl.classList.remove('live-score__status--error');
  const detailsBlock = panel.details
    ? `<pre class="live-score__bounce-stderr"><code>${escapeHtml(panel.details)}</code></pre>`
    : '';
  // panel.body is template-literal HTML controlled by THIS module — no
  // user input flows into it. The headline is escaped (it's a fixed string
  // per the closed-set bounce error codes). Stderr details are escapeHtml'd
  // before rendering inside <code>.
  statusEl.innerHTML = `
    <span class="live-score__bounce-headline">${escapeHtml(panel.headline)}</span>
    <span class="live-score__bounce-body">${panel.body}</span>
    ${detailsBlock}
  `;
}

function renderInlineError(statusEl: HTMLParagraphElement, message: string): void {
  statusEl.hidden = false;
  statusEl.classList.add('live-score__status--error');
  statusEl.classList.remove('live-score__status--bounce');
  statusEl.textContent = message;
}

/** Reset the status slot to its initial hidden+empty state. Used by the
 * bfcache `pageshow` handler so a back-nav into the homepage doesn't
 * leave stale curated-reward or phase-progression text behind. */
function clearStatus(statusEl: HTMLParagraphElement): void {
  statusEl.hidden = true;
  statusEl.classList.remove('live-score__status--error', 'live-score__status--bounce', 'live-score__status--curated');
  statusEl.textContent = '';
}

/** Show a transient in-progress message (e.g. "Scoring…") during a request.
 * Uses the same status slot bounce panels + inline errors target, so the
 * response render (success or failure) naturally overwrites this text. */
function renderStatus(statusEl: HTMLParagraphElement, message: string): void {
  statusEl.hidden = false;
  statusEl.classList.remove('live-score__status--error', 'live-score__status--bounce', 'live-score__status--curated');
  statusEl.textContent = message;
}

/** Show the curated-hit reward inline before redirect. Identity color via
 * --accent in CSS so the visual cue is "this is one of ours" without a
 * banner, badge, or animation. */
function renderCuratedReward(statusEl: HTMLParagraphElement, message: string): void {
  statusEl.hidden = false;
  statusEl.classList.remove('live-score__status--error', 'live-score__status--bounce');
  statusEl.classList.add('live-score__status--curated');
  statusEl.textContent = message;
}

/** Phase progression while waiting on /api/score.
 *
 * Static "Scoring…" would say nothing about WHAT is taking time, and the
 * brand voice ("authority through precision, engagement through detail")
 * rewards a status line that mirrors the actual phases. The phases are a
 * client-side approximation — real per-step polling would need a
 * dedicated channel — but the timings approximate the median sandbox run
 * so the text stays honest:
 *
 *   - Queued (until t=900 ms)
 *   - Resolving install path (until t=2.5 s)
 *   - Installing in sandbox (until t=18 s)
 *   - Running anc check (until response)
 *
 * Cancelling the cycle when the response arrives keeps the user from
 * ever seeing a phase that's obviously past the work. No CSS animation,
 * no spinner — text replacement IS the indicator. */
type PhaseTimer = { cancel: () => void };

function startPhaseProgression(statusEl: HTMLParagraphElement): PhaseTimer {
  const schedule: { atMs: number; text: string }[] = [
    { atMs: 900, text: 'Resolving install path…' },
    { atMs: 2500, text: 'Installing in sandbox…' },
    { atMs: 18000, text: 'Running anc check…' },
  ];
  const handles: number[] = [];
  for (const phase of schedule) {
    handles.push(
      window.setTimeout(() => {
        renderStatus(statusEl, phase.text);
      }, phase.atMs),
    );
  }
  return {
    cancel: () => {
      for (const h of handles) window.clearTimeout(h);
    },
  };
}

function setSubmitting(els: { submitBtn: HTMLButtonElement; input: HTMLInputElement }, submitting: boolean): void {
  els.submitBtn.disabled = submitting;
  els.input.disabled = submitting;
  els.submitBtn.textContent = submitting ? 'Scoring…' : 'Score';
}

function disableFormWithMessage(
  els: {
    submitBtn: HTMLButtonElement;
    input: HTMLInputElement;
    statusEl: HTMLParagraphElement;
  },
  message: string,
): void {
  els.input.disabled = true;
  els.submitBtn.disabled = true;
  renderInlineError(els.statusEl, message);
}

function networkErrorMessage(err: unknown): string {
  if (err instanceof TypeError) return 'Network error. Check your connection and try again.';
  return 'Scoring failed. Please try again.';
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
