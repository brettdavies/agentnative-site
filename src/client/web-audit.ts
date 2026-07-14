// Web-audit form client. Validates the input, extracts the host, and
// navigates to the /web/scoring/<host> in-progress page, which acquires a
// Turnstile token, runs the audit, and streams results. The form page stays
// in history (location.href, not replace) so the back button from the
// result page returns here.

function q<T extends Element>(root: ParentNode, sel: string): T | null {
  return root.querySelector<T>(sel);
}

/** Extract the host from a raw URL or bare domain, mirroring the server's coerceUrl. */
function hostOf(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    return new URL(candidate).host || null;
  } catch {
    return null;
  }
}

function init(): void {
  const form = q<HTMLFormElement>(document, '[data-web-audit-form]');
  if (!form) return;
  const scope = (form.closest('[data-web-audit-section]') as HTMLElement | null) ?? document.body;
  const input = q<HTMLInputElement>(form, '[data-web-audit-input]');
  const submit = q<HTMLButtonElement>(form, '[data-web-audit-submit]');
  const status = q<HTMLElement>(scope, '[data-web-audit-status]');
  if (!input || !submit) return;

  for (const chip of scope.querySelectorAll<HTMLButtonElement>('[data-web-audit-example]')) {
    chip.addEventListener('click', () => {
      input.value = chip.dataset.webAuditExample ?? '';
      input.focus();
    });
  }

  // Prefill from ?url= — the homepage's web try-form navigates here as a
  // plain GET so the toggle keeps working without JS.
  const requested = new URL(window.location.href).searchParams.get('url');
  if (requested && !input.value) {
    input.value = requested;
    input.focus();
  }

  const setStatus = (text: string): void => {
    if (!status) return;
    status.textContent = text;
    status.hidden = text.length === 0;
  };

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const host = hostOf(input.value);
    if (!host) {
      setStatus('Enter a valid website URL or domain.');
      return;
    }
    submit.disabled = true;
    setStatus('Starting audit…');
    window.location.href = `/web/scoring/${host}`;
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
