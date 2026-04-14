// Theme toggle — three states (light / dark / system). docs/DESIGN.md §4.9.
//
// Markup (emitted by the build shell):
//   <div class="theme-toggle" role="group" aria-label="Theme">
//     <button data-theme-set="light"  aria-pressed="false">Light</button>
//     <button data-theme-set="dark"   aria-pressed="false">Dark</button>
//     <button data-theme-set="system" aria-pressed="true" >System</button>
//   </div>
//
// Behavior:
//   - Click a button → set localStorage['theme'] and <html data-theme>.
//   - "System" clears localStorage and removes data-theme, reverting to
//     prefers-color-scheme.
//   - aria-pressed reflects the active state; exactly one button is
//     pressed at a time.
//   - matchMedia listener updates aria-pressed on the system button when
//     OS preference flips while system is active (no layout change —
//     CSS already responds — just keeps ARIA honest).

type ThemeChoice = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'theme';
const BUTTON_SELECTOR = '[data-theme-set]';

function currentChoice(): ThemeChoice {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    // localStorage unavailable — fall through.
  }
  return 'system';
}

function applyChoice(choice: ThemeChoice) {
  const root = document.documentElement;
  try {
    if (choice === 'system') {
      localStorage.removeItem(STORAGE_KEY);
      root.removeAttribute('data-theme');
    } else {
      localStorage.setItem(STORAGE_KEY, choice);
      root.setAttribute('data-theme', choice);
    }
  } catch {
    // localStorage blocked. Still update the DOM so the current session
    // reflects the click, even if preference won't persist.
    if (choice === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', choice);
  }
}

function refreshPressed(choice: ThemeChoice) {
  const buttons = document.querySelectorAll<HTMLButtonElement>(BUTTON_SELECTOR);
  for (const btn of buttons) {
    const match = btn.dataset.themeSet === choice;
    btn.setAttribute('aria-pressed', String(match));
  }
}

function init() {
  const buttons = document.querySelectorAll<HTMLButtonElement>(BUTTON_SELECTOR);
  if (buttons.length === 0) return;

  refreshPressed(currentChoice());

  for (const btn of buttons) {
    btn.addEventListener('click', () => {
      const choice = (btn.dataset.themeSet as ThemeChoice) ?? 'system';
      applyChoice(choice);
      refreshPressed(choice);
    });
  }

  // Keep aria-pressed honest when the system preference flips during an
  // active "system" session.
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const listener = () => {
    if (currentChoice() === 'system') refreshPressed('system');
  };
  media.addEventListener?.('change', listener);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
