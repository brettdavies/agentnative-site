// Inline <head> script — runs synchronously BEFORE paint so a returning
// visitor is not shown the CLI board and then swapped off it.
//
// The pane radios live in the body and have not parsed when this runs, so the
// stored surface rides on <html> and the CSS answers that attribute. Once
// surface.ts has checked the matching radio it removes the attribute, leaving
// the :has() rules the single authority: while both are set they agree, and a
// later CLI selection would otherwise be overruled by a stale attribute.
//
// A `?lane=` in the URL wins outright. The Worker has already checked the
// radio that names, and an explicit link beats a remembered preference.
//
// Size budget: ≤ 500 bytes minified. Inlined into the leaderboard shell only.

(() => {
  try {
    if (new URLSearchParams(location.search).has('lane')) return;
    if (localStorage.getItem('anc-surface') === 'web') {
      document.documentElement.dataset.surface = 'web';
    }
  } catch {
    // Storage blocked (privacy mode, sandboxed iframe): the CLI default stands.
  }
})();

export {};
