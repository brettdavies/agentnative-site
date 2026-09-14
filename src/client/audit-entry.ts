// The entry form's client on `/` and `/audit`: one form, two lanes, one
// transact click.
//
//   load ........ prefill the lane and the target from ?lane=&target= (the
//                 no-JS submit and a WebMCP hop both land here)
//   first touch . load Turnstile, so a visitor who only scrolls never does
//   chip ........ fill the target, on the lane the chip belongs to
//   submit ...... validate for the lane; flip the segment when the target's
//                 shape is the other lane's; startAudit acquires the token on
//                 this click, stashes it, and navigates to the progress page
//
// The submit is aria-disabled while acquiring, never disabled, so it keeps
// its focus. Without a sitekey the form cannot transact: it says so and
// points at the MCP tools and `anc audit`. A flip sets the radio without a
// change event, so only the visitor's own gesture writes the saved surface.

import { classifyTarget, type Lane } from '../shared/audit-routes';
import { startAudit } from './audit-start';
import { loadTurnstileOnFirstInteraction, readSitekey } from './turnstile';

const PLACEHOLDER_CLI = 'ripgrep';

type EntryElements = {
  form: HTMLFormElement;
  input: HTMLInputElement;
  submit: HTMLButtonElement;
  listing: HTMLInputElement | null;
  status: HTMLElement | null;
  radios: HTMLInputElement[];
  chips: HTMLButtonElement[];
};

function find(form: HTMLFormElement): EntryElements | null {
  const input = form.querySelector<HTMLInputElement>('[data-audit-target]');
  const submit = form.querySelector<HTMLButtonElement>('[data-audit-submit]');
  if (!input || !submit) return null;
  return {
    form,
    input,
    submit,
    listing: form.querySelector<HTMLInputElement>('[data-audit-listing]'),
    status: form.querySelector<HTMLElement>('[data-audit-status]'),
    radios: [...form.querySelectorAll<HTMLInputElement>('input[name="lane"]')],
    chips: [...form.querySelectorAll<HTMLButtonElement>('[data-audit-example]')],
  };
}

function isLane(value: string | null | undefined): value is Lane {
  return value === 'cli' || value === 'web';
}

/**
 * The listing decision a submit carries, or null when the visitor never saw
 * the box: it lives in the website pane, so a target's shape flipping the lane
 * leaves its unchecked state meaning nothing. Null omits the field, which
 * leaves whatever listing the site already has alone.
 */
export function listingChoice(entered: Lane, resolved: Lane, checked: boolean | null): boolean | null {
  return entered === 'web' && resolved === 'web' ? checked : null;
}

function bind(el: EntryElements): void {
  const lane = (): Lane => (el.radios.find((r) => r.checked)?.value === 'web' ? 'web' : 'cli');
  const placeholder = (): void => {
    el.input.placeholder = lane() === 'web' ? (el.input.dataset.placeholderWeb ?? '') : PLACEHOLDER_CLI;
  };
  const setLane = (next: Lane): void => {
    const radio = el.radios.find((r) => r.value === next);
    if (radio) radio.checked = true;
    placeholder();
  };
  const say = (text: string): void => {
    if (!el.status) return;
    // Unhide before writing: text written into a hidden live region is
    // announced inconsistently across screen readers.
    el.status.hidden = text.length === 0;
    el.status.textContent = text;
  };

  for (const radio of el.radios) radio.addEventListener('change', placeholder);

  const params = new URLSearchParams(window.location.search);
  const requestedLane = params.get('lane');
  if (isLane(requestedLane)) setLane(requestedLane);
  const requestedTarget = params.get('target');
  if (requestedTarget && !el.input.value) el.input.value = requestedTarget;
  placeholder();

  for (const chip of el.chips) {
    chip.addEventListener('click', () => {
      el.input.value = chip.dataset.auditExample ?? '';
      const pane = chip.closest<HTMLElement>('[data-s]')?.dataset.s;
      if (isLane(pane)) setLane(pane);
      el.input.focus();
    });
  }

  const sitekey = readSitekey();
  if (!sitekey) {
    el.submit.setAttribute('aria-disabled', 'true');
    say('Live audits are not available on this host. Call the MCP tools at /mcp, or run anc audit locally.');
  } else {
    loadTurnstileOnFirstInteraction([el.input, el.submit, ...el.chips]);
  }

  // A page restored from the back-forward cache keeps the acquiring state.
  window.addEventListener('pageshow', (event) => {
    if (!event.persisted || !sitekey) return;
    el.submit.removeAttribute('aria-disabled');
    say('');
  });

  el.form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (el.submit.getAttribute('aria-disabled') === 'true') return;
    const entered = lane();
    const classified = classifyTarget(el.input.value);
    if (!classified.ok) {
      say(classified.message);
      el.input.focus();
      return;
    }
    if (classified.lane !== entered) setLane(classified.lane);
    const listing = listingChoice(entered, classified.lane, el.listing ? el.listing.checked : null);
    el.submit.setAttribute('aria-disabled', 'true');
    say('Verifying…');
    void startAudit({ target: el.input.value, lane: entered, listing }).then((result) => {
      if (result.ok) return;
      el.submit.removeAttribute('aria-disabled');
      say(result.message);
    });
  });
}

function init(): void {
  for (const form of document.querySelectorAll<HTMLFormElement>('[data-audit-form]')) {
    const el = find(form);
    if (el) bind(el);
  }
}

// Guarded so the module's helpers can be imported outside a browser.
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
}
