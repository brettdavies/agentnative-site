import { capExecute, pageDoc, type ToolsForOpts, type WebMcpTool } from './webmcp-lib';

const PLAN_MAX = 200;

export function fillAuditUrl(doc: Document, input: Record<string, unknown>): string {
  if (typeof input.url !== 'string') return 'url must be a string.';
  const el = doc.querySelector('[data-web-audit-input]') as HTMLInputElement | null;
  if (!el) return 'fill_audit_url is only available on /web-audit.';
  el.value = input.url;
  return 'Filled. Human must click Audit.';
}

export function setPlan(doc: Document, input: Record<string, unknown>): string {
  if (typeof input.text !== 'string') return 'text must be a string.';
  if (input.text.length > PLAN_MAX) return 'text must be 200 characters or fewer.';
  const status = doc.querySelector('[data-web-audit-status]') as HTMLElement | null;
  if (!status) return 'set_plan is only available on /web-audit.';
  status.textContent = input.text;
  status.hidden = input.text.length === 0;
  return input.text.length === 0 ? 'Plan cleared.' : 'Plan posted. Human must click Audit.';
}

export function setPublicListing(doc: Document, input: Record<string, unknown>): string {
  if (typeof input.listed !== 'boolean') return 'listed must be a boolean.';
  const el = doc.querySelector('[data-web-audit-listing]') as HTMLInputElement | null;
  if (!el) return 'set_public_listing is only available on /web-audit.';
  el.checked = input.listed;
  return input.listed
    ? 'Public listing checked. Human Audit persists the flag.'
    : 'Public listing unchecked. Human Audit persists the flag.';
}

export function auditTools(opts: ToolsForOpts): WebMcpTool[] {
  return [
    {
      name: 'fill_audit_url',
      description: 'Set the /web-audit URL field. Does not click Audit. Human must submit.',
      inputSchema: {
        type: 'object',
        properties: { url: { type: 'string' } },
        required: ['url'],
        additionalProperties: false,
      },
      execute(input) {
        return capExecute(fillAuditUrl(pageDoc(opts), input));
      },
    },
    {
      name: 'set_plan',
      description: 'Write a short status on /web-audit (≤200 chars). Hidden when empty. Does not click Audit.',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string', maxLength: PLAN_MAX } },
        required: ['text'],
        additionalProperties: false,
      },
      execute(input) {
        return capExecute(setPlan(pageDoc(opts), input));
      },
    },
    {
      name: 'set_public_listing',
      description: 'Check or uncheck public listing on /web-audit. Human Audit persists the flag. No ownership check.',
      inputSchema: {
        type: 'object',
        properties: { listed: { type: 'boolean' } },
        required: ['listed'],
        additionalProperties: false,
      },
      execute(input) {
        return capExecute(setPublicListing(pageDoc(opts), input));
      },
    },
  ];
}
