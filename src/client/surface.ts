// Visitor surface preference (CLI | Website) — drives header Leaderboards/Audit
// and homepage segment restore. Mirrors theme.ts storage guards.

export type Surface = 'cli' | 'web';

const STORAGE_KEY = 'anc-surface';

const CLI_BOARD_HREF = '/scorecards';
const WEB_BOARD_HREF = '/web';
const CLI_AUDIT_HREF = '/audit';
const WEB_AUDIT_HREF = '/web-audit';

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
  return getSurface() === 'web' ? WEB_BOARD_HREF : CLI_BOARD_HREF;
}

export function auditHref(): string {
  return getSurface() === 'web' ? WEB_AUDIT_HREF : CLI_AUDIT_HREF;
}

type SurfaceProbeConfig = {
  segSelector: string;
  cliRadioId: string;
  webRadioId: string;
  isOnCli: (path: string) => boolean;
  isOnWeb: (path: string) => boolean;
  peerHref: (surface: Surface) => string;
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

  if (getSurface() === 'web') web.checked = true;
  else cli.checked = true;

  for (const radio of [cli, web]) {
    radio.addEventListener('change', () => {
      if (!radio.checked) return;
      setSurface(surfaceFromHomeRadio(radio.id));
    });
  }
}

function bindSurfaceProbe(config: SurfaceProbeConfig): void {
  const seg = document.querySelector(config.segSelector);
  if (!seg) return;

  const cli = document.getElementById(config.cliRadioId) as HTMLInputElement | null;
  const web = document.getElementById(config.webRadioId) as HTMLInputElement | null;
  if (!cli || !web) return;

  const currentPath = globalThis.location?.pathname ?? '';
  const onCli = config.isOnCli(currentPath);
  const onWeb = config.isOnWeb(currentPath);

  for (const radio of [cli, web]) {
    radio.addEventListener('change', () => {
      if (!radio.checked) return;
      const next = surfaceFromRadioId(radio.id, config.webRadioId);
      const staying = (onCli && next === 'cli') || (onWeb && next === 'web');
      if (staying) return;
      setSurface(next);
      globalThis.location.assign(config.peerHref(next));
    });
  }
}

const BOARD_PROBE: SurfaceProbeConfig = {
  segSelector: '[data-surface-board-seg]',
  cliRadioId: 'board-s-cli',
  webRadioId: 'board-s-web',
  isOnCli: (path) => path === CLI_BOARD_HREF || path.startsWith('/score/'),
  isOnWeb: (path) => path === WEB_BOARD_HREF || (path.startsWith('/web/') && !path.startsWith('/web-audit')),
  peerHref: (surface) => (surface === 'web' ? WEB_BOARD_HREF : CLI_BOARD_HREF),
};

const AUDIT_PROBE: SurfaceProbeConfig = {
  segSelector: '[data-surface-audit-seg]',
  cliRadioId: 'audit-s-cli',
  webRadioId: 'audit-s-web',
  isOnCli: (path) => path === CLI_AUDIT_HREF,
  isOnWeb: (path) => path === WEB_AUDIT_HREF || path.startsWith('/web-audit/'),
  peerHref: (surface) => (surface === 'web' ? WEB_AUDIT_HREF : CLI_AUDIT_HREF),
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
