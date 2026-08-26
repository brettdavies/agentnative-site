// Visitor surface preference (CLI | Website) — drives header Leaderboards and
// homepage segment restore. Mirrors theme.ts storage guards.

export type Surface = 'cli' | 'web';

const STORAGE_KEY = 'anc-surface';

const CLI_HREF = '/scorecards';
const WEB_HREF = '/web';

export function getSurface(): Surface {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'web') return 'web';
  } catch {
    // localStorage unavailable — default cli.
  }
  return 'cli';
}

export function setSurface(surface: Surface): void {
  try {
    localStorage.setItem(STORAGE_KEY, surface);
  } catch {
    // Blocked storage — preference applies for this gesture only.
  }
}

/** Read-only href map for tests and diagnostics; production nav uses dual anchors + CSS. */
export function leaderboardsHref(): string {
  return getSurface() === 'web' ? WEB_HREF : CLI_HREF;
}

function surfaceFromHomeRadio(id: string): Surface {
  return id === 's-web' ? 'web' : 'cli';
}

function surfaceFromBoardRadio(id: string): Surface {
  return id === 'board-s-web' ? 'web' : 'cli';
}

function peerBoardHref(surface: Surface): string {
  return surface === 'web' ? WEB_HREF : CLI_HREF;
}

function applyOffHomeReader(): void {
  // Homepage uses :has on #s-cli / #s-web; do not fight with data-surface (KTD2b).
  if (document.getElementById('s-cli')) return;
  document.documentElement.dataset.surface = getSurface();
}

function bindHomepage(): void {
  const cli = document.getElementById('s-cli') as HTMLInputElement | null;
  const web = document.getElementById('s-web') as HTMLInputElement | null;
  if (!cli || !web) return;

  if (getSurface() === 'web') web.checked = true;
  else cli.checked = true;

  for (const radio of [cli, web]) {
    radio.addEventListener('change', () => {
      if (!radio.checked) return;
      setSurface(surfaceFromHomeRadio(radio.id));
    });
  }
}

function bindBoardProbe(): void {
  const seg = document.querySelector('[data-surface-board-seg]');
  if (!seg) return;

  const cli = document.getElementById('board-s-cli') as HTMLInputElement | null;
  const web = document.getElementById('board-s-web') as HTMLInputElement | null;
  if (!cli || !web) return;

  const currentPath = globalThis.location?.pathname ?? '';
  const onCliBoard = currentPath === CLI_HREF || currentPath.startsWith('/score/');
  const onWebBoard =
    currentPath === WEB_HREF || (currentPath.startsWith('/web/') && !currentPath.startsWith('/web-audit'));

  for (const radio of [cli, web]) {
    radio.addEventListener('change', () => {
      if (!radio.checked) return;
      const next = surfaceFromBoardRadio(radio.id);
      const staying = (onCliBoard && next === 'cli') || (onWebBoard && next === 'web');
      if (staying) return;
      setSurface(next);
      globalThis.location.assign(peerBoardHref(next));
    });
  }
}

function init(): void {
  applyOffHomeReader();
  bindHomepage();
  bindBoardProbe();
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
}
