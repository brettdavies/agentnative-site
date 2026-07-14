// Shared fixtures for the per-group antecedent resolver tests. Mirrors the
// resolvers' own shared context module: one synthetic AntecedentContext
// builder plus the probe-shape helpers the group tests compose.

import type { AntecedentContext } from '../src/worker/audit-web/antecedents';
import type { ProbeResponse } from '../src/worker/audit-web/assert';
import type { ProbeOutcome } from '../src/worker/audit-web/handlers/types';

export function htmlRoot(body = '<html><head></head><body><main>hi</main></body></html>'): ProbeResponse {
  return { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body, error: null };
}

export function outcome(status: ProbeOutcome['status'], evidence: ProbeOutcome['evidence'] = []): ProbeOutcome {
  return { status, evidence };
}

export function ctx(overrides: Partial<AntecedentContext> = {}): AntecedentContext {
  return {
    siteType: null,
    mcpEndpoint: null,
    discoveryEvidence: [],
    root: htmlRoot(),
    sources: new Map(),
    ...overrides,
  };
}
