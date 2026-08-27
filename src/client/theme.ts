// Theme button — one control, two states (light / dark).
// docs/DESIGN.md §4.9 (binary toggle; system preference is the unset default).
//
// Markup (emitted by the build shell):
//   <button class="theme-cycle" data-theme-cycle aria-label="Toggle theme">◐</button>
//
// Behavior:
//   - With no localStorage preference, the effective theme follows
//     prefers-color-scheme (CSS media query; no data-theme on <html>).
//   - The button label reflects that resolved light/dark value.
//   - Click always writes the opposite (light ↔ dark) to localStorage and
//     sets <html data-theme>. There is no third "system" stop in the cycle.
//   - aria-label and data-theme-choice stay in sync for assistive tech + e2e.

export type ThemeChoice = 'light' | 'dark';

const STORAGE_KEY = 'theme';
const BUTTON_SELECTOR = '[data-theme-cycle]';

function systemPrefersDark(): boolean {
  try {
    const media = globalThis.matchMedia?.('(prefers-color-scheme: dark)');
    return Boolean(media?.matches);
  } catch {
    return false;
  }
}

/** Stored preference, or OS preference when unset. Never returns "system". */
export function effectiveTheme(): ThemeChoice {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    // localStorage unavailable — fall through to OS.
  }
  return systemPrefersDark() ? 'dark' : 'light';
}

export function oppositeTheme(choice: ThemeChoice): ThemeChoice {
  return choice === 'dark' ? 'light' : 'dark';
}

function applyChoice(choice: ThemeChoice) {
  const root = document.documentElement;
  try {
    localStorage.setItem(STORAGE_KEY, choice);
    root.setAttribute('data-theme', choice);
  } catch {
    // localStorage blocked. Still update the DOM for this session.
    root.setAttribute('data-theme', choice);
  }
}

function refreshButton(btn: HTMLButtonElement, choice: ThemeChoice) {
  const next = oppositeTheme(choice);
  btn.setAttribute('aria-label', `Theme: ${choice}. Click for ${next}.`);
  btn.title = `Switch to ${next}`;
  btn.dataset.themeChoice = choice;
}

function init() {
  const buttons = document.querySelectorAll<HTMLButtonElement>(BUTTON_SELECTOR);
  if (buttons.length === 0) return;

  const refreshAll = (choice: ThemeChoice) => {
    for (const btn of buttons) refreshButton(btn, choice);
  };
  refreshAll(effectiveTheme());

  for (const btn of buttons) {
    btn.addEventListener('click', () => {
      const next = oppositeTheme(effectiveTheme());
      applyChoice(next);
      refreshAll(next);
    });
  }
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
}
