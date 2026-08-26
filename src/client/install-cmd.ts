// Header install-command pill. Copies brew / cargo install / cargo binstall
// in one click; package-manager preference is random on first visit, then
// persisted. Command strings arrive via data-brew / data-cargo / data-binstall
// on [data-install-cmd] (emitted from content/install.md at build time —
// do not hardcode here).

export type InstallPm = 'brew' | 'cargo' | 'binstall';

export const STORAGE_KEY = 'anc-install-pm';

export const INSTALL_PMS: readonly InstallPm[] = ['brew', 'cargo', 'binstall'];

const PM_LABEL: Record<InstallPm, string> = {
  brew: 'brew',
  cargo: 'cargo',
  binstall: 'binstall',
};

const PM_ARIA: Record<InstallPm, string> = {
  brew: 'Homebrew',
  cargo: 'cargo install',
  binstall: 'cargo binstall',
};

const DATA_ATTR: Record<InstallPm, string> = {
  brew: 'data-brew',
  cargo: 'data-cargo',
  binstall: 'data-binstall',
};

export function isInstallPm(value: string | null | undefined): value is InstallPm {
  return value === 'brew' || value === 'cargo' || value === 'binstall';
}

export function resolvePm(stored: string | null, random: () => number = Math.random): InstallPm {
  if (isInstallPm(stored)) return stored;
  const idx = Math.min(INSTALL_PMS.length - 1, Math.floor(random() * INSTALL_PMS.length));
  return INSTALL_PMS[idx];
}

export function nextPm(current: InstallPm): InstallPm {
  const i = INSTALL_PMS.indexOf(current);
  return INSTALL_PMS[(i + 1) % INSTALL_PMS.length];
}

export function readStoredPm(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function writeStoredPm(pm: InstallPm): void {
  try {
    localStorage.setItem(STORAGE_KEY, pm);
  } catch {
    // private mode / blocked storage — session still updates in DOM
  }
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'absolute';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    document.body.removeChild(ta);
    return ok;
  }
}

const COPIED_MS = 1500;

function flashCopied(host: HTMLElement) {
  const label = host.querySelector<HTMLElement>('[data-copy-label]');
  if (!label) {
    host.setAttribute('data-copy-state', 'copied');
    window.setTimeout(() => host.removeAttribute('data-copy-state'), COPIED_MS);
    return;
  }
  const original = label.textContent ?? '';
  label.textContent = 'Copied';
  host.setAttribute('data-copy-state', 'copied');
  window.setTimeout(() => {
    label.textContent = original;
    host.removeAttribute('data-copy-state');
  }, COPIED_MS);
}

function commandFor(pm: InstallPm, root: HTMLElement): string {
  return root.getAttribute(DATA_ATTR[pm]) ?? '';
}

function paint(root: HTMLElement, pm: InstallPm) {
  const cmd = commandFor(pm, root);
  const text = root.querySelector<HTMLElement>('[data-install-text]');
  const copyBtn = root.querySelector<HTMLButtonElement>('[data-install-copy]');
  const pmBtn = root.querySelector<HTMLButtonElement>('[data-install-pm]');
  if (text) text.textContent = cmd;
  if (copyBtn) {
    copyBtn.setAttribute('aria-label', `Copy command: ${cmd}`);
    copyBtn.title = cmd;
  }
  if (pmBtn) {
    const upcoming = nextPm(pm);
    const label = pmBtn.querySelector<HTMLElement>('[data-install-pm-label]');
    if (label) label.textContent = PM_LABEL[pm];
    else pmBtn.textContent = PM_LABEL[pm];
    pmBtn.setAttribute('aria-label', `Install via ${PM_ARIA[pm]}. Click to switch to ${PM_ARIA[upcoming]}.`);
    // Native hover tip; aria-label stays the fuller SR string above.
    pmBtn.title = 'Click to change PM';
    pmBtn.dataset.pm = pm;
  }
  root.dataset.pm = pm;
}

export function attachInstallCmd(doc: Document = document): void {
  const root = doc.querySelector<HTMLElement>('[data-install-cmd]');
  if (!root || root.dataset.installAttached === 'true') return;
  if (!root.getAttribute('data-brew') || !root.getAttribute('data-cargo') || !root.getAttribute('data-binstall')) {
    return;
  }

  const pm = resolvePm(readStoredPm());
  writeStoredPm(pm);
  paint(root, pm);
  root.hidden = false;
  root.dataset.installAttached = 'true';

  const pmBtn = root.querySelector<HTMLButtonElement>('[data-install-pm]');
  const copyBtn = root.querySelector<HTMLButtonElement>('[data-install-copy]');

  pmBtn?.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const current = isInstallPm(root.dataset.pm) ? root.dataset.pm : 'brew';
    const next = nextPm(current);
    writeStoredPm(next);
    paint(root, next);
  });

  copyBtn?.addEventListener('click', async () => {
    const current = isInstallPm(root.dataset.pm) ? root.dataset.pm : 'brew';
    const cmd = commandFor(current, root);
    if (cmd && (await copyText(cmd))) flashCopied(copyBtn);
  });
}
