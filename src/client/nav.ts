// Nav panel enhancement. The mobile hamburger is a CSS checkbox — pointer
// taps and keyboard Space toggle it with zero JS. This adds the one path
// CSS can't express: Escape closes the open panel and returns focus to
// the hamburger control.

const CHECKBOX_SELECTOR = '.nav-burger__cb';

function init() {
  const checkbox = document.querySelector<HTMLInputElement>(CHECKBOX_SELECTOR);
  if (!checkbox) return;

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !checkbox.checked) return;
    checkbox.checked = false;
    checkbox.focus();
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
