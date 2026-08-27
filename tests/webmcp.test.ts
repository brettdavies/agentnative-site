import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fillAuditUrl, setPlan, setPublicListing } from '../src/client/webmcp-audit';
import { fillCliTarget, fillWebTarget, openWebAudit, setSurface } from '../src/client/webmcp-home';
import { bindModelContext, EXECUTE_MAX, formatWorksheet, initWebMcp, toolsFor } from '../src/client/webmcp-lib';
import { getFixPrompt, getWorksheet } from '../src/client/webmcp-result';

const REPO_ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const CLIENT_DIR = join(REPO_ROOT, 'src', 'client');
const DIST_JS = join(REPO_ROOT, 'dist', 'js', 'webmcp.js');

const WEBMCP_SOURCES = [
  'webmcp.ts',
  'webmcp-lib.ts',
  'webmcp-home.ts',
  'webmcp-audit.ts',
  'webmcp-result.ts',
  'webmcp-orientation.ts',
];

type Stub = {
  attrs: Record<string, string>;
  value: string;
  checked: boolean;
  hidden: boolean;
  textContent: string;
  children: Stub[];
  events: Event[];
  submits: number;
  getAttribute(name: string): string | null;
  querySelector(sel: string): Stub | null;
  querySelectorAll(sel: string): Stub[];
  dispatchEvent(ev: Event): boolean;
  submit(): void;
};

function matches(el: Stub, sel: string): boolean {
  const parts = sel.match(/(\.[A-Za-z][\w-]*|#[A-Za-z][\w-]*|\[[^\]]+\])/g);
  if (!parts || parts.join('') !== sel) return false;
  return parts.every((part) => {
    if (part.startsWith('.')) {
      return (el.attrs.class ?? '').split(/\s+/).includes(part.slice(1));
    }
    if (part.startsWith('#')) return el.attrs.id === part.slice(1);
    const m = /^\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(part);
    if (!m) return false;
    const val = el.getAttribute(m[1]);
    if (m[2] === undefined) return val !== null;
    return val === m[2];
  });
}

function walk(nodes: Stub[], sel: string, acc: Stub[]): void {
  for (const node of nodes) {
    if (matches(node, sel)) acc.push(node);
    walk(node.children, sel, acc);
  }
}

function stubEl(init: {
  attrs?: Record<string, string>;
  value?: string;
  checked?: boolean;
  hidden?: boolean;
  textContent?: string;
  children?: Stub[];
}): Stub {
  const attrs = { ...(init.attrs ?? {}) };
  const el: Stub = {
    attrs,
    value: init.value ?? '',
    checked: init.checked ?? false,
    hidden: init.hidden ?? false,
    textContent: init.textContent ?? '',
    children: init.children ?? [],
    events: [],
    submits: 0,
    getAttribute(name) {
      return attrs[name] ?? null;
    },
    querySelector(sel) {
      const found: Stub[] = [];
      walk(el.children, sel, found);
      return found[0] ?? null;
    },
    querySelectorAll(sel) {
      const found: Stub[] = [];
      walk(el.children, sel, found);
      return found;
    },
    dispatchEvent(ev) {
      el.events.push(ev);
      return true;
    },
    submit() {
      el.submits += 1;
    },
  };
  return el;
}

function stubDoc(roots: Stub[]): Document {
  const findAll = (sel: string): Stub[] => {
    const found: Stub[] = [];
    walk(roots, sel, found);
    return found;
  };
  return {
    querySelector(sel: string) {
      return findAll(sel)[0] ?? null;
    },
    querySelectorAll(sel: string) {
      return findAll(sel);
    },
    getElementById(id: string) {
      return findAll(`#${id}`)[0] ?? null;
    },
  } as unknown as Document;
}

function names(pathname: string): string[] {
  return toolsFor(pathname).map((t) => t.name);
}

function homeDoc(opts: { surface?: 'cli' | 'web'; webUrl?: string; cliText?: string } = {}): {
  doc: Document;
  form: Stub;
  webInput: Stub;
  cliInput: Stub;
  cliRadio: Stub;
  webRadio: Stub;
} {
  const cliRadio = stubEl({
    attrs: { id: 's-cli', type: 'radio' },
    checked: (opts.surface ?? 'cli') === 'cli',
  });
  const webRadio = stubEl({
    attrs: { id: 's-web', type: 'radio' },
    checked: opts.surface === 'web',
  });
  const cliInput = stubEl({ attrs: { id: 'live-score-input' }, value: opts.cliText ?? '' });
  const webInput = stubEl({ attrs: { 'data-web-home-input': '' }, value: opts.webUrl ?? '' });
  const form = stubEl({ attrs: { 'data-web-home-form': '' }, children: [webInput] });
  return {
    doc: stubDoc([cliRadio, webRadio, cliInput, form]),
    form,
    webInput,
    cliInput,
    cliRadio,
    webRadio,
  };
}

function auditDoc(opts: { url?: string; listing?: boolean; plan?: string } = {}): {
  doc: Document;
  input: Stub;
  status: Stub;
  listing: Stub;
} {
  const input = stubEl({ attrs: { 'data-web-audit-input': '' }, value: opts.url ?? '' });
  const listing = stubEl({
    attrs: { 'data-web-audit-listing': '', type: 'checkbox' },
    checked: opts.listing ?? false,
  });
  const status = stubEl({
    attrs: { 'data-web-audit-status': '' },
    textContent: opts.plan ?? '',
    hidden: !opts.plan,
  });
  return { doc: stubDoc([input, listing, status]), input, status, listing };
}

function resultDoc(rows: Array<{ id: string; keyword: string; status: string; prompt?: string }>): Document {
  const checks = rows.map((row) =>
    stubEl({
      attrs: {
        class: `web-check web-check--${row.status}`,
        'data-id': row.id,
      },
      children: [
        stubEl({
          attrs: {
            'data-copy-text': row.prompt ?? '',
            'data-keyword': row.keyword,
            'data-status': row.status,
          },
        }),
      ],
    }),
  );
  return stubDoc(checks);
}

describe('toolsFor(pathname)', () => {
  test('homepage registers orientation, page state, and P1 acts', () => {
    expect(names('/')).toEqual([
      'get_page_state',
      'set_surface',
      'fill_cli_target',
      'fill_web_target',
      'open_web_audit',
      'get_principle_url',
      'get_llms_index',
      'get_mcp_endpoint',
    ]);
    expect(names('/index.html')).toEqual(names('/'));
  });

  test('/web-audit registers the video-path prepare tools', () => {
    expect(names('/web-audit')).toEqual(['get_page_state', 'fill_audit_url', 'set_plan', 'set_public_listing']);
    expect(names('/web-audit/')).toEqual(names('/web-audit'));
  });

  test('/web/<host> registers worksheet answers', () => {
    expect(names('/web/anc.dev')).toEqual(['get_page_state', 'get_worksheet', 'get_fix_prompt']);
  });

  test('orientation pages keep the three URL tools only', () => {
    expect(names('/p1')).toEqual(['get_principle_url', 'get_llms_index', 'get_mcp_endpoint']);
    expect(names('/mcp')).toEqual(names('/p1'));
  });

  test('scoring, about, and the web board register nothing', () => {
    expect(names('/web/scoring/anc.dev')).toEqual([]);
    expect(names('/web/scoring')).toEqual([]);
    expect(names('/about')).toEqual([]);
    expect(names('/web')).toEqual([]);
    expect(names('/score/curl')).toEqual([]);
  });

  test('names, descriptions, and schemas stay inside the WebMCP caps', () => {
    const seen = new Set<string>();
    for (const path of ['/', '/web-audit', '/web/anc.dev', '/p1', '/mcp']) {
      for (const tool of toolsFor(path, { origin: 'https://anc.dev' })) {
        expect(tool.name.length).toBeLessThanOrEqual(30);
        expect(tool.description.length).toBeLessThanOrEqual(500);
        expect(tool.inputSchema.additionalProperties).toBe(false);
        seen.add(tool.name);
      }
    }
    expect(seen.has('get_fix_prompt')).toBe(true);
    expect(seen.has('assemble_fix_prompt')).toBe(false);
  });

  test('answer tools advertise readOnlyHint', () => {
    const home = toolsFor('/', { origin: 'https://anc.dev' });
    expect(home.find((t) => t.name === 'get_page_state')?.annotations?.readOnlyHint).toBe(true);
    expect(home.find((t) => t.name === 'set_surface')?.annotations?.readOnlyHint).toBeUndefined();
    const result = toolsFor('/web/anc.dev');
    expect(result.find((t) => t.name === 'get_worksheet')?.annotations?.readOnlyHint).toBe(true);
    expect(result.find((t) => t.name === 'get_fix_prompt')?.annotations?.readOnlyHint).toBe(true);
  });
});

describe('execute helpers (Document stub)', () => {
  test('fill_audit_url sets .value only and never submits', () => {
    const page = auditDoc();
    const out = fillAuditUrl(page.doc, { url: 'https://anc.dev' });
    expect(page.input.value).toBe('https://anc.dev');
    expect(out).toContain('Filled');
    expect(page.input.events).toEqual([]);
  });

  test('set_plan writes textContent and toggles hidden', () => {
    const page = auditDoc();
    setPlan(page.doc, { text: 'Agent prepared: audit anc.dev · waiting for you' });
    expect(page.status.textContent).toBe('Agent prepared: audit anc.dev · waiting for you');
    expect(page.status.hidden).toBe(false);
    setPlan(page.doc, { text: '' });
    expect(page.status.textContent).toBe('');
    expect(page.status.hidden).toBe(true);
  });

  test('set_plan rejects text over 200 characters', () => {
    const page = auditDoc();
    const out = setPlan(page.doc, { text: 'x'.repeat(201) });
    expect(out).toContain('200');
    expect(page.status.textContent).toBe('');
  });

  test('set_public_listing checks or unchecks the /web-audit box', () => {
    const page = auditDoc({ listing: false });
    expect(setPublicListing(page.doc, { listed: true })).toContain('listing');
    expect(page.listing.checked).toBe(true);
    setPublicListing(page.doc, { listed: false });
    expect(page.listing.checked).toBe(false);
  });

  test('get_worksheet returns broken rows first, then absent, then document order', () => {
    const doc = resultDoc([
      { id: 'a-absent', keyword: 'must', status: 'absent' },
      { id: 'b-broken', keyword: 'should', status: 'broken' },
      { id: 'c-pass', keyword: 'must', status: 'pass' },
      { id: 'd-broken', keyword: 'must', status: 'broken' },
      { id: 'e-absent', keyword: 'may', status: 'absent' },
    ]);
    expect(JSON.parse(getWorksheet(doc))).toEqual([
      { id: 'b-broken', keyword: 'should', status: 'broken' },
      { id: 'd-broken', keyword: 'must', status: 'broken' },
      { id: 'a-absent', keyword: 'must', status: 'absent' },
      { id: 'e-absent', keyword: 'may', status: 'absent' },
    ]);
  });

  test('get_worksheet truncates with … +N more under 1.5k', () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({
      id: `check-id-${String(i).padStart(2, '0')}-xxxxxxxxxxxxxxxxxxxx`,
      keyword: 'must',
      status: i % 2 === 0 ? 'broken' : 'absent',
    }));
    const text = formatWorksheet(rows);
    expect(text.length).toBeLessThanOrEqual(EXECUTE_MAX);
    expect(text).toMatch(/ … \+\d+ more$/);
  });

  test('get_fix_prompt reads data-copy-text and never needs the assemble widget', () => {
    const doc = resultDoc([{ id: 'openapi', keyword: 'must', status: 'absent', prompt: 'Goal: publish OpenAPI' }]);
    expect(getFixPrompt(doc, { id: 'openapi' })).toBe('Goal: publish OpenAPI');
    expect(getFixPrompt(doc, { id: 'missing' })).toContain('missing');
  });

  test('wrong-page acts return an error string', () => {
    const empty = stubDoc([]);
    expect(fillAuditUrl(empty, { url: 'https://anc.dev' })).toContain('/web-audit');
    expect(setPlan(empty, { text: 'hi' })).toContain('/web-audit');
    expect(setSurface(empty, { surface: 'web' })).toContain('homepage');
    expect(fillCliTarget(empty, { text: 'ripgrep' })).toContain('homepage');
    expect(openWebAudit(empty, {})).toContain('homepage');
  });

  test('homepage P1 fills values, switches surface, and submits the GET form', () => {
    const page = homeDoc();
    expect(fillCliTarget(page.doc, { text: 'ripgrep' })).toContain('Filled');
    expect(page.cliInput.value).toBe('ripgrep');
    expect(fillWebTarget(page.doc, { url: 'https://anc.dev' })).toContain('Filled');
    expect(page.webInput.value).toBe('https://anc.dev');
    expect(setSurface(page.doc, { surface: 'web' })).toContain('web');
    expect(page.webRadio.checked).toBe(true);
    expect(page.cliRadio.checked).toBe(false);
    expect(page.webRadio.events[0]?.type).toBe('change');
    const out = openWebAudit(page.doc, { url: 'https://example.com' });
    expect(page.webInput.value).toBe('https://example.com');
    expect(page.form.submits).toBe(1);
    expect(out.toLowerCase()).toContain('web-audit');
  });

  test('execute returns a DOMString and never calls fetch or /web/scoring', async () => {
    const fetches: string[] = [];
    const orig = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      fetches.push(String(input));
      return new Response('nope', { status: 500 });
    }) as typeof fetch;
    try {
      const audit = auditDoc();
      const home = homeDoc();
      const result = resultDoc([{ id: 'openapi', keyword: 'must', status: 'absent', prompt: 'fix it' }]);
      const origin = 'https://anc.dev';
      const outputs: string[] = [];
      for (const tool of toolsFor('/web-audit', { doc: audit.doc, origin })) {
        outputs.push(await tool.execute({ url: 'https://anc.dev', text: 'ready', listed: true }));
      }
      for (const tool of toolsFor('/', { doc: home.doc, origin })) {
        outputs.push(await tool.execute({ surface: 'web', text: 'ripgrep', url: 'https://anc.dev', n: 1 }));
      }
      for (const tool of toolsFor('/web/anc.dev', { doc: result, origin })) {
        outputs.push(await tool.execute({ id: 'openapi' }));
      }
      expect(fetches).toEqual([]);
      expect(home.form.submits).toBe(1);
      for (const out of outputs) {
        expect(typeof out).toBe('string');
        expect(out.length).toBeLessThanOrEqual(EXECUTE_MAX);
        expect(out).not.toContain('/web/scoring');
        expect(out).not.toContain('/api/score');
      }
    } finally {
      globalThis.fetch = orig;
    }
  });
});

describe('bindModelContext', () => {
  test('prefers registerTool when both methods exist', async () => {
    const calls: string[] = [];
    const tools = toolsFor('/p1', { origin: 'https://anc.dev' });
    await bindModelContext(
      {
        async registerTool() {
          calls.push('register');
        },
        async provideContext() {
          calls.push('provide');
        },
      },
      tools,
      new AbortController().signal,
    );
    expect(calls).toEqual(['register', 'register', 'register']);
  });

  test('falls back to provideContext only when registerTool is missing', async () => {
    const calls: string[] = [];
    await bindModelContext(
      {
        async provideContext() {
          calls.push('provide');
        },
      },
      toolsFor('/p1', { origin: 'https://anc.dev' }),
      new AbortController().signal,
    );
    expect(calls).toEqual(['provide']);
  });

  test('init no-ops when both modelContext probes are missing', () => {
    expect(() =>
      initWebMcp({
        document: {} as Document,
        navigator: {} as Navigator,
        window: { addEventListener() {} } as unknown as Window,
      }),
    ).not.toThrow();
  });
});

describe('iron-rule source', () => {
  test('leaf client never fetches, scores, or imports live-score / web-audit / clipboard', async () => {
    for (const file of WEBMCP_SOURCES) {
      const src = await readFile(join(CLIENT_DIR, file), 'utf8');
      expect({ file, fetch: src.includes('fetch(') }).toEqual({ file, fetch: false });
      expect(src).not.toContain('/api/score');
      expect(src).not.toContain('/web/scoring');
      expect(src).not.toMatch(/from ['"]\.\/live-score/);
      expect(src).not.toMatch(/from ['"]\.\/web-audit['"]/);
      expect(src).not.toMatch(/from ['"]\.\/clipboard/);
    }
  });

  test('lib probes document.modelContext and calls registerTool before provideContext', async () => {
    const src = await readFile(join(CLIENT_DIR, 'webmcp-lib.ts'), 'utf8');
    expect(src).toContain('document.modelContext');
    expect(src).toContain('navigator.modelContext');
    expect(src.indexOf('registerTool')).toBeLessThan(src.indexOf('provideContext'));
  });
});

describe('webmcp.js bundle (built dist/)', () => {
  test('registerTool appears before provideContext and execute is a DOMString path', async () => {
    const js = await readFile(DIST_JS, 'utf8');
    expect(js.indexOf('registerTool')).toBeGreaterThan(-1);
    expect(js.indexOf('registerTool')).toBeLessThan(js.indexOf('provideContext'));
    expect(js).toContain('document.modelContext');
    expect(js).toContain('get_principle_url');
    expect(js).not.toContain('type:"text"');
    expect(js).not.toContain("type:'text'");
  });
});
