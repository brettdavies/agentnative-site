// WebMCP tools for a rendered /web/<domain> result page. Every tool
// reads the page and nothing else: no fetch, no form submission, no
// navigation. Filtering, ordering, and pagination come from the shared
// finding selector, so an agent and the on-page widget answer from one
// rule set. Results are JSON envelopes that mirror the page's own
// freshness, and pages carry whole items — a page never slices its own
// JSON to fit the output cap.

import {
  FINDING_KEYWORDS,
  FINDING_STATUSES,
  FINDING_VALUE_MAX,
  type FindingRow,
  type FindingStatus,
  fitPromptToBudget,
  isRemediable,
  normalizeFindingQuery,
  orderFindings,
  selectFindings,
} from '../shared/web-audit-findings';
import { findingRowsFromElements } from './assemble-prompt';
import { capExecute, EXECUTE_MAX, packPage, pageDoc, type ToolsForOpts, type WebMcpTool } from './webmcp-lib';

type Freshness = { cached: boolean; scored_at: string | null; refresh_after: string | null };

export type AuditContext = Freshness & {
  site_score: number | null;
  global_score: number | null;
  counts: Record<FindingStatus, number>;
};

export function findingRows(doc: Document): FindingRow[] {
  return findingRowsFromElements(doc.querySelectorAll('.web-check[data-id]'));
}

function numberAttr(el: Element, name: string): number | null {
  const raw = el.getAttribute(name);
  if (raw === null || raw.length === 0) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/**
 * Read the page-level audit context. A missing instant attribute is
 * rendered as an absent attribute, never an empty string, so it reads
 * back as null.
 */
export function auditContext(doc: Document): AuditContext | null {
  const el = doc.querySelector('[data-web-audit-context]');
  if (!el) return null;
  const counts = {} as Record<FindingStatus, number>;
  for (const status of FINDING_STATUSES) counts[status] = numberAttr(el, `data-count-${status}`) ?? 0;
  return {
    site_score: numberAttr(el, 'data-site-score'),
    global_score: numberAttr(el, 'data-global-score'),
    cached: el.getAttribute('data-cached') === 'true',
    scored_at: el.getAttribute('data-scored-at'),
    refresh_after: el.getAttribute('data-refresh-after'),
    counts,
  };
}

function freshnessOf(ctx: AuditContext | null): Freshness {
  if (!ctx) return { cached: false, scored_at: null, refresh_after: null };
  return { cached: ctx.cached, scored_at: ctx.scored_at, refresh_after: ctx.refresh_after };
}

function errorResult(code: string, field: string, message: string, allowed?: readonly string[]): string {
  return capExecute(JSON.stringify({ ok: false, error: { code, field, message, allowed } }));
}

/** Why a selected row hands back no prompt (R6, R7). */
function skipReason(row: FindingRow): string {
  if (row.unprobed) return 'this run did not probe the check, so it observed nothing to fix';
  if (!isRemediable(row)) return `status ${row.status} needs no fix prompt`;
  return 'the page renders no fix prompt for this row';
}

export function getWorksheet(doc: Document, input: Record<string, unknown>): string {
  const selection = selectFindings(findingRows(doc), input);
  if (!selection.ok) {
    return errorResult(selection.error.code, selection.error.field, selection.error.message, selection.error.allowed);
  }
  return packPage({
    head: freshnessOf(auditContext(doc)),
    offset: selection.query.offset,
    total: selection.total,
    items: selection.items.map((row) => ({
      id: row.id,
      keyword: row.keyword,
      tier: row.tier,
      status: row.status,
      unprobed: row.unprobed,
      result: row.result,
      remediable: isRemediable(row) && row.prompt !== null,
    })),
  });
}

/**
 * Room one batch item's prompt may occupy: the cap less the page metadata,
 * freshness envelope, and the item's own keys. Read through a function
 * because webmcp-lib imports this module back, so a module-scope constant
 * would evaluate before EXECUTE_MAX is initialized.
 */
function batchPromptBudget(): number {
  return EXECUTE_MAX - 420;
}

/** The pointer the trimmed prompt sends a reader to for the untruncated fix. */
function skillUrlFor(id: string): string {
  const origin = typeof location !== 'undefined' && location.origin ? location.origin : 'https://anc.dev';
  return `${origin}/web-audit/skill/${id}`;
}

export function getFixPrompt(doc: Document, input: Record<string, unknown>): string {
  if (typeof input.id !== 'string' || input.id.length === 0) {
    return errorResult('invalid_input', 'id', 'id must be a non-empty string');
  }
  // The unknown-id answer echoes the id, so an id longer than any the
  // page could render is rejected before it can crowd out the envelope.
  if (input.id.length > FINDING_VALUE_MAX) {
    return errorResult('invalid_input', 'id', `id must be ${FINDING_VALUE_MAX} characters or fewer`);
  }
  const fresh = freshnessOf(auditContext(doc));
  const row = findingRows(doc).find((candidate) => candidate.id === input.id);
  if (!row) {
    return capExecute(
      JSON.stringify({
        ok: true,
        ...fresh,
        found: false,
        id: input.id,
        reason: 'no check with this id is rendered on this page',
      }),
    );
  }
  const head = {
    ok: true,
    ...fresh,
    found: true,
    id: row.id,
    keyword: row.keyword,
    tier: row.tier,
    status: row.status,
    unprobed: row.unprobed,
  };
  // The finding appears once per item: inside the prompt's evidence block
  // when there is a prompt, on the result line when there is not.
  const remediable = isRemediable(row) && row.prompt !== null;
  const body = remediable
    ? { remediable, prompt: row.prompt }
    : { remediable, reason: skipReason(row), result: row.result };
  const text = JSON.stringify({ ...head, ...body });
  if (text.length <= EXECUTE_MAX) return text;
  // Over budget: trim the prompt's Fix line to what is left, keeping the
  // evidence block and the pointer whole, rather than dropping the item.
  if (remediable && row.prompt) {
    // Serialization inflates the prompt (every newline and quote escapes to
    // two characters), so the budget is converged on rather than computed:
    // fit, measure the real envelope, and give back what it overran.
    const shell = JSON.stringify({ ...head, remediable: true, prompt: '', prompt_truncated: true }).length;
    let budget = EXECUTE_MAX - shell;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const fitted = fitPromptToBudget(row.prompt, budget, skillUrlFor(row.id));
      if (!fitted) break;
      const trimmed = JSON.stringify({ ...head, remediable: true, prompt: fitted, prompt_truncated: true });
      if (trimmed.length <= EXECUTE_MAX) return trimmed;
      budget -= trimmed.length - EXECUTE_MAX;
    }
  }
  return errorResult('too_large', 'id', `the prompt for ${row.id} exceeds the ${EXECUTE_MAX}-character output cap`);
}

export function getFixPrompts(doc: Document, input: Record<string, unknown>): string {
  const selection = selectFindings(findingRows(doc), input);
  if (!selection.ok) {
    return errorResult(selection.error.code, selection.error.field, selection.error.message, selection.error.allowed);
  }
  return packPage({
    head: freshnessOf(auditContext(doc)),
    offset: selection.query.offset,
    total: selection.total,
    items: selection.items.map((row) => {
      const base = { id: row.id, status: row.status };
      // A remediable item carries its finding inside the prompt's evidence
      // block; a skipped one has no prompt, so it carries the result line.
      if (isRemediable(row) && row.prompt !== null) {
        // Trim to a per-item ceiling so one oversized prompt can still be
        // returned, rather than packing to zero items and stranding it.
        const fitted = fitPromptToBudget(row.prompt, batchPromptBudget(), skillUrlFor(row.id));
        if (fitted === null) return { ...base, remediable: false, reason: 'prompt exceeds the output cap' };
        if (fitted !== row.prompt) return { ...base, remediable: true, prompt: fitted, prompt_truncated: true };
        return { ...base, remediable: true, prompt: fitted };
      }
      return { ...base, remediable: false, reason: skipReason(row), result: row.result };
    }),
  });
}

export function getAuditSummary(doc: Document, input: Record<string, unknown>): string {
  const ctx = auditContext(doc);
  if (!ctx) {
    return errorResult('no_audit_context', 'document', 'this page renders no web-audit context');
  }
  // The issue set is fixed, so only the page window is caller-supplied.
  const query = normalizeFindingQuery({ offset: input.offset, limit: input.limit });
  if (!query.ok) {
    return errorResult(query.error.code, query.error.field, query.error.message, query.error.allowed);
  }
  // An `error` row is a finding an agent must see and cannot fix: the
  // check never produced an observation, so it joins the issue list
  // marked non-remediable rather than hiding among the passes.
  const issues = orderFindings(findingRows(doc).filter((row) => isRemediable(row) || row.status === 'error'));
  const { offset, limit } = query.query;
  return packPage({
    head: {
      ...freshnessOf(ctx),
      site_score: ctx.site_score,
      global_score: ctx.global_score,
      counts: ctx.counts,
    },
    offset,
    total: issues.length,
    key: 'issues',
    items: issues.slice(offset, offset + limit).map((row) => ({
      id: row.id,
      keyword: row.keyword,
      tier: row.tier,
      status: row.status,
      result: row.result,
      remediable: isRemediable(row) && row.prompt !== null,
    })),
  });
}

const FILTER_PROPERTIES = {
  ids: { type: 'array', items: { type: 'string' } },
  keywords: { type: 'array', items: { type: 'string', enum: [...FINDING_KEYWORDS] } },
  statuses: { type: 'array', items: { type: 'string', enum: [...FINDING_STATUSES] } },
};

const PAGE_PROPERTIES = {
  offset: { type: 'integer', minimum: 0 },
  limit: { type: 'integer', minimum: 1, maximum: 25 },
};

function selectionSchema(withFilters: boolean): Record<string, unknown> {
  return {
    type: 'object',
    properties: withFilters ? { ...FILTER_PROPERTIES, ...PAGE_PROPERTIES } : { ...PAGE_PROPERTIES },
    additionalProperties: false,
  };
}

const FILTER_DOC =
  'Optional filters: ids, keywords (must|should|may), statuses (pass|noncompliant|broken|absent|n_a|skip|error). ' +
  'Values OR within a filter and AND across filters; omitting statuses selects the observed fixable rows. ' +
  'Page with offset (>=0) and limit (1-25, default 10); follow next_offset until it is null.';

export function resultTools(opts: ToolsForOpts): WebMcpTool[] {
  return [
    {
      name: 'get_worksheet',
      description: `List findings on this scorecard as JSON rows of id, keyword, tier, status, unprobed, remediable. ${FILTER_DOC}`,
      inputSchema: selectionSchema(true),
      annotations: { readOnlyHint: true },
      execute(input) {
        return getWorksheet(pageDoc(opts), input);
      },
    },
    {
      name: 'get_fix_prompt',
      description:
        'Return the stored fix prompt for one check id. Reads the rendered page; it does not click Copy. A known ' +
        'row that needs no fix, or that this run never probed, comes back with remediable:false and a reason; an ' +
        'id the page does not render comes back with found:false.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
      execute(input) {
        return getFixPrompt(pageDoc(opts), input);
      },
    },
    {
      name: 'get_fix_prompts',
      description: `Return fix prompts for many checks at once. Selected rows that need no fix come back with remediable:false and a reason instead of a prompt. ${FILTER_DOC}`,
      inputSchema: selectionSchema(true),
      annotations: { readOnlyHint: true },
      execute(input) {
        return getFixPrompts(pageDoc(opts), input);
      },
    },
    {
      name: 'get_audit_summary',
      description:
        'Return this audit at a glance: site and global scores, counts for all seven statuses, cache freshness, ' +
        'and the paged issue list (every observed fixable row plus error rows, which are marked remediable:false). ' +
        'Page with offset (>=0) and limit (1-25, default 10); follow next_offset until it is null.',
      inputSchema: selectionSchema(false),
      annotations: { readOnlyHint: true },
      execute(input) {
        return getAuditSummary(pageDoc(opts), input);
      },
    },
  ];
}
