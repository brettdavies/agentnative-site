// Map engine results into the web scorecard (plan U5, reshaped per
// plan-003 U4/KTD-8).
//
// The headline is a top-level `score_pct` (the RELATIVE
// score) beside a `score { relative, global }` pair and per-category
// `categories[]` rollups; there is no badge (no embeddable web badge).
// Each result row carries its visible `category` plus `principle` as a
// hidden tag (kept for internal revisits, never shown or linked on web
// surfaces). `group` mirrors `principle` for the interim shared-renderer
// path; the category-grouped web renderer replaces that consumer.

import type { NaReason } from '../../shared/web-audit-findings';
import type { EvidenceItem } from './handlers/types';
import { type DeclaredHostEntry, type RowHost, rowHostFields } from './provenance';
import type { WebAuditRegistry, WebCheckKeyword, WebCheckTier, WebSiteType } from './registry';
import {
  type CategoryRollup,
  categoryRollups,
  SCORED_STATUSES,
  type ScoreConfig,
  scoreWebAudit,
  universeMaxOf,
} from './score';

export type { NaReason } from '../../shared/web-audit-findings';

/**
 * Web scorecard status vocabulary. `absent`, `noncompliant` and `broken`
 * are three separately priced ways to not pass: nothing to find, a
 * working surface that violates a spec detail, and a surface that misleads
 * the agent that finds it.
 */
export type ScorecardStatus = 'pass' | 'noncompliant' | 'broken' | 'absent' | 'n_a' | 'skip' | 'error';

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
  /** The row settled from an antecedent rather than from its own request. */
  unprobed?: true;
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
  /**
   * The row settled from an antecedent rather than from its own request,
   * so the run holds no observation of the surface. Read-time enrichment
   * attaches no remediation to it.
   */
  unprobed?: true;
  evidence: string | null;
  /** The distinct hosts the row's evidence was requested from, in evidence order. */
  hosts: RowHost[];
  /** Present only when `hosts` holds exactly one entry. */
  host?: string;
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
  /**
   * Submitter's opt-in to the public board listing. A fresh build always
   * emits it; optional only because stored envelopes may lack it.
   */
  public_listing?: boolean;
  /** The declared site type this audit ran under; null = ran everything. */
  site_type: WebSiteType | null;
  /** Whether the audit followed the hosts the target declares; absent reads as not evaluated. */
  follow_declarations?: boolean;
  /** The declared-hosts trail; absent reads as no trail, which is not an empty one. */
  declared_hosts?: DeclaredHostEntry[];
  /** The registry fingerprint prefix the score was computed under; never set by the engine. */
  registry_fingerprint?: string;
  summary: Record<ScorecardStatus, number>;
  coverage_summary: { must: WebCoverageLevel; should: WebCoverageLevel; may: WebCoverageLevel };
  score_pct: number;
  score: { relative: number; global: number };
  categories: CategoryRollup[];
  results: WebScorecardResultRow[];
}

// Web scorecard schema version, independent of the CLI schema (0.7) and
// of agentnative-spec. Documented in content/web-scorecard-schema.md.
export const WEB_SCHEMA_VERSION = '0.5';

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
  return { pass: 0, noncompliant: 0, broken: 0, absent: 0, n_a: 0, skip: 0, error: 0 };
}

export interface WebScorecardMeta {
  targetUrl: string;
  domain: string;
  mcpEndpoint: string | null;
  discoveryEvidence: EvidenceItem[];
  specVersion: string;
  siteType?: WebSiteType | null;
  /**
   * Callers resolve the stored tri-state before building, so undefined
   * here means a first-ever audit and safely collapses to false.
   */
  publicListing?: boolean;
  /** The effective follow state and the trail it produced; a build given neither records neither. */
  followDeclarations?: boolean;
  declaredHosts?: DeclaredHostEntry[];
  registry: Pick<WebAuditRegistry, 'category_order' | 'categories' | 'checks' | 'alternatives'>;
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
      ...(r.unprobed === true ? { unprobed: true as const } : {}),
      evidence: r.evidence === '' ? null : r.evidence,
      ...rowHostFields(r.raw_evidence),
    });
  }

  const universeMax = universeMaxOf(meta.registry, results, meta.scoreConfig);
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
    public_listing: meta.publicListing ?? false,
    ...(meta.followDeclarations !== undefined ? { follow_declarations: meta.followDeclarations } : {}),
    ...(meta.declaredHosts !== undefined ? { declared_hosts: meta.declaredHosts } : {}),
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
