// Shared invisible-Turnstile helper for the web-audit surface (the form page
// and the /web/scoring in-progress page). The widget renders into an
// off-screen mount and executes once; Cloudflare returns a token in the
// background or fires error-callback. Invisible mode has no interactive
// fallback, so the token is acquired on the form's submit gesture (where
// Cloudflare has an interaction signal and clears silently far more often)
// and carried to the scoring page through sessionStorage.

interface TurnstileApi {
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
// A carried token must reach the scoring-page POST inside Turnstile's ~300s
// token lifetime; discard anything older so a stale tab never POSTs a dead one.
const STASH_TTL_MS = 240_000;

export function readSitekey(): string | null {
  const meta = document.querySelector<HTMLMetaElement>('meta[name=turnstile-sitekey]');
  const value = meta?.content?.trim();
  return value ? value : null;
}

let turnstilePromise: Promise<TurnstileApi> | null = null;
let widget: { id: string; container: HTMLDivElement } | null = null;
let pending: { resolve: (token: string) => void; reject: (err: Error) => void } | null = null;

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
  const p = pending;
  pending = null;
  if (!p) return;
  if ('token' in result) p.resolve(result.token);
  else p.reject(result.error);
}

export function acquireTurnstileToken(sitekey: string, api: TurnstileApi, mountHost: HTMLElement): Promise<string> {
  return new Promise((resolve, reject) => {
    if (pending) {
      reject(new Error('turnstile_already_pending'));
      return;
    }
    pending = { resolve, reject };
    const container = document.createElement('div');
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
  });
}

export function teardownTurnstile(): void {
  if (widget && window.turnstile) {
    window.turnstile.remove(widget.id);
  }
  widget = null;
  pending = null;
}

/** Acquire a token end-to-end: load the script, render, execute, resolve. */
export async function getTurnstileToken(sitekey: string, mountHost: HTMLElement): Promise<string> {
  const api = await ensureTurnstileLoaded();
  try {
    return await acquireTurnstileToken(sitekey, api, mountHost);
  } finally {
    teardownTurnstile();
  }
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

window.addEventListener('pagehide', teardownTurnstile);
