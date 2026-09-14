import { capExecute, pageDoc, type ToolsForOpts, type WebMcpTool } from './webmcp-lib';

const ENTRY_PAGES = 'the homepage or the audit page';

export function setSurface(doc: Document, input: Record<string, unknown>): string {
  const surface = input.surface;
  if (surface !== 'cli' && surface !== 'web') return 'surface must be "cli" or "web".';
  const cli = doc.getElementById('s-cli') as HTMLInputElement | null;
  const web = doc.getElementById('s-web') as HTMLInputElement | null;
  if (!cli || !web) return `set_surface is only available on ${ENTRY_PAGES}.`;
  const target = surface === 'web' ? web : cli;
  const other = surface === 'web' ? cli : web;
  target.checked = true;
  other.checked = false;
  target.dispatchEvent(new Event('change', { bubbles: true }));
  return `Surface set to ${surface}.`;
}

// Fill the entry form's one target input and select the lane it belongs
// to, without the change event a visitor's own gesture sends.
function fillTarget(doc: Document, value: string, lane: 'cli' | 'web'): boolean {
  const el = doc.querySelector('[data-audit-target]') as HTMLInputElement | null;
  if (!el) return false;
  el.value = value;
  const radio = doc.getElementById(lane === 'web' ? 's-web' : 's-cli') as HTMLInputElement | null;
  if (radio) radio.checked = true;
  return true;
}

export function fillCliTarget(doc: Document, input: Record<string, unknown>): string {
  if (typeof input.text !== 'string') return 'text must be a string.';
  if (!fillTarget(doc, input.text, 'cli')) return `fill_cli_target is only available on ${ENTRY_PAGES}.`;
  return 'Filled CLI target. Human must click Audit.';
}

export function fillWebTarget(doc: Document, input: Record<string, unknown>): string {
  if (typeof input.url !== 'string') return 'url must be a string.';
  if (!fillTarget(doc, input.url, 'web')) return `fill_web_target is only available on ${ENTRY_PAGES}.`;
  return 'Filled website URL. Human must click Audit.';
}

// The form's native action is a GET that only prefills the audit page, so
// this hop never transacts; the audit itself still needs a human click.
export function openWebAudit(doc: Document, input: Record<string, unknown>): string {
  if (input.url !== undefined) {
    const filled = fillWebTarget(doc, input);
    if (filled.startsWith('fill_web_target') || filled.startsWith('url must')) return filled;
  }
  const form = doc.querySelector('[data-audit-form]') as HTMLFormElement | null;
  if (!form) return `open_web_audit is only available on ${ENTRY_PAGES}.`;
  form.submit();
  return 'Opening the audit page with the form prefilled. Human must click Audit.';
}

export function homeTools(opts: ToolsForOpts): WebMcpTool[] {
  return [
    {
      name: 'set_surface',
      description:
        'Switch the entry form and the page between CLI and Website. Checks the radio and dispatches change.',
      inputSchema: {
        type: 'object',
        properties: {
          surface: { type: 'string', enum: ['cli', 'web'] },
        },
        required: ['surface'],
        additionalProperties: false,
      },
      execute(input) {
        return capExecute(setSurface(pageDoc(opts), input));
      },
    },
    {
      name: 'fill_cli_target',
      description: 'Set the entry form to CLI and fill its target. Does not submit. Human must click Audit.',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
        additionalProperties: false,
      },
      execute(input) {
        return capExecute(fillCliTarget(pageDoc(opts), input));
      },
    },
    {
      name: 'fill_web_target',
      description: 'Set the entry form to Website and fill its target. Does not submit. Human must click Audit.',
      inputSchema: {
        type: 'object',
        properties: { url: { type: 'string' } },
        required: ['url'],
        additionalProperties: false,
      },
      execute(input) {
        return capExecute(fillWebTarget(pageDoc(opts), input));
      },
    },
    {
      name: 'open_web_audit',
      description:
        'Optional fill of the entry form as a website, then submit its GET form, which only prefills the audit page. Does not run the audit.',
      inputSchema: {
        type: 'object',
        properties: { url: { type: 'string' } },
        additionalProperties: false,
      },
      execute(input) {
        return capExecute(openWebAudit(pageDoc(opts), input));
      },
    },
  ];
}
