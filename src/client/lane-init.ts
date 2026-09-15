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
// Inlined into the leaderboard shell only, where it bundles to roughly 800
// bytes. Most of that is the bundler's module preamble rather than the logic
// below, and no check enforces a ceiling on it.

(() => {
  const html = document.documentElement;
  // surface.ts clears the attribute once a radio carries the surface. Should
  // its bundle never run, the attribute would keep every CLI pane hidden for
  // good, so the script that set it also takes it back. It no-ops when the
  // attribute is already gone, which is what keeps it from re-checking the
  // website radio over a reader who has since chosen CLI.
  const retire = () => {
    if (html.dataset.surface !== 'web') return;
    const web = document.getElementById('s-web') as HTMLInputElement | null;
    if (web) web.checked = true;
    delete html.dataset.surface;
  };
  try {
    if (new URLSearchParams(location.search).has('lane')) return;
    if (localStorage.getItem('anc-surface') === 'web') {
      html.dataset.surface = 'web';
      document.addEventListener('DOMContentLoaded', retire, { once: true });
    }
  } catch {
    // Storage blocked (privacy mode, sandboxed iframe): the CLI default stands.
  }
})();

export {};
