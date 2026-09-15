// Shared invisible-Turnstile helper for every transact surface. The widget
// renders once per page session into an off-screen mount; each acquire
// resets and re-executes it, because rendering again on the same container
// while a prior execution settles triggers Turnstile's "already executing"
// warning and a 400020 on the second submit. Cloudflare returns a token in
// the background or fires error-callback. Invisible mode has no interactive
// fallback, so the token is acquired on a click (where Cloudflare has an
// interaction signal and clears silently far more often), and the script
// loads on the first interaction with a form, never on a page merely
// scrolled past.

import { STASH_TTL_MS } from './audit-stash';

export interface TurnstileApi {
  render(
    element: HTMLElement | string,
    options: {
      sitekey: string;
      size?: 'compact' | 'flexible' | 'normal';
      execution?: 'render' | 'execute';
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
const STASH_PREFIX = 'web-audit-turnstile:';

export function readSitekey(): string | null {
  const meta = document.querySelector<HTMLMetaElement>('meta[name=turnstile-sitekey]');
  const value = meta?.content?.trim();
  return value ? value : null;
}

let turnstilePromise: Promise<TurnstileApi> | null = null;
let widget: { id: string; container: HTMLDivElement } | null = null;
let pending: { resolve: (token: string) => void; reject: (err: Error) => void } | null = null;
let pendingTimer: ReturnType<typeof setTimeout> | null = null;

// Invisible Turnstile can settle with neither callback nor error-callback
// (an interactive challenge with nowhere to render, a silently dropped
// clearance): without a timeout the acquire promise never resolves and the
// page hangs with no console output. The cap converts that into a visible,
// retryable failure.
const ACQUIRE_TIMEOUT_MS = 20_000;

export function ensureTurnstileLoaded(): Promise<TurnstileApi> {
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
    turnstilePromise = null;
    throw err;
  });
  return turnstilePromise;
}

function settle(result: { token: string } | { error: Error }): void {
  if (pendingTimer !== null) {
    clearTimeout(pendingTimer);
    pendingTimer = null;
  }
  const p = pending;
  pending = null;
  if (!p) return;
  if ('token' in result) p.resolve(result.token);
  else p.reject(result.error);
}

/**
 * Acquire a token on the current gesture. The first call renders the
 * widget into `mountHost`; later calls reset and re-execute that widget.
 * A call while one is pending is refused rather than dropping the pending
 * resolver.
 */
export function acquireTurnstileToken(sitekey: string, api: TurnstileApi, mountHost: HTMLElement): Promise<string> {
  return new Promise((resolve, reject) => {
    if (pending) {
      reject(new Error('turnstile_already_pending'));
      return;
    }
    pending = { resolve, reject };
    pendingTimer = setTimeout(() => settle({ error: new Error('turnstile_timeout') }), ACQUIRE_TIMEOUT_MS);
    try {
      if (widget) {
        api.reset(widget.id);
        api.execute(widget.id);
        return;
      }
      // A teardown removes the widget but leaves its mount in the document;
      // a later acquire on a restored page reuses that mount instead of
      // stacking another.
      const container =
        mountHost.querySelector<HTMLDivElement>('[data-turnstile-mount]') ??
        mountHost.ownerDocument.createElement('div');
      container.setAttribute('data-turnstile-mount', '');
      container.style.cssText = 'position:absolute;left:-9999px;width:0;height:0;overflow:hidden';
      mountHost.appendChild(container);
      const id = api.render(container, {
        sitekey,
        execution: 'execute',
        callback: (token: string) => settle({ token }),
        'error-callback': () => settle({ error: new Error('turnstile_error') }),
        'expired-callback': () => settle({ error: new Error('turnstile_expired') }),
      });
      widget = { id, container };
      api.execute(id);
    } catch (err) {
      // A widget API that throws must not leave the pending guard set for
      // the next click.
      settle({ error: err instanceof Error ? err : new Error(String(err)) });
    }
  });
}

/**
 * Load the Turnstile script on the first interaction with any of
 * `elements` (focus, paste, click), so the widget is ready by the time the
 * visitor clicks and a page merely scrolled past never fetches it.
 */
export function loadTurnstileOnFirstInteraction(elements: Iterable<EventTarget>): void {
  for (const element of elements) {
    const armed = new AbortController();
    const load = () => {
      armed.abort();
      void ensureTurnstileLoaded().catch(() => {
        // The click path retries the load; a failed prefetch is not an error.
      });
    };
    for (const type of ['focus', 'paste', 'click']) {
      element.addEventListener(type, load, { signal: armed.signal });
    }
  }
}

/**
 * Remove the widget and reject any acquire still waiting on it, so a
 * caller awaiting the token reaches its error path instead of hanging on
 * a resolver that will never fire.
 */
export function teardownTurnstile(): void {
  const api = typeof window === 'undefined' ? undefined : window.turnstile;
  if (widget && api) api.remove(widget.id);
  widget = null;
  settle({ error: new Error('turnstile_torn_down') });
}

/** Acquire a token end-to-end: load the script, render or reuse the widget, execute, resolve. */
export async function getTurnstileToken(sitekey: string, mountHost: HTMLElement): Promise<string> {
  const api = await ensureTurnstileLoaded();
  return acquireTurnstileToken(sitekey, api, mountHost);
}

/** Stash a fresh token for the scoring page to consume, keyed by audited host. */
export function stashTurnstileToken(host: string, token: string): void {
  try {
    sessionStorage.setItem(STASH_PREFIX + host, JSON.stringify({ token, ts: Date.now() }));
  } catch {
    // Private-mode or disabled storage: the scoring page falls back to a
    // fresh on-load acquire.
  }
}

/** Read and remove a stashed token (single-use); null if absent or stale. */
export function takeTurnstileToken(host: string): string | null {
  const key = STASH_PREFIX + host;
  let raw: string | null = null;
  try {
    raw = sessionStorage.getItem(key);
    sessionStorage.removeItem(key);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const { token, ts } = JSON.parse(raw) as { token?: string; ts?: number };
    if (typeof token === 'string' && typeof ts === 'number' && Date.now() - ts < STASH_TTL_MS) {
      return token;
    }
  } catch {
    // Corrupt entry: ignore and fall back to a fresh acquire.
  }
  return null;
}

// A bfcache-restored page must not reuse a half-dead widget instance.
if (typeof window !== 'undefined') window.addEventListener('pagehide', teardownTurnstile);
