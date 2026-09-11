// The Re-audit control on a result page: the entry form's submit under
// another name. The click is the same transact gesture (acquire a Turnstile
// token, stash, navigate to the progress page); only the gate in front of it
// differs by page.
//
//   bind
//     |-- no target or an unknown lane ..... inert: nothing is bound
//     |-- arm the Turnstile prefetch ....... the script loads on the first interaction
//     |-- data-refresh-after ahead ......... aria-disabled, " in NN s" once a second
//     '-- otherwise ........................ enabled at once
//   click (default prevented)
//     |-- before the deadline .............. no-op: no acquire, no stash, no navigation
//     '-- at or after it ................... startAudit({ target, lane, listing: null[, refresh] })
//
// The deadline is an absolute timestamp, so an edge-cached copy of the page
// still counts down correctly from the visitor's clock. aria-disabled is the
// visual state (never disabled, which would drop the control from the tab
// order); the handler owns the deadline. A live CLI or branch control carries
// data-refresh="1" and its click runs a fresh audit that replaces the cached
// result.
//
// The progress page forwards here with ?v=<scored_at> to step past a stale
// edge copy; the query is dropped on load so the address bar matches the
// canonical URL and the twin links.

import type { Lane } from '../shared/audit-routes';
import { type StartAuditInput, type StartAuditResult, startAudit } from './audit-start';
import { loadTurnstileOnFirstInteraction } from './turnstile';

/** The slice of a button the binder touches, so a test can supply a bare EventTarget. */
export interface ReauditControl extends EventTarget {
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  querySelector(selectors: string): { textContent: string | null } | null;
}

export type ReauditDeps = {
  startAudit: (input: StartAuditInput) => Promise<StartAuditResult>;
  now: () => number;
  setInterval: (tick: () => void, ms: number) => number;
  clearInterval: (handle: number) => void;
  loadTurnstileOnFirstInteraction: (elements: Iterable<EventTarget>) => void;
};

const TICK_MS = 1000;

const productionDeps: ReauditDeps = {
  startAudit,
  now: () => Date.now(),
  setInterval: (tick, ms) => window.setInterval(tick, ms),
  clearInterval: (handle) => window.clearInterval(handle),
  loadTurnstileOnFirstInteraction,
};

function readLane(value: string | null): Lane | null {
  return value === 'cli' || value === 'web' ? value : null;
}

/** The deadline as epoch milliseconds; a missing or unparsable attribute means no gate. */
function readDeadline(value: string | null): number {
  if (value === null) return 0;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function bindReaudit(control: ReauditControl, deps: ReauditDeps = productionDeps): void {
  const target = control.getAttribute('data-target');
  const lane = readLane(control.getAttribute('data-lane'));
  if (!target || !lane) return;
  const refresh = control.getAttribute('data-refresh') === '1';
  const input: StartAuditInput = refresh
    ? { target, lane, listing: null, refresh: true }
    : { target, lane, listing: null };
  const deadline = readDeadline(control.getAttribute('data-refresh-after'));
  const countdown = control.querySelector('[data-reaudit-countdown]');

  deps.loadTurnstileOnFirstInteraction([control]);

  const render = (): boolean => {
    const remaining = deadline - deps.now();
    if (remaining <= 0) {
      control.removeAttribute('aria-disabled');
      if (countdown) countdown.textContent = '';
      return true;
    }
    control.setAttribute('aria-disabled', 'true');
    if (countdown) countdown.textContent = ` in ${Math.ceil(remaining / TICK_MS)} s`;
    return false;
  };

  if (!render()) {
    const handle = deps.setInterval(() => {
      if (render()) deps.clearInterval(handle);
    }, TICK_MS);
  }

  control.addEventListener('click', (event) => {
    event.preventDefault();
    if (deps.now() < deadline) return;
    void deps.startAudit(input);
  });
}

/** Replace a ?v=<scored_at> forwarding URL with the bare path the page canonicalizes to. */
export function dropVersionQuery(): void {
  if (!new URLSearchParams(location.search).has('v')) return;
  history.replaceState(null, '', location.pathname);
}

export function initReaudit(): void {
  dropVersionQuery();
  for (const control of document.querySelectorAll<HTMLButtonElement>('[data-reaudit]')) bindReaudit(control);
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initReaudit);
  else initReaudit();
}
