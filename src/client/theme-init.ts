// Inline <head> script — runs synchronously BEFORE paint to avoid a
// flash of incorrect theme (FOUC). Two jobs:
//
//   1. Apply the persisted theme preference from localStorage to <html>.
//      If none set, leave `data-theme` off and let prefers-color-scheme
//      drive via CSS.
//   2. Add `.js` to <html> class list so the progressive-enhancement CSS
//      rule `:root:not(.js) .theme-toggle { display: none }` unhides the
//      toggle buttons (DESIGN.md §4.8 C6).
//
// Size budget: ≤ 500 bytes minified. Inlined into every HTML shell head.

(() => {
  const root = document.documentElement;
  root.classList.add('js');
  try {
    const saved = localStorage.getItem('theme');
    if (saved === 'light' || saved === 'dark') {
      root.setAttribute('data-theme', saved);
    }
  } catch {
    // localStorage may be blocked (privacy mode, iframe sandbox). Silent
    // fallback to OS preference is the right behavior here.
  }
})();
