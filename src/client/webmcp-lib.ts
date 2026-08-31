// Pathname → WebMCP tools, registerTool-first. execute returns a DOMString
// ≤1.5k. Probe document.modelContext then navigator.modelContext; no-op if
// both are absent. See https://webmachinelearning.github.io/webmcp/

import { CANONICAL_SITE_URL } from '../shared/site-url';
import { pageMeta } from '../shared/web-audit-findings';
import { auditTools } from './webmcp-audit';
import { homeTools } from './webmcp-home';
import { orientationTools } from './webmcp-orientation';
import { resultTools } from './webmcp-result';

/**
 * Longest DOMString a WebMCP tool's `execute()` may return.
 *
 * This bounds the browser-side WebMCP surface only. It is not a limit on the
 * regular MCP server at `/mcp`, whose tool results are ordinary JSON-RPC
 * payloads with no such ceiling, and not a site-wide response cap. A reader
 * who mistakes it for either will shorten payloads that were never
 * constrained: `get_web_remediation` returns the same remediation object this
 * page's tools have to trim.
 */
export const WEBMCP_EXECUTE_MAX = 1500;

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
  if (text.length <= WEBMCP_EXECUTE_MAX) return text;
  return `${text.slice(0, WEBMCP_EXECUTE_MAX - 1)}…`;
}

export type PagedResult = {
  /** Fields that precede the pagination metadata, e.g. freshness. */
  head: Record<string, unknown>;
  offset: number;
  total: number;
  items: readonly unknown[];
  /** JSON key the items are published under. */
  key?: string;
};

/**
 * Serialize one page of whole items under WEBMCP_EXECUTE_MAX. Slicing a
 * serialized envelope would hand the reader broken JSON, so items are
 * dropped from the end until the page fits and `pageMeta` reports the
 * shortfall — the continuation cursor then carries the reader forward
 * without a gap.
 */
export function packPage(page: PagedResult): string {
  const key = page.key ?? 'items';
  const render = (keep: number): string => {
    const items = page.items.slice(0, keep);
    return JSON.stringify({
      ok: true,
      ...page.head,
      total: page.total,
      ...pageMeta(page.offset, page.total, items.length),
      [key]: items,
    });
  };
  for (let keep = page.items.length; keep > 0; keep -= 1) {
    const text = render(keep);
    if (text.length <= WEBMCP_EXECUTE_MAX) return text;
  }
  return render(0);
}

export function emptyObjectSchema(): Record<string, unknown> {
  return { type: 'object', properties: {}, additionalProperties: false };
}

// The page's own origin, so a tool result points at the deployment the
// agent is already on. Falls back to the canonical host only when there
// is no document to read an origin from (non-browser test harness).
function resolveOrigin(opts: ToolsForOpts): string {
  if (opts.origin) return opts.origin;
  if (typeof location !== 'undefined' && location.origin) return location.origin;
  return CANONICAL_SITE_URL;
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
  const origin = win.location?.origin ?? CANONICAL_SITE_URL;
  const pathname = win.location?.pathname ?? '/';
  void bindModelContext(mc, toolsFor(pathname, { doc, origin }), controller.signal);
  win.addEventListener('pagehide', () => controller.abort(), { once: true });
}

function probeModelContext(host: InitWebMcpHost): ModelContext | undefined {
  if (host.document !== undefined || host.navigator !== undefined) {
    const fromHostDoc = (host.document as DocMc | undefined)?.modelContext;
    if (fromHostDoc) return fromHostDoc;
    return (host.navigator as NavMc | undefined)?.modelContext;
  }
  // Read navigator only after document misses. Chrome warns on any access to
  // the deprecated navigator.modelContext getter.
  if (typeof document !== 'undefined') {
    const fromDocument = (document as DocMc).modelContext;
    if (fromDocument) return fromDocument;
  }
  if (typeof navigator !== 'undefined') {
    return (navigator as NavMc).modelContext;
  }
  return undefined;
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
