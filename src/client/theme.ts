// Theme button — one control, three states (light / dark / system).
// docs/DESIGN.md §4.9.
//
// Markup (emitted by the build shell):
//   <button class="theme-cycle" data-theme-cycle aria-label="Theme: system">◐</button>
//
// Behavior:
//   - Click cycles system → light → dark → system.
//   - light/dark set localStorage['theme'] and <html data-theme>; system
//     clears both, reverting to prefers-color-scheme.
//   - aria-label and data-theme-choice reflect the active state so
//     assistive tech (and e2e) can read the current choice.

type ThemeChoice = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'theme';
const BUTTON_SELECTOR = '[data-theme-cycle]';
const CYCLE: ThemeChoice[] = ['system', 'light', 'dark'];

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

function refreshButton(btn: HTMLButtonElement, choice: ThemeChoice) {
  btn.setAttribute('aria-label', `Theme: ${choice}`);
  btn.dataset.themeChoice = choice;
}

function init() {
  const buttons = document.querySelectorAll<HTMLButtonElement>(BUTTON_SELECTOR);
  if (buttons.length === 0) return;

  const refreshAll = (choice: ThemeChoice) => {
    for (const btn of buttons) refreshButton(btn, choice);
  };
  refreshAll(currentChoice());

  for (const btn of buttons) {
    btn.addEventListener('click', () => {
      const next = CYCLE[(CYCLE.indexOf(currentChoice()) + 1) % CYCLE.length];
      applyChoice(next);
      refreshAll(next);
    });
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}

export {};
