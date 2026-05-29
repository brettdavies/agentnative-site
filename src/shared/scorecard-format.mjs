// Worker-safe shared primitives used by BOTH the build (scorecards-render.mjs,
// runs in Node) AND the Worker (src/worker/score/summary-render.ts, runs in
// the Cloudflare runtime).
//
// Single source of truth for:
//   - HTML escape (escHtml)
//   - Principle name + group constants (PRINCIPLE_NAMES, PRINCIPLE_GROUPS, BONUS_GROUPS)
//   - groupToPrincipleNum derivation
//   - topIssues extractor (FAIL > WARN, capped)
//   - The shared markdown-summary builder used by /live-score/<binary>.md and
//     the head of the static /score/<tool>.md page
//
// Pure module — no Node imports, no fs reads, no `process.env`. Lives under
// `src/shared/` so the dependency direction is obvious: build code and worker
// code both depend on `shared/`, never the other way around.

/**
 * Escape HTML special characters. Used at every server→client boundary that
 * embeds scorecard fields (some of which come from CLI evidence strings the
 * tool author wrote in their --help output).
 *
 * @param {string} s
 * @returns {string}
 */
export function escHtml(s) {
  return String(s).replace(
    /[<>&"']/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

/** Map of principle group code → human-readable name. */
export const PRINCIPLE_NAMES = {
  P1: 'Non-Interactive by Default',
  P2: 'Structured, Parseable Output',
  P3: 'Progressive Help Discovery',
  P4: 'Fail-Fast, Actionable Errors',
  P5: 'Safe Retries & Mutation Boundaries',
  P6: 'Composable, Predictable Command Structure',
  P7: 'Bounded, High-Signal Responses',
};

export const PRINCIPLE_GROUPS = Object.keys(PRINCIPLE_NAMES);

export const BONUS_GROUPS = ['CodeQuality', 'ProjectStructure'];

// Display labels for the 7-status taxonomy (scorecard schema 0.6). Two values
// carry punctuation a bare `.toUpperCase()` can't produce: `opt_out` → `OPT-OUT`
// and `n_a` → `N/A`. Both the HTML check rows (scorecards-render.mjs) and the
// markdown twin (formatCheckRowMarkdown) read from here so the two surfaces
// stay byte-aligned. Unknown statuses fall back to uppercase, so a future CLI
// status renders legibly before this map learns about it.
const STATUS_LABELS = {
  pass: 'PASS',
  warn: 'WARN',
  fail: 'FAIL',
  opt_out: 'OPT-OUT',
  n_a: 'N/A',
  skip: 'SKIP',
  error: 'ERROR',
};

/**
 * Map a check status to its display label.
 *
 * @param {string} status
 * @returns {string}
 */
export function statusLabel(status) {
  return STATUS_LABELS[status] ?? String(status).toUpperCase();
}

/**
 * Map a check group string like "P3" to a principle number (3), or null
 * for bonus groups (CodeQuality / ProjectStructure).
 *
 * @param {string} group
 * @returns {number | null}
 */
export function groupToPrincipleNum(group) {
  const m = group.match(/^P(\d+)$/);
  return m ? Number(m[1]) : null;
}

/**
 * Extract the top failing/warning checks from a scorecard, FAIL before WARN.
 * Used by both the build (per-tool page top-issues block) and the Worker
 * (live-score summary top-issues block).
 *
 * @template {{ status: string; label: string; group: string; evidence: string | null }} T
 * @param {{ results?: T[] }} scorecard
 * @param {number} limit
 * @returns {T[]}
 */
export function extractTopIssues(scorecard, limit = 3) {
  if (!scorecard || !Array.isArray(scorecard.results)) return [];
  const issues = scorecard.results.filter((r) => r.status === 'fail' || r.status === 'warn');
  const order = { fail: 0, warn: 1 };
  issues.sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9));
  return issues.slice(0, limit);
}

/**
 * Format a single check as a markdown table row. Both the static
 * `/score/<tool>.md` (full check table) and the live `/live-score/<binary>.md`
 * (top-3 issues table) emit the same row shape, so this is the single
 * source of truth.
 *
 * Principle group codes (`P1..P7`) link to the principle page; bonus
 * groups (`CodeQuality`, `ProjectStructure`) stay as plain text. Evidence
 * and label strings have `|` escaped so user-controlled evidence with
 * pipes (shell pipelines, table syntax) doesn't fracture the table.
 *
 * Links use a site-relative path by default. Callers serving markdown
 * twins that may be fetched cross-origin can pass an absolute baseUrl
 * (e.g., `https://anc.dev`); absolutifyMarkdownLinks does the same
 * rewrite for site-relative `(/path)` links after the fact, so either
 * call style produces a self-resolving twin.
 *
 * @param {{ status: string; label: string; group: string; evidence: string | null }} check
 * @param {{ baseUrl?: string }} [opts]
 * @returns {string}
 */
export function formatCheckRowMarkdown(check, opts = {}) {
  const baseUrl = (opts.baseUrl ?? '').replace(/\/$/, '');
  const pNum = groupToPrincipleNum(check.group);
  const groupLabel = pNum ? `[${check.group}](${baseUrl}/p${pNum})` : check.group;
  const evidence = (check.evidence ?? '').replaceAll('|', '\\|');
  const label = check.label.replaceAll('|', '\\|');
  return `| ${statusLabel(check.status)} | ${label} | ${groupLabel} | ${evidence} |`;
}

/**
 * Emit a complete markdown check table (header + rows). When `checks` is
 * empty, returns an empty array so the caller can decide what to put in
 * its place (e.g., a "no issues" message).
 *
 * @param {Array<{status:string,label:string,group:string,evidence:string|null}>} checks
 * @param {{ baseUrl?: string }} [opts]
 * @returns {string[]} markdown lines
 */
export function formatCheckTableMarkdownLines(checks, opts = {}) {
  if (checks.length === 0) return [];
  return [
    '| Status | Check | Principle | Evidence |',
    '|--------|-------|-----------|----------|',
    ...checks.map((c) => formatCheckRowMarkdown(c, opts)),
  ];
}
