// Web-audit remediation load + assembly (plan-003 U12, R10). The static
// catalog (dist/_internal/web-remediation.json, projected from
// remediation.yaml) carries title/goal/fix/resources per check; this
// module assembles the audit-time artifacts: the copy-paste prompt
// (Goal / Issue / Fix / Skill / Docs) with the run's evidence as the
// uniform Issue line, and the always-shown Result line derived from
// status + evidence.

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

const GENERIC_ISSUE = 'the check did not pass in the latest audit';

export interface AssembleInput {
  checkId: string;
  /** Site origin the Skill link targets, e.g. https://anc.dev */
  origin: string;
  /** The run's evidence line; omitted = a generic Issue line. */
  evidence?: string | null;
}

/**
 * Assemble the remediation object for a check. A check missing a catalog
 * entry degrades to a generic prompt rather than crashing (R10).
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
  const issue = input.evidence && input.evidence.length > 0 ? input.evidence : GENERIC_ISSUE;
  const lines = [`Goal: ${goal}`, `Issue: ${issue}`, `Fix: ${fix}`, `Skill: ${skillUrl}`];
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
 * The always-shown Result line, derived uniformly from status + evidence
 * (affirmative for pass, negative otherwise). Bespoke per-check copy is
 * a deferred optional override.
 */
export function resultLine(status: ScorecardStatus, evidence: string | null, naReason?: NaReason): string {
  const detail = evidence && evidence.length > 0 ? ` (${evidence})` : '';
  switch (status) {
    case 'pass':
      return `Verified${detail}`;
    case 'broken':
      return `Present but broken${detail}`;
    case 'absent':
      return `Not found${detail}`;
    case 'n_a':
      return naReason === 'optional-absent' ? `Not implemented, optional${detail}` : `Not applicable${detail}`;
    case 'skip':
      return `Not evaluated: audit deadline exceeded${detail}`;
    case 'error':
      return `Not evaluated${detail}`;
  }
}
