// Map engine results into an anc scorecard (plan U5, KTD-4/KTD-5).
//
// The web audit re-expresses its results in anc vernacular so the shared
// presentation (src/shared/scorecard-format.mjs) consumes them unchanged:
// each result row carries `group` = the check's principle (P1..P8),
// `status` in the site's vocabulary, `label` = check title, and a compact
// `evidence` string. Because the shared renderer reads `badge.score_pct`
// straight from the JSON and never computes it, this module computes the
// headline percentage itself via a site-owned MUST+SHOULD credit-weighting
// (MAY informational only) — not a port of the skill's A-F grade.

import type { EvidenceItem } from './handlers/types';
import type { WebCheckKeyword, WebCheckTier } from './registry';

/**
 * Web scorecard status vocabulary (tri-state outcome model): `absent`
 * and `broken` replace the old collapsed `fail` so the scorer can price
 * a present-but-invalid surface differently from a missing one.
 */
export type ScorecardStatus = 'pass' | 'broken' | 'absent' | 'n_a' | 'skip' | 'error';

/**
 * Why a row is n_a: `antecedent-unmet` = the check does not apply to
 * this site (declared type or runtime antecedent); `optional-absent` =
 * it applies, is a MAY, and simply is not implemented.
 */
export type NaReason = 'antecedent-unmet' | 'optional-absent';

export interface EngineResult {
  id: string;
  title: string;
  principle: string;
  keyword: WebCheckKeyword;
  tier: WebCheckTier;
  category: string;
  weight: number;
  status: ScorecardStatus;
  na_reason?: NaReason;
  /** Compact human-readable evidence string for the row. */
  evidence: string;
  /** Full structured evidence for the JSON / remediation templating. */
  raw_evidence: EvidenceItem[];
}

export interface WebScorecardResultRow {
  id: string;
  label: string;
  group: string;
  layer: 'web';
  keyword: WebCheckKeyword;
  status: ScorecardStatus;
  evidence: string | null;
}

export interface WebCoverageLevel {
  total: number;
  verified: number;
}

export interface WebScorecard {
  schema_version: string;
  spec_version: string;
  target_url: string;
  mcp_endpoint: string | null;
  mcp_discovery: EvidenceItem[];
  tool: { name: string; url: string };
  audience: null;
  audit_profile: null;
  summary: Record<ScorecardStatus, number>;
  coverage_summary: { must: WebCoverageLevel; should: WebCoverageLevel; may: WebCoverageLevel };
  badge: { score_pct: number; eligible: boolean };
  results: WebScorecardResultRow[];
}

// Web scorecard schema starting version, independent of the CLI schema
// (0.7) and of agentnative-spec. Documented in content/web-scorecard-schema.md.
export const WEB_SCHEMA_VERSION = '0.1';

const SCORED_KEYWORDS = new Set<WebCheckKeyword>(['must', 'should']);
const SCORED_STATUSES = new Set<ScorecardStatus>(['pass', 'broken', 'absent']);

/**
 * Site-owned headline score: credit-weighted over MUST + SHOULD checks
 * whose status is a clean pass/fail (n_a / skip / error excluded). MAY
 * checks are informational and never counted. Returns 0 (not null) when
 * nothing is scoreable — the shared renderer reads a number.
 */
export function computeWebScorePct(results: EngineResult[]): number {
  let got = 0;
  let max = 0;
  for (const r of results) {
    if (!SCORED_KEYWORDS.has(r.keyword) || !SCORED_STATUSES.has(r.status)) continue;
    max += r.weight;
    if (r.status === 'pass') got += r.weight;
  }
  return max === 0 ? 0 : Math.round((100 * got) / max);
}

function coverageLevel(results: EngineResult[], keyword: WebCheckKeyword): WebCoverageLevel {
  let total = 0;
  let verified = 0;
  for (const r of results) {
    if (r.keyword !== keyword) continue;
    if (!SCORED_STATUSES.has(r.status)) continue; // exclude n_a / skip / error
    total += 1;
    if (r.status === 'pass') verified += 1;
  }
  return { total, verified };
}

function emptyTally(): Record<ScorecardStatus, number> {
  return { pass: 0, broken: 0, absent: 0, n_a: 0, skip: 0, error: 0 };
}

export interface WebScorecardMeta {
  targetUrl: string;
  domain: string;
  mcpEndpoint: string | null;
  discoveryEvidence: EvidenceItem[];
  specVersion: string;
}

export function buildWebScorecard(results: EngineResult[], meta: WebScorecardMeta): WebScorecard {
  const summary = emptyTally();
  const rows: WebScorecardResultRow[] = [];
  for (const r of results) {
    summary[r.status] += 1;
    rows.push({
      id: r.id,
      label: r.title,
      group: r.principle,
      layer: 'web',
      keyword: r.keyword,
      status: r.status,
      evidence: r.evidence === '' ? null : r.evidence,
    });
  }

  return {
    schema_version: WEB_SCHEMA_VERSION,
    spec_version: meta.specVersion,
    target_url: meta.targetUrl,
    mcp_endpoint: meta.mcpEndpoint,
    mcp_discovery: meta.discoveryEvidence,
    tool: { name: meta.domain, url: meta.targetUrl },
    audience: null,
    audit_profile: null,
    summary,
    coverage_summary: {
      must: coverageLevel(results, 'must'),
      should: coverageLevel(results, 'should'),
      may: coverageLevel(results, 'may'),
    },
    badge: { score_pct: computeWebScorePct(results), eligible: false },
    results: rows,
  };
}
