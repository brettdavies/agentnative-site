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

const WEBMCP_MARKERS = /application\/webmcp|navigator\.modelContext|modelcontext|webmcp/i;

export async function runWebMcp(_check: WebCheck, ctx: HandlerContext): Promise<ProbeOutcome> {
  const root = ctx.root;
  if (!root || root.status === null) {
    return { status: 'error', evidence: [{ why: ['root fetch failed'] }] };
  }
  const matched = WEBMCP_MARKERS.exec(root.body);
  if (matched) {
    return {
      status: 'pass',
      evidence: [{ url: ctx.base, status: root.status, ok: true, marker: matched[0] }],
    };
  }
  return {
    status: 'absent',
    evidence: [{ url: ctx.base, status: root.status, ok: false, why: ['no WebMCP markers in root HTML'] }],
  };
}
