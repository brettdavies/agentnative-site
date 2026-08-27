import {
  capExecute,
  emptyObjectSchema,
  formatWorksheet,
  pageDoc,
  type ToolsForOpts,
  type WebMcpTool,
} from './webmcp-lib';

type WorksheetRow = { id: string; keyword: string; status: string };

function statusOf(el: Element): string {
  const direct = el.getAttribute('data-status');
  if (direct) return direct;
  const child = el.querySelector('[data-status]');
  if (child) return child.getAttribute('data-status') ?? '';
  const cls = el.getAttribute('class') ?? '';
  const m = cls.match(/web-check--(\S+)/);
  return m?.[1] ?? '';
}

function keywordOf(el: Element): string {
  return el.getAttribute('data-keyword') ?? el.querySelector('[data-keyword]')?.getAttribute('data-keyword') ?? '';
}

export function worksheetRows(doc: Document): WorksheetRow[] {
  const rows: WorksheetRow[] = [];
  for (const node of doc.querySelectorAll('.web-check[data-id]')) {
    const id = node.getAttribute('data-id');
    if (!id) continue;
    const status = statusOf(node);
    if (status !== 'broken' && status !== 'absent') continue;
    rows.push({ id, keyword: keywordOf(node), status });
  }
  rows.sort((a, b) => {
    const rank = (status: string) => (status === 'broken' ? 0 : 1);
    return rank(a.status) - rank(b.status);
  });
  return rows;
}

export function getWorksheet(doc: Document): string {
  return formatWorksheet(worksheetRows(doc));
}

export function getFixPrompt(doc: Document, input: Record<string, unknown>): string {
  if (typeof input.id !== 'string' || input.id.length === 0) return 'id must be a non-empty string.';
  for (const node of doc.querySelectorAll('.web-check[data-id]')) {
    if (node.getAttribute('data-id') !== input.id) continue;
    const text = node.querySelector('[data-copy-text]')?.getAttribute('data-copy-text');
    if (!text) return capExecute(`No prompt for ${input.id}. See the on-page widget.`);
    return capExecute(text);
  }
  return capExecute(`Unknown check id: ${input.id}`);
}

export function resultTools(opts: ToolsForOpts): WebMcpTool[] {
  return [
    {
      name: 'get_worksheet',
      description: 'List broken then absent checks on this scorecard (id, keyword, status). Truncates with +N more.',
      inputSchema: emptyObjectSchema(),
      annotations: { readOnlyHint: true },
      execute() {
        return getWorksheet(pageDoc(opts));
      },
    },
    {
      name: 'get_fix_prompt',
      description: 'Return the stored fix prompt for a check id. Reads data-copy-text; does not click Copy.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
      execute(input) {
        return getFixPrompt(pageDoc(opts), input);
      },
    },
  ];
}
