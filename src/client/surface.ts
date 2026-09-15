// Visitor surface preference (CLI | Website) — drives header Leaderboards/Audit
// and homepage segment restore. Mirrors theme.ts storage guards.

export type Surface = 'cli' | 'web';

const STORAGE_KEY = 'anc-surface';

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

type SurfaceProbeConfig = {
  segSelector: string;
  cliRadioId: string;
  webRadioId: string;
};

function surfaceFromHomeRadio(id: string): Surface {
  return id === 's-web' ? 'web' : 'cli';
}

function surfaceFromRadioId(id: string, webRadioId: string): Surface {
  return id === webRadioId ? 'web' : 'cli';
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

  // A lane named in the URL is already checked on the served markup, and an
  // explicit link beats a remembered preference: restoring the stored surface
  // here would send a visitor who followed one straight back to the other
  // pane.
  let laneInUrl = false;
  try {
    laneInUrl = new URLSearchParams(globalThis.location?.search ?? '').has('lane');
  } catch {
    // No parseable location: the stored surface is the only signal there is.
  }
  if (!laneInUrl) {
    if (getSurface() === 'web') web.checked = true;
    else cli.checked = true;
  }

  // The pre-paint attribute has done its job now that a radio carries the
  // surface. Leaving it set would overrule a later CLI selection, which is
  // the fight the off-home reader above refuses to start.
  delete document.documentElement.dataset.surface;

  for (const radio of [cli, web]) {
    radio.addEventListener('change', () => {
      if (!radio.checked) return;
      setSurface(surfaceFromHomeRadio(radio.id));
    });
  }
}

// One board and one entry form serve both lanes, so flipping the segment
// swaps panes on the page the visitor is already on. The flip records the
// preference, which is what the header nav and the next page read; it never
// navigates, because there is no peer page left to navigate to.
function bindSurfaceProbe(config: SurfaceProbeConfig): void {
  const seg = document.querySelector(config.segSelector);
  if (!seg) return;

  const cli = document.getElementById(config.cliRadioId) as HTMLInputElement | null;
  const web = document.getElementById(config.webRadioId) as HTMLInputElement | null;
  if (!cli || !web) return;

  for (const radio of [cli, web]) {
    radio.addEventListener('change', () => {
      if (!radio.checked) return;
      setSurface(surfaceFromRadioId(radio.id, config.webRadioId));
    });
  }
}

const BOARD_PROBE: SurfaceProbeConfig = {
  segSelector: '[data-surface-board-seg]',
  cliRadioId: 'board-s-cli',
  webRadioId: 'board-s-web',
};

const AUDIT_PROBE: SurfaceProbeConfig = {
  segSelector: '[data-surface-audit-seg]',
  cliRadioId: 'audit-s-cli',
  webRadioId: 'audit-s-web',
};

function init(): void {
  applyOffHomeReader();
  bindHomepage();
  bindSurfaceProbe(BOARD_PROBE);
  bindSurfaceProbe(AUDIT_PROBE);
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
}
