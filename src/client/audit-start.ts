// The one transact click handler every audit control binds: the entry
// form's submit on `/` and `/audit`, and the Re-audit control on a result
// page. Only this gesture acquires a Turnstile token; navigation never
// transacts.
//
//   click
//     |-- classify the target ......... rejected: return the reason, no acquire
//     |-- guard ....................... a click while one is in flight is dropped
//     |-- acquire the token ........... failed: release the guard, return turnstile_failed
//     |-- stash(target, record) ....... token, listing, entered lane, refresh
//     '-- navigate(/scoring?target=) .. &refresh=1 on a refresh click

import { classifyTarget, type Lane, scoringPath, type TargetRejection } from '../shared/audit-routes';
import { stash } from './audit-stash';
import { getTurnstileToken, readSitekey } from './turnstile';

export type StartAuditInput = {
  target: string;
  /** The lane the visitor had selected; the target's shape decides the real lane. */
  lane: Lane;
  listing: boolean | null;
  refresh?: boolean;
};

export type StartAuditDeps = {
  /** Acquire a Turnstile token for the click; defaults to the shared widget. */
  acquire?: (target: string) => Promise<string>;
  /** Leave for the progress page; defaults to a same-tab navigation that keeps the entry page in history. */
  navigate?: (path: string) => void;
};

export type StartAuditResult =
  | { ok: true; target: string; lane: Lane; entered_lane: Lane }
  | { ok: false; reason: TargetRejection | 'turnstile_failed' | 'in_flight'; message: string };

// Dropping a second click while the first is in flight is what keeps one
// gesture from spending two tokens; the guard is module-level so every
// control on the page shares it.
let inFlight = false;
let guardEnabled = true;

/** Test-only: release the guard, and optionally neutralize it for a negative control. */
export function _resetStartAuditForTests(opts: { guard: boolean }): void {
  inFlight = false;
  guardEnabled = opts.guard;
}

// A page restored from the back-forward cache keeps its JavaScript heap, so
// a click that was in flight when the visitor left would otherwise stay
// latched.
if (typeof window !== 'undefined') {
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) inFlight = false;
  });
}

async function acquireWithWidget(): Promise<string> {
  const sitekey = readSitekey();
  if (!sitekey) throw new Error('turnstile_sitekey_missing');
  return getTurnstileToken(sitekey, document.body);
}

function navigateSameTab(path: string): void {
  window.location.href = path;
}

export async function startAudit(input: StartAuditInput, deps: StartAuditDeps = {}): Promise<StartAuditResult> {
  const classified = classifyTarget(input.target);
  if (!classified.ok) return { ok: false, reason: classified.reason, message: classified.message };
  if (guardEnabled && inFlight) return { ok: false, reason: 'in_flight', message: 'An audit is already starting.' };
  inFlight = true;
  const refresh = input.refresh === true;
  try {
    let token: string;
    try {
      token = await (deps.acquire ?? acquireWithWidget)(classified.target);
    } catch {
      return { ok: false, reason: 'turnstile_failed', message: 'Verification failed. Please try again.' };
    }
    stash(classified.target, { token, listing: input.listing, entered_lane: input.lane, refresh });
    (deps.navigate ?? navigateSameTab)(scoringPath(classified.target, { refresh }));
    return { ok: true, target: classified.target, lane: classified.lane, entered_lane: input.lane };
  } finally {
    inFlight = false;
  }
}
