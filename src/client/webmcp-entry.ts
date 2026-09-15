// The audit entry form's in-page tools, registered on both pages that
// render it. Every tool prepares the form and stops there: the audit needs
// a human click, so nothing here spends a Turnstile token, posts to the
// transact endpoint, or reaches the progress page. `open_audit` submits the
// form's own GET, whose only effect is to reload the audit page prefilled.
//
// The lane a target belongs to comes from the shared classifier, so a tool
// that fills `anc.dev` selects Website for the same reason the submit
// handler would.

import { AUDIT_PATH, type Lane, laneOf } from '../shared/audit-routes';
import { capExecute, pageDoc, type ToolsForOpts, type WebMcpTool } from './webmcp-lib';

const ENTRY_PAGES = 'the homepage or the audit page';

const CLICK_AUDIT = 'A human must click Audit.';

function laneRadio(doc: Document, lane: Lane): HTMLInputElement | null {
  return doc.getElementById(lane === 'web' ? 's-web' : 's-cli') as HTMLInputElement | null;
}

export function setSurface(doc: Document, input: Record<string, unknown>): string {
  const surface = input.surface;
  if (surface !== 'cli' && surface !== 'web') return 'surface must be "cli" or "web".';
  const target = laneRadio(doc, surface);
  const other = laneRadio(doc, surface === 'web' ? 'cli' : 'web');
  if (!target || !other) return `set_surface is only available on ${ENTRY_PAGES}.`;
  target.checked = true;
  other.checked = false;
  target.dispatchEvent(new Event('change', { bubbles: true }));
  return `Surface set to ${surface}.`;
}

export function fillTarget(doc: Document, input: Record<string, unknown>): string {
  if (typeof input.target !== 'string' || input.target.length === 0) {
    return 'target must be a non-empty string.';
  }
  const lane = input.lane;
  if (lane !== undefined && lane !== 'cli' && lane !== 'web') return 'lane must be "cli" or "web".';
  const el = doc.querySelector('[data-audit-target]') as HTMLInputElement | null;
  if (!el) return `fill_target is only available on ${ENTRY_PAGES}.`;
  el.value = input.target;
  // Selecting the radio without its change event leaves the surface panes
  // alone: a fill states what the target is, it does not switch the page.
  const resolved: Lane = lane ?? laneOf(input.target) ?? 'cli';
  const radio = laneRadio(doc, resolved);
  if (radio) radio.checked = true;
  return `Filled the ${resolved === 'web' ? 'website' : 'CLI'} target. ${CLICK_AUDIT}`;
}

/**
 * Hop to the audit page with the form prefilled. The form's own action is a
 * GET to the audit page, so submitting it navigates and nothing else; the
 * action is re-read here so a form that was repointed cannot turn this into
 * a transacting submit.
 */
export function openAudit(doc: Document, input: Record<string, unknown>): string {
  if (input.target !== undefined) {
    const filled = fillTarget(doc, input);
    if (!filled.startsWith('Filled')) return filled;
  }
  const form = doc.querySelector('[data-audit-form]') as HTMLFormElement | null;
  if (!form) return `open_audit is only available on ${ENTRY_PAGES}.`;
  if (form.getAttribute('action') !== AUDIT_PATH) {
    return `open_audit only submits a form whose action is ${AUDIT_PATH}.`;
  }
  form.submit();
  return `Opening the audit page with the form prefilled. ${CLICK_AUDIT}`;
}

export function entryTools(opts: ToolsForOpts): WebMcpTool[] {
  return [
    {
      name: 'set_surface',
      description:
        'Switch the entry form and the page between CLI and Website. Checks the radio and dispatches change, which also stores the surface as this browser preference, so the site navigation follows it afterwards.',
      inputSchema: {
        type: 'object',
        properties: { surface: { type: 'string', enum: ['cli', 'web'] } },
        required: ['surface'],
        additionalProperties: false,
      },
      execute(input) {
        return capExecute(setSurface(pageDoc(opts), input));
      },
    },
    {
      name: 'fill_target',
      description: `Fill the entry form's one target field with a CLI tool, install command, GitHub URL, or website, and select the lane it belongs to. Does not submit. ${CLICK_AUDIT}`,
      inputSchema: {
        type: 'object',
        properties: {
          target: { type: 'string' },
          lane: { type: 'string', enum: ['cli', 'web'] },
        },
        required: ['target'],
        additionalProperties: false,
      },
      execute(input) {
        return capExecute(fillTarget(pageDoc(opts), input));
      },
    },
    {
      name: 'open_audit',
      description: `Optionally fill the target, then submit the entry form's GET, which only reloads the audit page prefilled. Does not run the audit. ${CLICK_AUDIT}`,
      inputSchema: {
        type: 'object',
        properties: {
          target: { type: 'string' },
          lane: { type: 'string', enum: ['cli', 'web'] },
        },
        additionalProperties: false,
      },
      execute(input) {
        return capExecute(openAudit(pageDoc(opts), input));
      },
    },
  ];
}
