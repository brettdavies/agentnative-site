// Pathname → WebMCP tools, registerTool-first. execute returns a DOMString
// ≤1.5k. Probe document.modelContext then navigator.modelContext; no-op if
// both are absent. See https://webmachinelearning.github.io/webmcp/

import { auditTools } from './webmcp-audit';
import { homeTools } from './webmcp-home';
import { orientationTools } from './webmcp-orientation';
import { resultTools } from './webmcp-result';

export const EXECUTE_MAX = 1500;

export type WebMcpTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean };
  execute: (input: Record<string, unknown>) => string | Promise<string>;
};

export type ModelContext = {
  registerTool?: (tool: WebMcpTool, options?: { signal?: AbortSignal }) => Promise<void>;
  provideContext?: (context: { tools: WebMcpTool[] }, options?: { signal?: AbortSignal }) => Promise<void>;
};

export type ToolsForOpts = {
  doc?: Document;
  origin?: string;
};

export type InitWebMcpHost = {
  document?: Document;
  navigator?: Navigator;
  window?: Window;
};

type DocMc = Document & { modelContext?: ModelContext };
type NavMc = Navigator & { modelContext?: ModelContext };

export function normalizePath(pathname: string): string {
  if (pathname === '/') return '/';
  return pathname.replace(/\/+$/, '') || '/';
}

export function isHomePath(pathname: string): boolean {
  const p = normalizePath(pathname);
  return p === '/' || p === '/index.html';
}

export function isAuditPath(pathname: string): boolean {
  return normalizePath(pathname) === '/web-audit';
}

export function isResultPath(pathname: string): boolean {
  return /^\/web\/(?!scoring$)[^/]+$/.test(normalizePath(pathname));
}

export function isOrientationPath(pathname: string): boolean {
  const p = normalizePath(pathname);
  return p === '/mcp' || /^\/p[1-8]$/.test(p) || isHomePath(p);
}

export function capExecute(text: string): string {
  if (text.length <= EXECUTE_MAX) return text;
  return `${text.slice(0, EXECUTE_MAX - 1)}…`;
}

export function formatWorksheet(rows: Array<{ id: string; keyword: string; status: string }>): string {
  let keep = rows.length;
  while (keep >= 0) {
    const omitted = rows.length - keep;
    const body = JSON.stringify(rows.slice(0, keep));
    const text = omitted === 0 ? body : `${body} … +${omitted} more`;
    if (text.length <= EXECUTE_MAX) return text;
    keep -= 1;
  }
  return capExecute(` … +${rows.length} more`);
}

export function emptyObjectSchema(): Record<string, unknown> {
  return { type: 'object', properties: {}, additionalProperties: false };
}

function resolveOrigin(opts: ToolsForOpts): string {
  if (opts.origin) return opts.origin;
  if (typeof location !== 'undefined' && location.origin) return location.origin;
  return '';
}

export function pageDoc(opts: ToolsForOpts): Document {
  if (opts.doc) return opts.doc;
  return document;
}

export function getPageState(doc: Document, pathname: string): string {
  const path = normalizePath(pathname);
  const cli = doc.getElementById('s-cli') as HTMLInputElement | null;
  const web = doc.getElementById('s-web') as HTMLInputElement | null;
  let surface: string | null = null;
  if (web?.checked) surface = 'web';
  else if (cli?.checked) surface = 'cli';
  else if (isAuditPath(path) || isResultPath(path)) surface = 'web';

  const homeUrl = (doc.querySelector('[data-web-home-input]') as HTMLInputElement | null)?.value ?? '';
  const auditUrl = (doc.querySelector('[data-web-audit-input]') as HTMLInputElement | null)?.value ?? '';
  const listingEl = doc.querySelector('[data-web-audit-listing]') as HTMLInputElement | null;
  const listing = listingEl ? listingEl.checked : null;
  return capExecute(JSON.stringify({ path, surface, url: auditUrl || homeUrl, listing }));
}

function pageStateTool(pathname: string, opts: ToolsForOpts): WebMcpTool {
  return {
    name: 'get_page_state',
    description: 'Return this page path, CLI/web surface, filled URL, and public-listing checkbox.',
    inputSchema: emptyObjectSchema(),
    annotations: { readOnlyHint: true },
    execute() {
      return getPageState(pageDoc(opts), pathname);
    },
  };
}

export function toolsFor(pathname: string, opts: ToolsForOpts = {}): WebMcpTool[] {
  const origin = resolveOrigin(opts);
  const tools: WebMcpTool[] = [];
  if (isHomePath(pathname) || isAuditPath(pathname) || isResultPath(pathname)) {
    tools.push(pageStateTool(pathname, opts));
  }
  if (isHomePath(pathname)) tools.push(...homeTools(opts));
  if (isAuditPath(pathname)) tools.push(...auditTools(opts));
  if (isResultPath(pathname)) tools.push(...resultTools(opts));
  if (isOrientationPath(pathname)) tools.push(...orientationTools(origin));
  return tools;
}

export async function bindModelContext(mc: ModelContext, tools: WebMcpTool[], signal: AbortSignal): Promise<void> {
  if (typeof mc.registerTool === 'function') {
    await Promise.all(tools.map((tool) => mc.registerTool?.(tool, { signal }).catch(() => {})));
    return;
  }
  if (typeof mc.provideContext === 'function') {
    await mc.provideContext({ tools }, { signal }).catch(() => {});
  }
}

function registerWithLifecycle(mc: ModelContext, win: Window, doc: Document | undefined): void {
  const controller = new AbortController();
  const origin = win.location?.origin ?? '';
  const pathname = win.location?.pathname ?? '/';
  void bindModelContext(mc, toolsFor(pathname, { doc, origin }), controller.signal);
  win.addEventListener('pagehide', () => controller.abort(), { once: true });
}

function probeModelContext(host: InitWebMcpHost): ModelContext | undefined {
  if (host.document !== undefined || host.navigator !== undefined) {
    return (host.document as DocMc | undefined)?.modelContext || (host.navigator as NavMc | undefined)?.modelContext;
  }
  const fromDocument = typeof document !== 'undefined' ? (document as DocMc).modelContext : undefined;
  const fromNavigator = typeof navigator !== 'undefined' ? (navigator as NavMc).modelContext : undefined;
  return fromDocument || fromNavigator;
}

export function initWebMcp(host: InitWebMcpHost = {}): void {
  const win = host.window ?? (typeof window !== 'undefined' ? window : undefined);
  if (!win) return;
  const mc = probeModelContext(host);
  if (!mc) return;
  const doc = host.document ?? (typeof document !== 'undefined' ? document : undefined);

  registerWithLifecycle(mc, win, doc);
  win.addEventListener('pageshow', (event) => {
    if (event.persisted) registerWithLifecycle(mc, win, doc);
  });
}
