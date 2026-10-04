// The derived record both web result-page renderers read, as types: what
// the summary model resolves a stored scorecard into.

import type { NaReason } from '../../shared/web-audit-findings';
import type { DeclaredHostEntry, FollowState } from './provenance';
import type { WebRemediationResource } from './remediation';
import type { Rich } from './rich-text';
import type { ScorecardStatus } from './scorecard';
import type { DeclaredHostsView } from './summary-trail';

/** Why a row was not run, and the host it names. */
export type NotRun = { reason: NaReason; host: string };

/** One check row with its remediation already resolved. */
export type SummaryRow = {
  id: string;
  label: string;
  keyword?: string;
  tier?: string;
  status: ScorecardStatus;
  unprobed: boolean;
  /** The run observed the surface and its status warrants a fix prompt. */
  fixable: boolean;
  result: string;
  goal: string;
  /** Raw catalog text: HTML escapes it, markdown flattens it. */
  fix: string;
  prompt: string;
  skillUrl: string;
  resources: WebRemediationResource[];
  /** The host or hosts the row reads as evaluated at, space-separated. */
  host: string;
  /** The hosts the row recorded; empty for a row that recorded none. */
  recordedHosts: string[];
  /** Set when the row reached a host other than the one its category names. */
  hostNote: Rich | null;
  notRun: NotRun | null;
  /** Why the public audit could not run the row, and how to run it; shown when the row is not in a group. */
  remedy: Rich | null;
};

/** Three or more rows not run for one reason at one host, rendered as one closed group. */
export type SummaryGroup = { kind: 'group'; label: string; name: string; remedy: Rich; rows: SummaryRow[] };

export type SummaryItem = { kind: 'row'; row: SummaryRow } | SummaryGroup;

type Counts = { passed: number; counted: number; notRun: number };

/** One protocol lane's rows inside a category, with its own rollup. */
export type SummaryLane = Counts & {
  id: string;
  label: string;
  note: string;
  rows: SummaryRow[];
  items: SummaryItem[];
};

/** A not-run reason a category's rows share, stated once with its remedy. */
export type NotRunSentence = { text: string; remedy: Rich };

export type SummaryCategory = Counts & {
  id: string;
  name: string;
  rows: SummaryRow[];
  items: SummaryItem[];
  /** Present when the registry files this category's checks under lanes; rows then render by lane. */
  lanes?: SummaryLane[];
  hostLine: Rich | null;
  /** For a category with nothing counted, the not-run reason most of its rows share. */
  emptyReason: string | null;
  notRunSentences: NotRunSentence[];
};

export type WebSummaryModel = {
  name: string;
  targetUrl: string;
  relative: number;
  global: number;
  counts: Record<ScorecardStatus, number>;
  categories: SummaryCategory[];
  followDeclarations: FollowState;
  /** Null when the scorecard recorded no trail, which is not the same as an empty one. */
  declaredHosts: DeclaredHostEntry[] | null;
  declaredHostsView: DeclaredHostsView;
  /** The score note's clause naming the declared hosts the audit evaluated; null when it evaluated none. */
  hostsClause: Rich | null;
  /** The score note's sentence about rows the public audit could not run; null when it ran them all. */
  notRunNote: Rich | null;
  /** Null when the registry version the score was computed under is unknown. */
  registryFingerprint: string | null;
};
