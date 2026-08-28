// `webmcp` probe handler (plan-003 U6, R7). Scans the TARGET site's
// root HTML for browser WebMCP tool exposure — distinct from this site's
// own src/client/webmcp.ts, which registers tools on anc.dev pages.
//
// WebMCP registration is imperative (navigator.modelContext), so a
// server-side probe detects the static markers a page ships: a
// declarative webmcp JSON block, a modelContext reference in inline
// script, or a script asset whose name carries `webmcp`. Reuses the
// canonical root fetch; no additional subrequest.

import type { WebCheck } from '../registry';
import type { HandlerContext, ProbeOutcome } from './types';

// Each marker must be structural: an attribute, a script element, or a
// qualified property access. A bare `webmcp` or `modelcontext` substring
// anywhere in the body is not evidence of exposure, because naming the
// Model Context Protocol in nav copy, a link, or an icon title is
// near-universal on the sites this audit targets and has nothing to do
// with browser WebMCP. `modelContext` stays case-sensitive: it is a JS
// property name, so `ModelContextProtocol` is a different token.
const WEBMCP_MARKERS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: 'application/webmcp script block', re: /\btype\s*=\s*["']?application\/webmcp(?:\+json)?\b/i },
  { name: 'modelContext API reference', re: /\b(?:navigator|document|window)\s*\.\s*modelContext\b/ },
  { name: 'webmcp script asset', re: /<script\b[^>]*\bsrc\s*=\s*["'][^"']*webmcp[^"']*["']/i },
];

export async function runWebMcp(_check: WebCheck, ctx: HandlerContext): Promise<ProbeOutcome> {
  const root = ctx.root;
  if (!root || root.status === null) {
    return { status: 'error', evidence: [{ why: ['root fetch failed'] }] };
  }
  const matched = WEBMCP_MARKERS.find((marker) => marker.re.test(root.body));
  if (matched) {
    return {
      status: 'pass',
      // The marker's own label, never the matched span: the span is the
      // target's markup, unbounded in length and target-controlled.
      evidence: [{ url: ctx.base, status: root.status, ok: true, marker: matched.name }],
    };
  }
  return {
    status: 'absent',
    evidence: [{ url: ctx.base, status: root.status, ok: false, why: ['no WebMCP markers in root HTML'] }],
  };
}
