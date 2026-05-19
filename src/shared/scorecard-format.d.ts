// Type declarations for src/shared/scorecard-format.mjs.
// Keeps the implementation in a single .mjs file (importable by both the
// Node build and the Worker bundle) while giving the Worker's TypeScript
// callers proper type checking. Pair this with the .mjs implementation —
// changes to one need a mirroring change to the other.

export type CheckResultLike = {
  status: 'pass' | 'fail' | 'warn' | 'skip' | string;
  label: string;
  group: string;
  evidence: string | null;
};

export type ScorecardLike = {
  results?: CheckResultLike[];
};

export function escHtml(s: unknown): string;

export const PRINCIPLE_NAMES: Record<string, string>;
export const PRINCIPLE_GROUPS: string[];
export const BONUS_GROUPS: string[];

export function groupToPrincipleNum(group: string): number | null;

export function extractTopIssues<T extends CheckResultLike = CheckResultLike>(
  scorecard: { results?: T[] } | null | undefined,
  limit?: number,
): T[];

export function formatCheckRowMarkdown(check: CheckResultLike, opts?: { baseUrl?: string }): string;

export function formatCheckTableMarkdownLines(checks: CheckResultLike[], opts?: { baseUrl?: string }): string[];
