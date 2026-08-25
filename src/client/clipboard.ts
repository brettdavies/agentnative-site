// Click-to-copy for <pre> code blocks and heading permalinks. docs/DESIGN.md
// §4.6 + §4.10. Navigator.clipboard with a document.execCommand fallback.
// Buttons are added client-side so the no-JS case is a clean render with
// no dead controls (docs/DESIGN.md §4.8 C6).

import { carriersFromElements, selectAssemblePrompts } from './assemble-prompt';

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
  // Heading anchors hold an inline SVG icon as their only child — they have
  // no [data-copy-label] span and no text content. Snapshot innerHTML in that
  // case so the icon DOM is restored after the fade. Pre-block buttons keep
  // the textContent path because their label is a real text node.
  const isIconLabel = label === button && (label.textContent ?? '').trim() === '';
  const original = isIconLabel ? label.innerHTML : (label.textContent ?? '');
  label.textContent = 'Copied';
  button.setAttribute('data-copy-state', 'copied');
  window.setTimeout(() => {
    if (isIconLabel) {
      label.innerHTML = original;
    } else {
      label.textContent = original;
    }
    button.removeAttribute('data-copy-state');
  }, COPIED_MS);
}

function attachPreButtons() {
  const pres = document.querySelectorAll<HTMLPreElement>('main pre');
  for (const pre of pres) {
    if (pre.dataset.copyAttached === 'true') continue;
    // Remediation prompts have their own header copy-prompt button.
    if (pre.matches('.remediation__body')) continue;

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

function attachPromptButtons() {
  const buttons = document.querySelectorAll<HTMLButtonElement>('[data-copy-prompt]');
  for (const btn of buttons) {
    if (btn.dataset.copyAttached === 'true') continue;
    btn.addEventListener('click', async () => {
      const prompt = btn.closest('.remediation')?.querySelector('[data-remediation-prompt]')?.textContent ?? '';
      if (prompt && (await copyText(prompt))) flashCopied(btn);
    });
    btn.dataset.copyAttached = 'true';
  }
}

// Copy-without-render: a hidden `[data-copy-text]` carrier holds a prompt
// that is never in the visible DOM. The button is attached client-side, so
// a no-JS render shows no dead control (the prose + resource links are the
// no-JS affordance). Used by web-audit result pages and fix-skill pages.
function attachDataButtons() {
  const carriers = document.querySelectorAll<HTMLElement>('[data-copy-text]');
  for (const carrier of carriers) {
    if (carrier.dataset.copyAttached === 'true') continue;
    const text = carrier.getAttribute('data-copy-text') ?? '';
    if (!text) continue;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'copy-button copy-button--prompt';
    btn.setAttribute('aria-label', 'Copy the fix prompt for your coding agent');
    btn.innerHTML = '<span data-copy-label>Copy prompt</span>';
    btn.addEventListener('click', async () => {
      if (await copyText(text)) flashCopied(btn);
    });
    carrier.after(btn);
    carrier.dataset.copyAttached = 'true';
  }
}

function attachAssemblePrompt() {
  const page = document.querySelector('.scorecard-page[data-web-audit-result]');
  const hero = page?.querySelector('.scorecard-hero');
  if (!page || !hero || page.querySelector('[data-assemble-prompt]')) return;

  const carriers = carriersFromElements(page.querySelectorAll('[data-copy-text][data-keyword]'));
  if (carriers.length === 0) return;
  const section = document.createElement('section');
  section.className = 'assemble-prompt';
  section.setAttribute('data-assemble-prompt', '');
  section.setAttribute('aria-label', 'Assemble fix prompts');

  const heading = document.createElement('h2');
  heading.className = 'assemble-prompt__title';
  heading.textContent = 'Assemble fix prompts';

  const lede = document.createElement('p');
  lede.className = 'assemble-prompt__lede';
  lede.textContent =
    'Copies MUST failures (broken or missing) in page order. SHOULD and MAY are opt-in and stay off unless you enable them.';

  const opts = document.createElement('div');
  opts.className = 'assemble-prompt__opts';

  const shouldLabel = document.createElement('label');
  shouldLabel.className = 'assemble-prompt__opt';
  const shouldBox = document.createElement('input');
  shouldBox.type = 'checkbox';
  shouldBox.setAttribute('data-assemble-should', '');
  shouldLabel.append(shouldBox, document.createTextNode(' Include SHOULD'));

  const mayLabel = document.createElement('label');
  mayLabel.className = 'assemble-prompt__opt';
  const mayBox = document.createElement('input');
  mayBox.type = 'checkbox';
  mayBox.setAttribute('data-assemble-may', '');
  mayLabel.append(mayBox, document.createTextNode(' Include MAY'));
  opts.append(shouldLabel, mayLabel);

  const status = document.createElement('p');
  status.className = 'assemble-prompt__status';
  status.setAttribute('data-assemble-status', '');

  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'btn btn--primary';
  copyBtn.setAttribute('data-assemble-copy', '');
  copyBtn.innerHTML = '<span data-copy-label>Copy assembled prompt</span>';

  let assembled = '';
  const refresh = () => {
    assembled = selectAssemblePrompts(carriers, {
      includeShould: shouldBox.checked,
      includeMay: mayBox.checked,
    });
    const emptyMust = selectAssemblePrompts(carriers, { includeShould: false, includeMay: false }).length === 0;
    if (assembled.length === 0) {
      status.textContent = emptyMust
        ? 'No MUST failures. Enable SHOULD or MAY to include those tiers.'
        : 'No failures in the selected tiers.';
      copyBtn.disabled = true;
    } else {
      status.textContent = '';
      copyBtn.disabled = false;
    }
  };

  copyBtn.addEventListener('click', async () => {
    if (assembled.length === 0) return;
    if (await copyText(assembled)) flashCopied(copyBtn);
  });
  shouldBox.addEventListener('change', refresh);
  mayBox.addEventListener('change', refresh);

  section.append(heading, lede, opts, status, copyBtn);
  hero.after(section);
  refresh();
}

function init() {
  attachPreButtons();
  attachAnchorCopy();
  attachPromptButtons();
  attachDataButtons();
  attachAssemblePrompt();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
