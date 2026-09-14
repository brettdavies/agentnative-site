// The progress page's DOM: one heading, one status line, one body region,
// and one action row. The controller decides the state; this module writes
// it. The status line is the page's one live region, written once per state
// change; the elapsed counter and the wait countdown tick in aria-hidden
// spans outside it, and progress rows are never announced one by one.

import type { CliPhase } from '../shared/audit-events';
import type { Lane } from '../shared/audit-routes';
import { escHtml } from '../shared/esc-html';
import { CLI_PHASE_LABEL, type ScoringState, scoringHeadingHtml, scoringTitle } from '../shared/scoring-copy';
import type { BouncePanel } from './scoring-bounce';

export type ScoringElements = {
  root: HTMLElement;
  heading: HTMLElement;
  subline: HTMLElement;
  status: HTMLElement;
  body: HTMLElement;
  start: HTMLButtonElement;
  other: HTMLElement;
  countdown: HTMLElement;
};

export function findElements(root: HTMLElement): ScoringElements | null {
  const q = <T extends Element>(sel: string) => root.querySelector<T>(sel);
  const heading = q<HTMLElement>('[data-scoring-heading]');
  const subline = q<HTMLElement>('[data-scoring-subline]');
  const status = q<HTMLElement>('[data-scoring-status]');
  const body = q<HTMLElement>('[data-scoring-body]');
  const start = q<HTMLButtonElement>('[data-scoring-start]');
  const other = q<HTMLElement>('[data-scoring-other]');
  const countdown = q<HTMLElement>('[data-scoring-countdown]');
  if (!heading || !subline || !status || !body || !start || !other || !countdown) return null;
  return { root, heading, subline, status, body, start, other, countdown };
}

export type StatusTone = 'plain' | 'error' | 'curated';

const TONE_CLASS: Record<Exclude<StatusTone, 'plain'>, string> = {
  error: 'live-score__status--error',
  curated: 'live-score__status--curated',
};

function pillFor(status: string): { cls: string; text: string } {
  if (status === 'pass') return { cls: 'stpill--pass', text: 'pass' };
  if (status === 'warn') return { cls: 'stpill--warn', text: 'warn' };
  if (status === 'n_a' || status === 'na' || status === 'skip') return { cls: 'stpill--na', text: 'n/a' };
  return { cls: 'stpill--fail', text: status.replace(/_/g, ' ') };
}

export class ScoringView {
  private rows: HTMLOListElement | null = null;
  private running: HTMLElement | null = null;
  private progressCount: HTMLElement | null = null;
  private elapsed: HTMLElement | null = null;

  constructor(
    readonly el: ScoringElements,
    private readonly target: string,
    private readonly lane: Lane,
  ) {}

  state(state: ScoringState): void {
    this.el.heading.innerHTML = scoringHeadingHtml(state, this.target, this.lane);
    document.title = scoringTitle(state, this.target);
  }

  /** One write to the live region; an error is announced assertively. */
  say(text: string, tone: StatusTone = 'plain'): void {
    const { status } = this.el;
    status.setAttribute('aria-live', tone === 'error' ? 'assertive' : 'polite');
    status.classList.remove(TONE_CLASS.error, TONE_CLASS.curated);
    if (tone !== 'plain') status.classList.add(TONE_CLASS[tone]);
    status.textContent = text;
    this.progressCount = null;
  }

  /** A status line whose count changes in an aria-hidden span, so only the line itself is announced. */
  sayProgress(text: string, count: string): void {
    this.say(text);
    const span = document.createElement('span');
    span.setAttribute('aria-hidden', 'true');
    span.textContent = count;
    this.el.status.append(' ', span);
    this.progressCount = span;
  }

  progress(count: string): void {
    if (this.progressCount) this.progressCount.textContent = count;
  }

  subline(text: string): void {
    this.el.subline.textContent = text;
    this.elapsed = null;
  }

  private list(): HTMLOListElement {
    if (!this.rows) {
      this.rows = document.createElement('ol');
      this.rows.className = 'pscore__list scoring__rows';
      this.el.body.replaceChildren(this.rows);
    }
    return this.rows;
  }

  private row(id: string, title: string, pill: { cls: string; text: string }, evidence?: string | null): HTMLElement {
    const li = document.createElement('li');
    li.className = 'pscore__row scoring__row';
    const note = evidence ? `<p class="pscore__evidence">${escHtml(evidence)}</p>` : '';
    li.innerHTML =
      `<span class="scoring__id">${escHtml(id)}</span>` +
      `<span class="scoring__title">${escHtml(title)}${note}</span>` +
      `<span class="scoring__trail"><span class="stpill ${pill.cls}" data-pill>${escHtml(pill.text)}</span>` +
      '<span class="scoring__counter" aria-hidden="true" data-counter></span></span>';
    this.list().append(li);
    return li;
  }

  /** Close the running row as passed, then open a running row for `phase`. */
  phase(phase: CliPhase): void {
    this.settle('pass');
    this.running = this.row(phase, CLI_PHASE_LABEL[phase], { cls: 'scoring__pill--running', text: 'running' });
  }

  /** A finished website check. */
  check(id: string, title: string, status: string, evidence: string | null): void {
    this.row(id, title, pillFor(status), evidence);
  }

  /** Close the running row with the pill its run ended on; its counter keeps the final time. */
  settle(outcome: 'pass' | 'fail'): void {
    const pill = this.running?.querySelector<HTMLElement>('[data-pill]');
    if (pill) {
      pill.className = `stpill ${outcome === 'pass' ? 'stpill--pass' : 'stpill--fail'}`;
      pill.textContent = outcome === 'pass' ? 'done' : 'stopped';
    }
    this.running = null;
  }

  /** The elapsed counter: beside the running row, or after the subline when no row is running. */
  tick(seconds: number): void {
    const text = `${seconds} s`;
    const counter = this.running?.querySelector<HTMLElement>('[data-counter]');
    if (counter) {
      counter.textContent = text;
      return;
    }
    if (!this.elapsed) {
      this.elapsed = document.createElement('span');
      this.elapsed.className = 'scoring__counter';
      this.elapsed.setAttribute('aria-hidden', 'true');
      this.el.subline.append(' ', this.elapsed);
    }
    this.elapsed.textContent = text;
  }

  bounce(panel: BouncePanel): void {
    this.rows = null;
    this.running = null;
    const box = document.createElement('div');
    box.className = 'live-score__status live-score__status--bounce scoring__bounce';
    const details = panel.details
      ? `<pre class="live-score__bounce-stderr" tabindex="0"><code>${escHtml(panel.details)}</code></pre>`
      : '';
    box.innerHTML = `<span class="live-score__bounce-headline">${escHtml(panel.headline)}</span><span class="live-score__bounce-body">${panel.bodyHtml}</span>${details}`;
    this.el.body.replaceChildren(box);
  }

  /** A result body with no URL of its own; the Worker built and escaped it. */
  inline(html: string): void {
    this.rows = null;
    this.running = null;
    this.el.body.innerHTML = html;
  }

  actions(opts: { start: 'Start' | 'Run again' | null; other: boolean }): void {
    const { start, other } = this.el;
    start.hidden = opts.start === null;
    if (opts.start) start.textContent = opts.start;
    other.hidden = !opts.other;
  }

  /** aria-disabled, never disabled: the control keeps its place in the tab order and its focus. */
  busy(on: boolean): void {
    if (on) this.el.start.setAttribute('aria-disabled', 'true');
    else this.el.start.removeAttribute('aria-disabled');
  }

  isBusy(): boolean {
    return this.el.start.getAttribute('aria-disabled') === 'true';
  }

  countdown(text: string): void {
    this.el.countdown.textContent = text;
  }

  focusHeading(): void {
    this.el.heading.focus();
  }
}
