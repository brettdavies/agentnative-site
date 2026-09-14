// The progress page's client: one audit of one target, from the first
// request to the forward. The Worker renders the first paint; this module
// owns every state after it.
//
//   load
//     |-- a result kept for this target (no URL of its own) ... restore it
//     |-- a stashed click ...................................... POST with its token
//     '-- otherwise ............................................ POST without one (probe)
//   answer
//     |-- JSON 200 envelope ....... hit: the reward or cached line, forward after the floor
//     |-- JSON 202 in progress .... ask again every 3 s until the answer changes
//     |-- JSON 403 on a probe ..... idle: Start
//     |-- JSON 503 unavailable .... wait: count retry_after down, then Start
//     |-- JSON error .............. failed: the bounce panel, Run again
//     '-- NDJSON stream ........... rows as lines land; the terminal line forwards,
//                                   renders inline when there is no URL, or fails
//   Start or Run again: acquire a token on the click, then POST it
//
// Only a click spends a token: a probe never carries one, and a failed or
// waiting state holds until the next gesture. A stream reached by a probe is
// another visitor's run attached to; it renders exactly like one's own.

import type { AuditEnvelope } from '../shared/audit-envelope';
import type { AuditError, AuditEvent, CompleteEvent } from '../shared/audit-events';
import { apiScorePath, type Lane, scoreMarkdownPath } from '../shared/audit-routes';
import { ndjsonValues } from '../shared/ndjson';
import { CLI_PHASE_LABEL, LANE_EXPECTATION, LANE_LABEL, RECLASSIFIED } from '../shared/scoring-copy';
import {
  buildScoreBody,
  clearInlineResult,
  enteredLaneOf,
  stashInlineResult,
  take,
  takeInlineResult,
} from './audit-stash';
import { type BouncePanel, bouncePanel, INCOMPLETE_PANEL, NETWORK_PANEL, STREAM_LOST_PANEL } from './scoring-bounce';
import { findElements, ScoringView } from './scoring-view';
import { getTurnstileToken, loadTurnstileOnFirstInteraction, readSitekey } from './turnstile';

/** A hit stays on screen at least this long so its line is readable before the forward. */
const FLOOR_MS = 2000;
const POLL_MS = 3000;
const TICK_MS = 1000;

type Choice = { listing: boolean | null; refresh: boolean };

type JsonAnswer = Partial<AuditEnvelope> & { error?: AuditError; in_progress?: boolean };

function formatInstant(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return `${new Date(t).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

class ScoringRun {
  private readonly loadedAt = Date.now();
  private clock: number | null = null;
  private checks = 0;
  private startBound = false;

  constructor(
    private readonly view: ScoringView,
    private readonly target: string,
    private readonly lane: Lane,
    private readonly checkTotal: number | null,
    private readonly refresh: boolean,
    private readonly sitekey: string | null,
  ) {}

  begin(): void {
    const kept = takeInlineResult(this.target);
    if (kept) {
      this.inline(kept);
      return;
    }
    const entered = enteredLaneOf(this.target);
    if (entered && entered !== this.lane) {
      this.view.subline(`${RECLASSIFIED[this.lane]} ${LANE_EXPECTATION[this.lane]}`);
      this.view.say(RECLASSIFIED[this.lane]);
    }
    const stashed = take(this.target);
    if (stashed) {
      if (!entered || entered === this.lane) this.view.say('Queued…');
      void this.post(stashed.token, { listing: stashed.listing, refresh: stashed.refresh });
      return;
    }
    void this.post(null, null);
  }

  private async post(token: string | null, choice: Choice | null): Promise<void> {
    const body = token && choice ? buildScoreBody(this.target, token, choice) : { target: this.target };
    let res: Response;
    try {
      res = await fetch(apiScorePath(), {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/x-ndjson' },
        body: JSON.stringify(body),
      });
    } catch {
      this.fail(NETWORK_PANEL);
      return;
    }
    if ((res.headers.get('content-type') ?? '').includes('application/x-ndjson') && res.body) {
      await this.stream(res.body);
      return;
    }
    await this.answer(res, token !== null);
  }

  private async answer(res: Response, tokened: boolean): Promise<void> {
    const payload = (await res.json().catch(() => null)) as JsonAnswer | null;
    if (res.ok && payload?.kind && payload.freshness) {
      this.hit(payload as AuditEnvelope);
      return;
    }
    if (res.status === 202 && payload?.in_progress) {
      this.view.state('running');
      this.view.say('An audit of this target is already running. Waiting for it to finish.');
      window.setTimeout(() => void this.post(null, null), POLL_MS);
      return;
    }
    const error = payload?.error;
    if (res.status === 403 && error?.code === 'turnstile_failed' && !tokened) {
      this.idle();
      return;
    }
    if (res.status === 503 && error?.code === 'turnstile_unavailable') {
      this.wait(error.retry_after ?? 30);
      return;
    }
    this.fail(error ? bouncePanel(error) : { headline: 'The audit could not start.', bodyHtml: 'Run it again.' });
  }

  private hit(envelope: AuditEnvelope): void {
    clearInlineResult(this.target);
    this.view.state('done');
    this.say_result(envelope);
    if (envelope.scorecard_url) this.forward(envelope.scorecard_url, null);
  }

  private say_result(envelope: Pick<AuditEnvelope, 'tier' | 'freshness'>): void {
    if (envelope.tier === 'registry') {
      this.view.say(`${this.target} is a curated scorecard. Opening it.`, 'curated');
      return;
    }
    if (envelope.tier === 'cache') {
      const when = formatInstant(envelope.freshness.scored_at);
      this.view.say(
        when ? `Cached result from ${when}. Opening the scorecard.` : 'Cached result. Opening the scorecard.',
      );
      return;
    }
    this.view.say('Opening the scorecard.');
  }

  private forward(url: string, scoredAt: string | null): void {
    const destination = scoredAt ? `${url}?v=${encodeURIComponent(scoredAt)}` : url;
    const wait = Math.max(0, FLOOR_MS - (Date.now() - this.loadedAt));
    // replace, not assign: the progress page never enters history.
    window.setTimeout(() => window.location.replace(destination), wait);
  }

  private async stream(body: ReadableStream<Uint8Array>): Promise<void> {
    let ended = false;
    try {
      for await (const value of ndjsonValues(body)) {
        if (this.event(value as AuditEvent)) {
          ended = true;
          break;
        }
      }
    } catch {
      // A broken read is a lost stream, handled below.
    }
    if (!ended) this.fail(STREAM_LOST_PANEL);
  }

  /** Render one line; true when it ended the run. */
  private event(event: AuditEvent): boolean {
    switch (event.type) {
      case 'accepted':
        this.accepted();
        return false;
      case 'phase':
        this.view.phase(event.phase);
        this.view.say(`${CLI_PHASE_LABEL[event.phase]}…`);
        return false;
      case 'discovery':
        this.view.sayProgress(
          event.mcp_endpoint
            ? `MCP endpoint found at ${event.mcp_endpoint}. Checks:`
            : 'No MCP endpoint found. Checks:',
          this.progressText(),
        );
        return false;
      case 'check':
        this.checks += 1;
        this.view.check(event.id, event.principle, event.status, event.evidence);
        this.view.progress(this.progressText());
        return false;
      case 'heartbeat':
        return false;
      case 'complete':
        this.complete(event);
        return true;
      case 'incomplete':
        this.fail(INCOMPLETE_PANEL);
        return true;
      case 'bounce':
      case 'error':
        this.fail(bouncePanel(event.error));
        return true;
    }
  }

  private progressText(): string {
    return this.checkTotal ? `${this.checks} of ${this.checkTotal}` : `${this.checks}`;
  }

  private accepted(): void {
    this.view.state('running');
    this.view.actions({ start: null, other: false });
    this.view.say('Started.');
    const acceptedAt = Date.now();
    this.stopClock();
    this.view.tick(0);
    this.clock = window.setInterval(() => this.view.tick(Math.floor((Date.now() - acceptedAt) / TICK_MS)), TICK_MS);
  }

  private stopClock(): void {
    if (this.clock !== null) window.clearInterval(this.clock);
    this.clock = null;
  }

  private complete(event: CompleteEvent): void {
    this.stopClock();
    this.view.settle('pass');
    if (!event.scorecard_url) {
      this.inline(event.summary_html ?? '');
      return;
    }
    clearInlineResult(this.target);
    this.view.state('done');
    this.say_result(event);
    this.forward(event.scorecard_url, event.tier === 'live' ? event.freshness.scored_at : null);
  }

  /** A result whose name belongs to a curated tool: it has no URL, so it renders here and survives a refresh. */
  private inline(html: string): void {
    stashInlineResult(this.target, html);
    this.view.state('done');
    this.view.subline('This name belongs to a curated tool; this result has no URL.');
    this.view.say('Done.');
    this.view.inline(html);
    this.view.actions({ start: 'Run again', other: true });
    this.bindStart();
    this.view.focusHeading();
  }

  private fail(panel: BouncePanel): void {
    this.stopClock();
    this.view.settle('fail');
    clearInlineResult(this.target);
    this.view.state('failed');
    this.view.bounce(panel);
    this.view.say(panel.headline, 'error');
    this.view.actions({ start: 'Run again', other: true });
    this.bindStart();
    this.view.focusHeading();
  }

  private idle(): void {
    this.view.state('idle');
    this.view.say(`${LANE_LABEL[this.lane]} audit of ${this.target}. ${LANE_EXPECTATION[this.lane]}`);
    this.view.actions({ start: 'Start', other: true });
    this.bindStart();
  }

  /** Verification is down: hold Start until retry_after has passed, then say so once. */
  private wait(seconds: number): void {
    this.view.state('idle');
    this.view.say(`Verification is briefly unavailable. Retrying in about ${seconds} seconds.`);
    this.view.actions({ start: 'Start', other: true });
    this.bindStart();
    this.view.busy(true);
    let left = seconds;
    this.view.countdown(`${left} s`);
    const handle = window.setInterval(() => {
      left -= 1;
      if (left > 0) {
        this.view.countdown(`${left} s`);
        return;
      }
      window.clearInterval(handle);
      this.view.countdown('');
      this.view.busy(false);
      this.view.say('Ready to retry.');
    }, TICK_MS);
  }

  private bindStart(): void {
    if (this.startBound) return;
    this.startBound = true;
    loadTurnstileOnFirstInteraction([this.view.el.start]);
    this.view.el.start.addEventListener('click', () => void this.onStart());
  }

  private async onStart(): Promise<void> {
    if (this.view.isBusy()) return;
    if (!this.sitekey) {
      this.fail({
        headline: 'Live audits are not available here.',
        bodyHtml: `Read the saved result at <a href="${scoreMarkdownPath(this.target)}">its markdown twin</a>, or call the MCP read tools at <a href="/mcp">/mcp</a>.`,
      });
      return;
    }
    clearInlineResult(this.target);
    this.view.busy(true);
    this.view.state('idle');
    this.view.say('Verifying…');
    let token: string;
    try {
      token = await getTurnstileToken(this.sitekey, this.view.el.root);
    } catch {
      this.view.busy(false);
      this.view.say('Verification did not complete. Try again.', 'error');
      return;
    }
    this.view.busy(false);
    this.view.state('running');
    this.view.actions({ start: null, other: false });
    this.view.say('Queued…');
    await this.post(token, { listing: null, refresh: this.refresh });
  }
}

function init(): void {
  const root = document.querySelector<HTMLElement>('[data-scoring]');
  if (!root) return;
  const el = findElements(root);
  const target = root.dataset.target;
  const lane = root.dataset.lane;
  if (!el || !target || (lane !== 'cli' && lane !== 'web')) return;
  const total = Number(root.dataset.checkTotal);
  const refresh = new URLSearchParams(window.location.search).get('refresh') === '1' || root.dataset.refresh === '1';
  const run = new ScoringRun(
    new ScoringView(el, target, lane),
    target,
    lane,
    Number.isFinite(total) && total > 0 ? total : null,
    refresh,
    readSitekey(),
  );
  run.begin();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
