// Map engine results into the web scorecard (plan U5, reshaped per
// plan-003 U4/KTD-8).
//
// Schema 0.2: the headline is a top-level `score_pct` (the RELATIVE
// score) beside a `score { relative, global }` pair and per-category
// `categories[]` rollups; there is no badge (no embeddable web badge).
// Each result row carries its visible `category` plus `principle` as a
// hidden tag (kept for internal revisits, never shown or linked on web
// surfaces). `group` mirrors `principle` for the interim shared-renderer
// path; the category-grouped web renderer replaces that consumer.

import type { EvidenceItem } from './handlers/types';
import type { WebAuditRegistry, WebCheckKeyword, WebCheckTier, WebSiteType } from './registry';
import { type CategoryRollup, categoryRollups, type ScoreConfig, scoreWebAudit, universeMaxOf } from './score';

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
  category: string;
  group: string;
  layer: 'web';
  keyword: WebCheckKeyword;
  tier: WebCheckTier;
  principle: string;
  status: ScorecardStatus;
  na_reason?: NaReason;
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
  /** The declared site type this audit ran under; null = ran everything. */
  site_type: WebSiteType | null;
  summary: Record<ScorecardStatus, number>;
  coverage_summary: { must: WebCoverageLevel; should: WebCoverageLevel; may: WebCoverageLevel };
  score_pct: number;
  score: { relative: number; global: number };
  categories: CategoryRollup[];
  results: WebScorecardResultRow[];
}

// Web scorecard schema version, independent of the CLI schema (0.7) and
// of agentnative-spec. Documented in content/web-scorecard-schema.md.
export const WEB_SCHEMA_VERSION = '0.2';

const SCORED_STATUSES = new Set<ScorecardStatus>(['pass', 'broken', 'absent']);

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
  siteType?: WebSiteType | null;
  registry: Pick<WebAuditRegistry, 'category_order' | 'categories' | 'checks'>;
  scoreConfig?: ScoreConfig;
}

export function buildWebScorecard(results: EngineResult[], meta: WebScorecardMeta): WebScorecard {
  const summary = emptyTally();
  const rows: WebScorecardResultRow[] = [];
  for (const r of results) {
    summary[r.status] += 1;
    rows.push({
      id: r.id,
      label: r.title,
      category: r.category,
      group: r.principle,
      layer: 'web',
      keyword: r.keyword,
      tier: r.tier,
      principle: r.principle,
      status: r.status,
      ...(r.na_reason !== undefined ? { na_reason: r.na_reason } : {}),
      evidence: r.evidence === '' ? null : r.evidence,
    });
  }

  const universeMax = universeMaxOf(meta.registry.checks, meta.scoreConfig);
  const score = scoreWebAudit(results, universeMax, meta.scoreConfig);

  return {
    schema_version: WEB_SCHEMA_VERSION,
    spec_version: meta.specVersion,
    target_url: meta.targetUrl,
    mcp_endpoint: meta.mcpEndpoint,
    mcp_discovery: meta.discoveryEvidence,
    tool: { name: meta.domain, url: meta.targetUrl },
    audience: null,
    audit_profile: null,
    site_type: meta.siteType ?? null,
    summary,
    coverage_summary: {
      must: coverageLevel(results, 'must'),
      should: coverageLevel(results, 'should'),
      may: coverageLevel(results, 'may'),
    },
    score_pct: score.relative,
    score: { relative: score.relative, global: score.global },
    categories: categoryRollups(results, meta.registry.category_order, meta.registry.categories),
    results: rows,
  };
}
