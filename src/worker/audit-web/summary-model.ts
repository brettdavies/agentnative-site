// The derived record both web result-page renderers read.
//
// The HTML page and its markdown twin present the same audit, so every fact
// they share is computed once here and consumed twice, rather than derived
// independently on each side where the two can drift. That drift is not
// hypothetical on this surface: the page's status chips and its
// machine-readable context element were each counting the rows themselves,
// so a change to one had no way of reaching the other.

import { isNotRunReason, type NaReason, type RowAdvisory } from '../../shared/web-audit-findings';
import { resultLine } from '../../shared/web-audit-result-line';
import { type RetiredIds, successorOf } from './display';
import {
  entryHostOf,
  type RowHost,
  readDeclaredHosts,
  readFollowState,
  readRegistryFingerprint,
  recordedHostOf,
  recordedHostsOf,
  rowHostOf,
  rowHostOutcomes,
  rowHostsOf,
} from './provenance';
import { scoreHostsClause } from './provenance-copy';
import type { McpLaneSpec, WebAuditDiscoveryConfig } from './registry';
import { assembleRemediation, isFixableStatus, type WebRemediationCatalog } from './remediation';
import { type CardLocations, retiredNote, supersededNote } from './row-notes';
import type { ScorecardStatus } from './scorecard';
import {
  blockItems,
  emptyCategoryReason,
  laneBlocks,
  lanePlacement,
  notRunSentences,
  rollupOf,
  rowRemedy,
} from './summary-blocks';
import { STATUS_ORDER } from './summary-labels';
import { categoryProvenance, notRunNote, openapiHosts } from './summary-provenance';
import { declaredHostsView, evaluatedHosts } from './summary-trail';
import type { NotRun, SummaryRow, WebSummaryModel } from './summary-types';

export type WebScorecardRow = {
  id: string;
  label: string;
  category?: string;
  keyword?: string;
  tier?: string;
  status: ScorecardStatus;
  na_reason?: NaReason;
  unprobed?: true;
  advisory?: RowAdvisory;
  evidence: string | null;
  hosts?: RowHost[];
  host?: string;
};

export type WebScorecardShape = {
  spec_version?: string;
  target_url?: string;
  mcp_endpoint?: unknown;
  tool?: { name?: string; url?: string };
  mcp_discovery?: unknown;
  follow_declarations?: unknown;
  declared_hosts?: unknown;
  registry_fingerprint?: unknown;
  score_pct?: number;
  score?: { relative?: number; global?: number };
  categories?: Array<{ id: string; name: string; passed: number; counted: number }>;
  results?: WebScorecardRow[];
};

/** The registry fields lane grouping, retired rows, and the card guidance read; a full registry satisfies it. */
export interface SummaryRegistry {
  mcp_lanes?: Record<string, McpLaneSpec>;
  mcp_discovery?: Pick<WebAuditDiscoveryConfig, 'card_suffix' | 'ai_catalog'>;
  retired?: RetiredIds;
  checks: ReadonlyArray<{ id: string; lane?: string }>;
}

export interface WebSummaryModelInput {
  scorecard: WebScorecardShape;
  domain: string;
  targetUrl: string;
  name?: string;
  remediation?: WebRemediationCatalog;
  /** The live registry, whose lanes group stored rows regardless of when they were scored. */
  registry?: SummaryRegistry;
  origin: string;
  /** The result renders in place of a saved page, so a follow state of off was this run's choice. */
  transient?: boolean;
  /** When the audit ran, if known. */
  scoredAt?: string | null;
}

function scoresOf(scorecard: WebScorecardShape): { relative: number; global: number } {
  return {
    relative: scorecard.score?.relative ?? scorecard.score_pct ?? 0,
    global: scorecard.score?.global ?? 0,
  };
}

function countsOf(rows: readonly WebScorecardRow[]): Record<ScorecardStatus, number> {
  const counts = {} as Record<ScorecardStatus, number>;
  for (const status of STATUS_ORDER) counts[status] = 0;
  for (const row of rows) counts[row.status] = (counts[row.status] ?? 0) + 1;
  return counts;
}

/** A row earns a fix prompt only when the run actually observed the surface and its check is still scored. */
function isFixable(row: WebScorecardRow, retired: boolean): boolean {
  return !retired && row.unprobed !== true && isFixableStatus(row.status);
}

/** What a row's own notes read from beyond the row: the scorecard's endpoint and the live registry. */
type RowNoteInput = { endpoint: string | null; locations: CardLocations | null; retired: RetiredIds | undefined };

function notRunOf(row: WebScorecardRow, entryHost: string): NotRun | null {
  return row.status === 'n_a' && isNotRunReason(row.na_reason)
    ? { reason: row.na_reason, host: rowHostOf(row, entryHost) }
    : null;
}

/**
 * A row whose check id is retired reads its successor's goal and fix page,
 * because a re-audit scores the successor; it keeps its own label and the
 * status its run stored.
 */
function summaryRow(
  row: WebScorecardRow,
  catalog: WebRemediationCatalog,
  input: { origin: string; entryHost: string; domain: string } & RowNoteInput,
): SummaryRow {
  const successor = successorOf(row.id, input.retired);
  const checkId = successor ?? row.id;
  const entry = catalog[checkId];
  const assembled = assembleRemediation(entry, {
    checkId,
    origin: input.origin,
    evidence: row.evidence,
    host: recordedHostOf(row),
  });
  const notRun = notRunOf(row, input.entryHost);
  return {
    id: row.id,
    label: row.label,
    keyword: row.keyword,
    tier: row.tier,
    status: row.status,
    unprobed: row.unprobed === true,
    fixable: isFixable(row, successor !== undefined),
    result: resultLine(row.status, row.evidence, row.na_reason, rowHostOf(row, input.entryHost), rowHostOutcomes(row)),
    goal: entry?.goal ?? assembled.goal,
    fix: assembled.fix,
    prompt: assembled.prompt,
    skillUrl: assembled.skill_url,
    resources: assembled.resources,
    host: rowHostsOf(row, input.entryHost).join(' '),
    recordedHosts: recordedHostsOf(row),
    hostNote: null,
    advisoryNote: row.advisory === 'superseded' ? supersededNote(input.endpoint, input.locations) : null,
    retiredNote: successor === undefined ? null : retiredNote(successor),
    notRun,
    remedy: rowRemedy({ notRun }, input.domain),
  };
}

/**
 * Resolve one stored scorecard into the record both renderers read. Rows are
 * grouped by the category order the scorecard carries; a category with no
 * matching rows still appears, because an empty category is a rendered state
 * rather than an omission.
 */
export function webSummaryModel(input: WebSummaryModelInput): WebSummaryModel {
  const sc = input.scorecard;
  const catalog = input.remediation ?? {};
  const rows = sc.results ?? [];
  const { relative, global: globalScore } = scoresOf(sc);
  const lanes = input.registry?.mcp_lanes ?? {};
  const placement = lanePlacement(input.registry);
  const entryHost = entryHostOf(sc.target_url) ?? input.domain;
  const follow = readFollowState(sc.follow_declarations);
  const trail = readDeclaredHosts(sc.declared_hosts);
  const trailInput = { trail, discovery: sc.mcp_discovery, domain: input.domain };

  const notes: RowNoteInput = {
    endpoint: typeof sc.mcp_endpoint === 'string' ? sc.mcp_endpoint : null,
    locations: input.registry?.mcp_discovery ?? null,
    retired: input.registry?.retired,
  };
  const summaryRows = rows.map((row) =>
    summaryRow(row, catalog, { origin: input.origin, entryHost, domain: input.domain, ...notes }),
  );
  const byCategory = new Map<string, SummaryRow[]>();
  rows.forEach((row, i) => {
    const bucket = byCategory.get(row.category ?? '') ?? [];
    bucket.push(summaryRows[i]);
    byCategory.set(row.category ?? '', bucket);
  });

  const hostCount = follow === 'on' ? evaluatedHosts(trail).length : 0;
  return {
    name: input.name ?? sc.tool?.name ?? input.domain,
    targetUrl: sc.tool?.url ?? input.targetUrl,
    relative,
    global: globalScore,
    counts: countsOf(rows),
    categories: (sc.categories ?? []).map((category) => {
      const located = categoryProvenance(byCategory.get(category.id) ?? [], entryHost, trailInput);
      const laneRows = laneBlocks(located.rows, lanes, placement, input.domain);
      const items = blockItems(located.rows, input.domain);
      const blocks = laneRows ? laneRows.map((lane) => lane.items) : [items];
      return {
        ...category,
        notRun: rollupOf(located.rows).notRun,
        rows: located.rows,
        items,
        ...(laneRows ? { lanes: laneRows } : {}),
        hostLine: located.hostLine,
        emptyReason: category.counted === 0 ? emptyCategoryReason(located.rows) : null,
        notRunSentences: notRunSentences(located.rows, blocks, input.domain),
      };
    }),
    followDeclarations: follow,
    declaredHosts: trail,
    declaredHostsView: declaredHostsView({
      ...trailInput,
      follow,
      transient: input.transient === true,
      openapiHosts: openapiHosts(rows, entryHost),
      scoredAt: input.scoredAt ?? null,
      locations: input.registry?.mcp_discovery ?? null,
    }),
    hostsClause: hostCount > 0 ? scoreHostsClause(hostCount) : null,
    notRunNote: notRunNote(summaryRows, input.domain),
    registryFingerprint: readRegistryFingerprint(sc.registry_fingerprint),
  };
}
