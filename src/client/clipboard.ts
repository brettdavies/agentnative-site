// Click-to-copy for <pre> code blocks and heading permalinks. docs/DESIGN.md
// §4.6 + §4.10. Navigator.clipboard with a document.execCommand fallback.
// Buttons are added client-side so the no-JS case is a clean render with
// no dead controls (docs/DESIGN.md §4.8 C6).

const COPIED_MS = 1500;

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Legacy fallback — works in http://, iframes without clipboard-write,
    // and older browsers.
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

function flashCopied(button: HTMLElement) {
  const label = button.querySelector<HTMLElement>('[data-copy-label]') ?? button;
  const original = label.textContent ?? '';
  label.textContent = 'Copied';
  button.setAttribute('data-copy-state', 'copied');
  window.setTimeout(() => {
    label.textContent = original;
    button.removeAttribute('data-copy-state');
  }, COPIED_MS);
}

function attachPreButtons() {
  const pres = document.querySelectorAll<HTMLPreElement>('main pre');
  for (const pre of pres) {
    if (pre.dataset.copyAttached === 'true') continue;

    // Wrap the pre in a positioning container BEFORE attaching the copy
    // button. The pre keeps `overflow-x: auto` for its code; the button
    // anchors against the wrapper, which is non-scrolling. Otherwise an
    // `position: absolute` button inside an overflowing pre moves WITH the
    // scrolled content (since absolute children of a scrolling container
    // resolve `right: 0` against the scrolled content box, not the visible
    // padding box).
    const parent = pre.parentNode;
    if (!parent) continue;
    const wrap = document.createElement('div');
    wrap.className = 'code-wrap';
    parent.insertBefore(wrap, pre);
    wrap.appendChild(pre);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'copy-button';
    btn.setAttribute('aria-label', 'Copy code');
    btn.innerHTML = '<span data-copy-label>Copy</span>';
    btn.addEventListener('click', async () => {
      const code = pre.querySelector('code')?.textContent ?? pre.textContent ?? '';
      if (await copyText(code)) flashCopied(btn);
    });
    wrap.appendChild(btn);
    pre.dataset.copyAttached = 'true';
  }
}

function attachAnchorCopy() {
  const anchors = document.querySelectorAll<HTMLAnchorElement>('main a.anchor');
  for (const anchor of anchors) {
    if (anchor.dataset.copyAttached === 'true') continue;
    anchor.addEventListener('click', async (event) => {
      // Shift-click / middle-click / modifier keys → let the browser handle
      // the default link behavior.
      const me = event as MouseEvent;
      if (me.metaKey || me.ctrlKey || me.shiftKey || me.altKey || me.button !== 0) return;
      event.preventDefault();
      const href = anchor.getAttribute('href') ?? '';
      const url = new URL(href, window.location.href).toString();
      history.replaceState(null, '', href);
      if (await copyText(url)) flashCopied(anchor);
    });
    anchor.dataset.copyAttached = 'true';
  }
}

function init() {
  attachPreButtons();
  attachAnchorCopy();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
