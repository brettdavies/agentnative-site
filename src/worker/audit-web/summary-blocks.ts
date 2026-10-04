// The blocks a category's rows render in: the MCP category's protocol lanes,
// or the whole category elsewhere. Inside a block, three or more rows the
// audit could not run for one reason at one host collapse into one closed
// group that still holds every row, so the page states the reason once and
// every reader of the rows still finds all of them.

import { naReasonPhrase, notRunWhy } from '../../shared/web-audit-findings';
import { notRunGroupLabel, notRunGroupName, notRunRemedy } from './provenance-copy';
import type { McpLaneSpec } from './registry';
import type { Rich } from './rich-text';
import { SCORED_STATUSES } from './score';
import type { SummaryRegistry } from './summary-model';
import type { NotRunSentence, SummaryGroup, SummaryItem, SummaryLane, SummaryRow } from './summary-types';

/** Rows sharing a not-run reason and host group from this many. */
const GROUP_MIN = 3;

/** Each lane-filed check's lane and its position in registry order, by check id. */
type LanePlacement = Map<string, { lane: string; index: number }>;

export function lanePlacement(registry: SummaryRegistry | undefined): LanePlacement {
  const placement: LanePlacement = new Map();
  const lanes = registry?.mcp_lanes ?? {};
  registry?.checks.forEach((check, index) => {
    if (check.lane && Object.hasOwn(lanes, check.lane)) placement.set(check.id, { lane: check.lane, index });
  });
  return placement;
}

type Rollup = { passed: number; counted: number; notRun: number };

export function rollupOf(rows: readonly SummaryRow[]): Rollup {
  const counted = rows.filter((row) => SCORED_STATUSES.has(row.status));
  return {
    passed: counted.filter((row) => row.status === 'pass').length,
    counted: counted.length,
    notRun: rows.filter((row) => row.notRun !== null).length,
  };
}

function notRunKey(row: SummaryRow): string | null {
  return row.notRun === null ? null : `${row.notRun.reason} ${row.notRun.host}`;
}

/**
 * A block's rows in order, with each set of three or more that share a
 * not-run reason and host gathered into one group where its first row sits.
 */
export function blockItems(rows: readonly SummaryRow[], domain: string): SummaryItem[] {
  const sizes = new Map<string, number>();
  for (const row of rows) {
    const key = notRunKey(row);
    if (key !== null) sizes.set(key, (sizes.get(key) ?? 0) + 1);
  }
  const items: SummaryItem[] = [];
  const groups = new Map<string, SummaryGroup>();
  for (const row of rows) {
    const key = notRunKey(row);
    if (key === null || row.notRun === null || (sizes.get(key) ?? 0) < GROUP_MIN) {
      items.push({ kind: 'row', row });
      continue;
    }
    const open = groups.get(key);
    if (open) {
      open.rows.push(row);
      continue;
    }
    const { reason, host } = row.notRun;
    const count = sizes.get(key) ?? 0;
    const why = notRunWhy(reason, host);
    const group: SummaryGroup = {
      kind: 'group',
      label: notRunGroupLabel(count, why),
      name: notRunGroupName(count, why),
      remedy: notRunRemedy(reason, host, domain, count),
      rows: [row],
    };
    groups.set(key, group);
    items.push(group);
  }
  return items;
}

/**
 * Split a category's rows into the registry's lanes, in lane-map order, with
 * rows in registry order inside each lane. Stored rows sit in the order their
 * probes completed, which says nothing a reader can use. A row whose id the
 * registry no longer carries lands in the first lane, after the known rows. A
 * category none of whose rows the registry files under a lane gets none.
 */
export function laneBlocks(
  rows: readonly SummaryRow[],
  lanes: Record<string, McpLaneSpec>,
  placement: LanePlacement,
  domain: string,
): SummaryLane[] | undefined {
  if (!rows.some((row) => placement.has(row.id))) return undefined;
  const laneIds = Object.keys(lanes);
  const byLane = new Map<string, SummaryRow[]>(laneIds.map((id) => [id, []]));
  const positionOf = (row: SummaryRow) => placement.get(row.id)?.index ?? 0;
  const known = rows.filter((row) => placement.has(row.id)).sort((a, b) => positionOf(a) - positionOf(b));
  for (const row of known) byLane.get(placement.get(row.id)?.lane ?? laneIds[0])?.push(row);
  byLane.get(laneIds[0])?.push(...rows.filter((row) => !placement.has(row.id)));
  return [...byLane]
    .filter(([, laneRows]) => laneRows.length > 0)
    .map(([id, laneRows]) => ({
      id,
      label: lanes[id].label,
      note: lanes[id].note,
      ...rollupOf(laneRows),
      rows: laneRows,
      items: blockItems(laneRows, domain),
    }));
}

/**
 * The reason an empty category gives in place of "does not apply": the
 * phrase most of its `n_a` rows share, when they share one.
 */
export function emptyCategoryReason(rows: readonly SummaryRow[]): string | null {
  const notApplicable = rows.filter((row) => row.status === 'n_a');
  const tally = new Map<string, { row: SummaryRow; count: number }>();
  for (const row of notApplicable) {
    const key = notRunKey(row);
    if (key === null) continue;
    const seen = tally.get(key);
    tally.set(key, { row, count: (seen?.count ?? 0) + 1 });
  }
  for (const { row, count } of tally.values()) {
    if (row.notRun !== null && count * 2 > notApplicable.length) {
      return naReasonPhrase(row.notRun.reason, row.notRun.host);
    }
  }
  return null;
}

/**
 * One sentence per not-run reason and host that formed a group in any of a
 * category's blocks, counting every row in the category that shares it, so
 * the markdown twin, which lists every row, still states the reason once.
 */
export function notRunSentences(
  rows: readonly SummaryRow[],
  blocks: ReadonlyArray<readonly SummaryItem[]>,
  domain: string,
): NotRunSentence[] {
  const grouped = new Set<string>();
  for (const items of blocks) {
    for (const item of items) {
      const key = item.kind === 'group' ? notRunKey(item.rows[0]) : null;
      if (key !== null) grouped.add(key);
    }
  }
  const sentences: NotRunSentence[] = [];
  for (const key of grouped) {
    const members = rows.filter((row) => notRunKey(row) === key);
    const first = members[0]?.notRun;
    if (first === undefined || first === null) continue;
    sentences.push({
      text: `${notRunGroupLabel(members.length, notRunWhy(first.reason, first.host))}.`,
      remedy: notRunRemedy(first.reason, first.host, domain, members.length),
    });
  }
  return sentences;
}

/** The remedy a not-run row carries when it renders on its own rather than in a group. */
export function rowRemedy(row: Pick<SummaryRow, 'notRun'>, domain: string): Rich | null {
  return row.notRun === null ? null : notRunRemedy(row.notRun.reason, row.notRun.host, domain, 1);
}
