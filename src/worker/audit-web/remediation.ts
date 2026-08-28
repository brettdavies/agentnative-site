// Web-audit remediation load + assembly (plan-003 U12, R10). The static
// catalog (dist/_internal/web-remediation.json, projected from
// remediation.yaml) carries title/goal/fix/resources per check; this
// module assembles the audit-time artifacts: the copy-paste prompt
// (Goal / Issue / Fix / Skill / Docs), which is site-owned catalog text
// and therefore identical for every run of a given check, and the
// always-shown Result line derived from status + evidence.

import { isRemediableStatus } from '../../shared/web-audit-findings';
import type { NaReason, ScorecardStatus } from './scorecard';

export interface WebRemediationResource {
  label: string;
  url: string;
}

export interface WebRemediationEntry {
  title: string;
  goal: string;
  fix: string;
  resources: WebRemediationResource[];
}

export type WebRemediationCatalog = Record<string, WebRemediationEntry>;

export interface AssembledRemediation {
  goal: string;
  fix: string;
  skill_url: string;
  resources: WebRemediationResource[];
  prompt: string;
}

const CATALOG_PATH = '/_internal/web-remediation.json';

export interface WebRemediationCatalogEnv {
  ASSETS: Fetcher;
}

let cached: { env: WebRemediationCatalogEnv; catalog: WebRemediationCatalog } | null = null;

export async function loadWebRemediationCatalog(env: WebRemediationCatalogEnv): Promise<WebRemediationCatalog> {
  if (cached && cached.env === env) return cached.catalog;
  const res = await env.ASSETS.fetch(new Request(`https://assets.internal${CATALOG_PATH}`));
  if (!res.ok) throw new Error(`web-remediation catalog fetch failed: ${res.status} ${res.statusText}`);
  const catalog = (await res.json()) as WebRemediationCatalog;
  cached = { env, catalog };
  return catalog;
}

export function resetWebRemediationCatalogCacheForTests(): void {
  cached = null;
}

/** Collapse multi-line markdown to the single-line prompt form. */
function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/g, ' ').trim();
}

// The audited site controls its own evidence strings (serverInfo names,
// response headers, error bodies), so they stay on the escaped Result
// surface and never reach instruction-bearing prompt text (R19). The
// Issue line is therefore one site-owned sentence for every row.
const ISSUE_LINE = 'the check did not pass in the latest audit';

export interface AssembleInput {
  checkId: string;
  /** Site origin the Skill link targets, e.g. https://anc.dev */
  origin: string;
}

/**
 * Assemble the remediation object for a check. A check missing a catalog
 * entry degrades to a generic prompt rather than crashing (R10). The
 * result depends only on the check id and the catalog, so a check's
 * prompt is a fixed string whose length can be proven against the
 * WebMCP output cap before it ships.
 */
export function assembleRemediation(
  entry: WebRemediationEntry | undefined,
  input: AssembleInput,
): AssembledRemediation {
  const skillUrl = `${input.origin}/web-audit/skill/${input.checkId}`;
  const goal = entry ? oneLine(entry.goal) : `Make the ${input.checkId} web-audit check pass`;
  const fix = entry
    ? oneLine(entry.fix)
    : `Implement the surface the ${input.checkId} check probes; see the skill page.`;
  const resources = entry?.resources ?? [];
  const lines = [`Goal: ${goal}`, `Issue: ${ISSUE_LINE}`, `Fix: ${fix}`, `Skill: ${skillUrl}`];
  if (resources.length > 0) {
    lines.push(`Docs: ${resources.map((r) => r.url).join(', ')}`);
  }
  return {
    goal,
    fix: entry?.fix.trim() ?? fix,
    skill_url: skillUrl,
    resources,
    prompt: lines.join('\n'),
  };
}

/**
 * Whether a status warrants a fix prompt. The set lives in the shared
 * finding module so the Worker, the result-page widget, and the WebMCP
 * tools cannot drift apart on eligibility. A row's `unprobed` flag
 * overrides this at the call site, because the run holds no observation
 * to fix.
 */
export function isFixableStatus(status: ScorecardStatus): boolean {
  return isRemediableStatus(status);
}

/**
 * The always-shown Result line, derived uniformly from status + evidence
 * (affirmative for pass, negative otherwise). Bespoke per-check copy is
 * a deferred optional override.
 */
export function resultLine(status: ScorecardStatus, evidence: string | null, naReason?: NaReason): string {
  const detail = evidence && evidence.length > 0 ? ` (${evidence})` : '';
  switch (status) {
    case 'pass':
      return `Verified${detail}`;
    case 'noncompliant':
      return `Works but does not conform${detail}`;
    case 'broken':
      return `Present but broken${detail}`;
    case 'absent':
      return `Not found${detail}`;
    case 'n_a':
      if (naReason === 'optional-absent') return `Not implemented, optional${detail}`;
      if (naReason === 'posture-consistent') return `Deliberate posture, not scored${detail}`;
      return `Not applicable${detail}`;
    case 'skip':
      return `Not evaluated: audit deadline exceeded${detail}`;
    case 'error':
      return `Not evaluated${detail}`;
  }
}
