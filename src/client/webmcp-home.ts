import { capExecute, pageDoc, type ToolsForOpts, type WebMcpTool } from './webmcp-lib';

export function setSurface(doc: Document, input: Record<string, unknown>): string {
  const surface = input.surface;
  if (surface !== 'cli' && surface !== 'web') return 'surface must be "cli" or "web".';
  const cli = doc.getElementById('s-cli') as HTMLInputElement | null;
  const web = doc.getElementById('s-web') as HTMLInputElement | null;
  if (!cli || !web) return 'set_surface is only available on the homepage.';
  const target = surface === 'web' ? web : cli;
  const other = surface === 'web' ? cli : web;
  target.checked = true;
  other.checked = false;
  target.dispatchEvent(new Event('change', { bubbles: true }));
  return `Surface set to ${surface}.`;
}

export function fillCliTarget(doc: Document, input: Record<string, unknown>): string {
  if (typeof input.text !== 'string') return 'text must be a string.';
  const el = doc.getElementById('live-score-input') as HTMLInputElement | null;
  if (!el) return 'fill_cli_target is only available on the homepage.';
  el.value = input.text;
  return 'Filled CLI target.';
}

export function fillWebTarget(doc: Document, input: Record<string, unknown>): string {
  if (typeof input.url !== 'string') return 'url must be a string.';
  const el = doc.querySelector('[data-web-home-input]') as HTMLInputElement | null;
  if (!el) return 'fill_web_target is only available on the homepage.';
  el.value = input.url;
  return 'Filled website URL.';
}

export function openWebAudit(doc: Document, input: Record<string, unknown>): string {
  if (input.url !== undefined) {
    const filled = fillWebTarget(doc, input);
    if (filled.startsWith('fill_web_target') || filled.startsWith('url must')) return filled;
  }
  const form = doc.querySelector('[data-web-home-form]') as HTMLFormElement | null;
  if (!form) return 'open_web_audit is only available on the homepage.';
  form.submit();
  return 'Opening /web-audit…';
}

export function homeTools(opts: ToolsForOpts): WebMcpTool[] {
  return [
    {
      name: 'set_surface',
      description: 'Switch the homepage between CLI and Website. Checks the radio and dispatches change.',
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
      description: 'Set the homepage CLI Score input. Does not submit Score.',
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
      description: 'Set the homepage Website Audit input. Does not submit Audit.',
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
        'Optional fill of the homepage Website input, then submit the GET form to /web-audit. Does not run the audit.',
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
