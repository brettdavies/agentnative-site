// Scorecard rendering — HTML and markdown builders for leaderboard and
// per-tool scorecard pages. Template concern only; data loading and
// scoring live in scorecards.mjs.

import {
  BONUS_GROUPS,
  escHtml,
  formatCheckTableMarkdownLines,
  groupToPrincipleNum,
  PRINCIPLE_GROUPS,
  PRINCIPLE_NAMES,
  statusLabel,
} from '../shared/scorecard-format.mjs';
import { BADGE_ELIGIBILITY_FLOOR_PCT } from './badge.mjs';

// Display-only mirror of the badge eligibility floor, imported from
// badge.mjs so the rendered floor and the color bands share one source.
// All eligibility decisions read `scorecard.badge.eligible` (canonical,
// CLI-emitted per schema 0.5/0.6); this constant only feeds human-readable
// copy ("badge floor is N%"). Functional gating stays correct regardless
// because it reads scorecard.badge.eligible directly.
const BADGE_FLOOR_DISPLAY_PCT = BADGE_ELIGIBILITY_FLOOR_PCT;

// groupToPrincipleNum lives in src/shared/scorecard-format.mjs (single source
// of truth shared with the Worker). Imported above.

// Evidence prefix the CLI emits for any check suppressed by `--audit-profile`.
// Mirrors `SUPPRESSION_EVIDENCE_PREFIX` in agentnative/src/principles/registry.rs
// — the trailing space is part of the documented contract; the CLI source calls
// out downstream site renderers as pinned consumers of this exact string.
const AUDIT_PROFILE_SUPPRESSION_PREFIX = 'suppressed by audit_profile: ';

// Format `run.duration_ms` as a human-readable interval. Granularity matches
// what's useful at a glance: sub-second runs in ms, multi-second runs in
// tenths, multi-minute runs in `Xm Ys`.
function formatDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

// Format an RFC 3339 timestamp as a calm UTC string for the per-tool page.
// Returns null on unparseable input — the caller drops the row rather than
// rendering a misleading "Invalid Date" placeholder.
function formatStartedAt(rfc3339) {
  if (typeof rfc3339 !== 'string') return null;
  const d = new Date(rfc3339);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.toISOString().replace('T', ' ').slice(0, 19)} UTC`;
}

// Build an HTML fragment for the `Anc build` detail row: version-only.
// The `anc.commit` field is captured by the CLI's build.rs but no longer
// surfaced here — see content/scorecard-schema.md.
function renderAncBuildHtml(anc) {
  if (!anc || typeof anc.version !== 'string') return null;
  return escHtml(anc.version);
}

// Markdown twin of renderAncBuildHtml.
function renderAncBuildMarkdown(anc) {
  if (!anc || typeof anc.version !== 'string') return null;
  return anc.version;
}

/**
 * Detect a Skip whose evidence indicates audit_profile suppression and extract
 * the category name. Returns `null` for organic Skips and non-Skip statuses.
 * @param {{ status: string, evidence: string | null }} check
 * @returns {string | null}
 */
function suppressionCategory(check) {
  if (check.status !== 'skip' || !check.evidence) return null;
  if (!check.evidence.startsWith(AUDIT_PROFILE_SUPPRESSION_PREFIX)) return null;
  return check.evidence.slice(AUDIT_PROFILE_SUPPRESSION_PREFIX.length);
}

/**
 * Render an array of checks as `<tr>` rows for a check-table.
 *
 * Skips emitted with evidence `"suppressed by audit_profile: <category>"` get
 * a `check--suppressed` class and an "N/A by &lt;category&gt;" status pill,
 * distinguishing category-scoped exclusions from organic Skips (e.g., "no flags exposed").
 *
 * The 7-status taxonomy (schema 0.6) routes `opt_out` and `n_a` through their
 * own `check--opt_out` / `check--n_a` classes and the shared statusLabel map,
 * so they render distinct from `skip`. Older 0.5 cards carry none of these and
 * are unaffected.
 *
 * @param {Array<{ status: string, label: string, evidence: string | null }>} checks
 * @returns {string}
 */
function renderCheckRows(checks) {
  return checks
    .map((check) => {
      const category = suppressionCategory(check);
      const rowClass = category ? 'check check--skip check--suppressed' : `check check--${check.status}`;
      const label = category ? `N/A by ${escHtml(category)}` : escHtml(statusLabel(check.status));
      const evidence = check.evidence ? escHtml(check.evidence) : '';
      return `        <tr class="${rowClass}">
          <td class="check__status">${label}</td>
          <td class="check__label">${escHtml(check.label)}</td>
          <td class="check__evidence">${evidence}</td>
        </tr>`;
    })
    .join('\n');
}

// -------------------------------------------------------------------
// HTML builders
// -------------------------------------------------------------------

/**
 * Build the leaderboard page body HTML.
 *
 * @param {Array} leaderboard — from computeLeaderboard()
 * @param {string} methodology — methodology prose HTML
 * @returns {string} HTML body
 */
export function buildLeaderboardBody(leaderboard, methodology) {
  const tierBadge = (tier) => `<span class="tier-badge tier-badge--${escHtml(tier)}">${escHtml(tier)}</span>`;

  // Every leaderboard entry has a scorecard (registry entries without
  // scorecards are excluded by loadScoredTools). The em-dash "—" / "—/7"
  // cells the pre-inversion code carried for unscored rows are gone with
  // the unscored row itself. Score read directly from schema 0.5
  // `badge.score_pct` — the CLI is canonical for the integer.
  const scoreCell = (entry) => {
    const pct = entry.scorecard.badge.score_pct;
    return `<td class="lb-score" data-sort="${pct}">${pct}%</td>`;
  };

  const principleCell = (entry) => {
    const ps = entry.principleScore;
    return `<td class="lb-principles" data-sort="${ps.met}">${ps.met}/${ps.total}</td>`;
  };

  const rows = leaderboard
    .map((entry) => {
      const audience = entry.scorecard?.audience ?? '';
      const auditProfile = entry.scorecard?.audit_profile ?? '';
      return `      <tr data-tier="${escHtml(entry.tool.tier)}" data-lang="${escHtml(entry.tool.language)}" data-audience="${escHtml(audience)}" data-audit-profile="${escHtml(auditProfile)}">
        <td class="lb-rank">${entry.rank}</td>
        <td class="lb-tool"><a href="/score/${escHtml(entry.tool.name)}">${escHtml(entry.tool.name)}</a></td>
        <td class="lb-desc">${escHtml(entry.tool.description)}</td>
        <td class="lb-tier">${tierBadge(entry.tool.tier)}</td>
        <td class="lb-lang">${escHtml(entry.tool.language)}</td>
        ${scoreCell(entry)}
        ${principleCell(entry)}
      </tr>`;
    })
    .join('\n');

  const tierCounts = {};
  for (const e of leaderboard) {
    tierCounts[e.tool.tier] = (tierCounts[e.tool.tier] || 0) + 1;
  }

  // Eligible-tool count for the badge callout. Reads scorecard.badge.eligible
  // (schema 0.5) — the CLI is canonical for what eligibility means. Lets the
  // callout cite a real number ("24 tools currently qualify") instead of a
  // vague "tools that qualify." Every leaderboard entry has a scorecard,
  // so no null guard needed.
  const eligibleCount = leaderboard.filter((e) => e.scorecard.badge.eligible).length;
  const floorPct = BADGE_FLOOR_DISPLAY_PCT;

  return `<section class="leaderboard-hero">
  <h1>ANC 100 — Agent-Native CLI Leaderboard</h1>
  <p class="leaderboard-hero__lede">Automated agent-readiness scores for real CLI tools, scored against the <a href="/">eight principles</a>. See the <a href="/methodology">methodology</a> for how scores, audience signals, and audit profiles work.</p>
  <p class="leaderboard-hero__meta">${leaderboard.length} audited tools in the corpus.</p>
</section>

<section class="leaderboard-controls" aria-label="Filters">
  <div class="tier-filters" role="group" aria-label="Filter by tier">
    <button type="button" class="tier-filter tier-filter--active" data-tier="all">All</button>
    <button type="button" class="tier-filter" data-tier="workhorse">Workhorse (${tierCounts.workhorse || 0})</button>
    <button type="button" class="tier-filter" data-tier="agent">Agent (${tierCounts.agent || 0})</button>
    <button type="button" class="tier-filter" data-tier="notable">Notable (${tierCounts.notable || 0})</button>
  </div>
  <label class="audience-filter">
    <input type="checkbox" class="audience-filter__input" data-filter="agent-optimized-only">
    <span class="audience-filter__label">Agent-optimized only</span>
  </label>
</section>

<section class="leaderboard-table-wrap">
  <table class="leaderboard-table" aria-label="CLI tool agent-readiness scores">
    <thead>
      <tr>
        <th class="lb-rank" data-sort-col="rank">#</th>
        <th class="lb-tool" data-sort-col="tool">Tool</th>
        <th class="lb-desc">Description</th>
        <th class="lb-tier">Tier</th>
        <th class="lb-lang">Lang</th>
        <th class="lb-score" data-sort-col="score">Score</th>
        <th class="lb-principles" data-sort-col="principles">Principles</th>
      </tr>
    </thead>
    <tbody>
${rows}
    </tbody>
  </table>
</section>

<section class="leaderboard-badge-callout" aria-label="Agent-native badge">
  <h2>Claim the badge</h2>
  <p>Tools at or above ${floorPct}% can embed the <a href="/badge">agent-native badge</a> on their README — a live link to their scorecard, not a static stamp. ${eligibleCount} of ${leaderboard.length} listed tools currently qualify.</p>
</section>

<section class="leaderboard-methodology">
  <h2>Methodology</h2>
${methodology}
</section>`;
}

/**
 * Render the three-way MUST/SHOULD/MAY coverage summary.
 * Returns empty string if the scorecard lacks `coverage_summary` (v1.0 compat).
 *
 * @param {object | undefined} coverageSummary — scorecard.coverage_summary
 * @returns {string} HTML fragment
 */
export function renderCoverageSummary(coverageSummary) {
  if (!coverageSummary) return '';

  const row = (label, data) =>
    `      <tr>
        <td><strong>${escHtml(label)}</strong></td>
        <td>${data.total}</td>
        <td>${data.verified}</td>
        <td>${data.total - data.verified}</td>
      </tr>`;

  return `<section class="scorecard-coverage">
  <h2>Spec Coverage</h2>
  <p>How many of the spec's requirements were verified for this tool.
  See <a href="/coverage">/coverage</a> for the full matrix.</p>
  <table class="coverage-level-table" aria-label="Verification coverage">
    <thead>
      <tr>
        <th>Level</th>
        <th>Total</th>
        <th>Verified</th>
        <th>Unverified</th>
      </tr>
    </thead>
    <tbody>
${row('MUST', coverageSummary.must)}
${row('SHOULD', coverageSummary.should)}
${row('MAY', coverageSummary.may)}
    </tbody>
  </table>
</section>
`;
}

// Copy for each `audience` label. `agent-optimized` has no entry because the
// banner is suppressed for that label unless an `audit_profile` is also set.
const AUDIENCE_COPY = {
  mixed:
    'This tool sends mixed signals: some agent-readable affordances are present, others are not. Treat the warnings below as friction points, not defects.',
  'human-primary':
    'This tool appears optimized for human use, not agents. P1/P2/P6/P7 warnings below reflect that audience choice rather than defects.',
};

// Copy for each `audit_profile` category. The "suppresses" wording mirrors the
// actual SUPPRESSION_TABLE in agentnative/src/principles/registry.rs as of
// CLI v0.1.3 — keep this in sync when the table changes upstream.
const AUDIT_PROFILE_COPY = {
  'human-tui':
    'Scored as a TUI: the non-interactive checks (P1) and the SIGPIPE check (P6) have been suppressed — TUI apps intercept the TTY by design and install their own signal handlers.',
  'file-traversal':
    'Scored as a file-traversal tool: subcommand-shape applicability filters already produce the expected Skip outcomes for fd/find-style tools, so no checks are explicitly suppressed by this profile today.',
  'posix-utility':
    'Scored as a POSIX utility: the non-interactive checks (P1) have been suppressed — POSIX utilities use stdin as their primary input, satisfying the no-prompt requirement vacuously.',
  'diagnostic-only':
    'Scored as a diagnostic-only tool: the dry-run check (P5) has been suppressed — read-only tools perform no writes, so the write-safety mutation-boundary requirement does not apply.',
};

/**
 * Render an informational audience banner.
 *
 * Suppressed when:
 *   - `audience` is null/undefined (v1.0–v1.2 scorecards or insufficient signal), AND
 *   - `auditProfile` is null/undefined.
 *
 * Suppressed when `audience === "agent-optimized"` AND no `auditProfile` is set —
 * the absence of a banner is itself the signal that the tool reads as agent-native
 * with no profile-level scoping applied.
 *
 * @param {string | null} audience — scorecard.audience: one of `agent-optimized`, `mixed`, `human-primary`, or null
 * @param {string | null} auditProfile — scorecard.audit_profile: one of `human-tui`, `file-traversal`, `posix-utility`, `diagnostic-only`, or null
 * @returns {string} HTML fragment
 */
export function renderAudienceBanner(audience, auditProfile) {
  const hasAudienceSignal = audience && audience !== 'agent-optimized';
  if (!hasAudienceSignal && !auditProfile) return '';

  const lines = [];
  if (hasAudienceSignal) {
    lines.push(
      `<p class="audience-banner__headline">Audience signal: <strong>${escHtml(audience)}</strong></p>`,
      `<p class="audience-banner__copy">${escHtml(AUDIENCE_COPY[audience] ?? `This tool was classified as ${audience}.`)}</p>`,
    );
  }
  if (auditProfile) {
    const profileCopy =
      AUDIT_PROFILE_COPY[auditProfile] ??
      `Scored under audit profile <code>${escHtml(auditProfile)}</code>: some checks have been suppressed by category.`;
    lines.push(
      `<p class="audience-banner__profile"><span class="audit-profile-pill">${escHtml(auditProfile)}</span> ${profileCopy}</p>`,
    );
  }
  lines.push(
    '<p class="audience-banner__note">This is an informational signal, not an authoritative verdict — see <a href="/methodology#what-the-audience-signal-is-and-is-not">methodology</a>. The per-check evidence below is the ground truth.</p>',
  );

  return `<section class="scorecard-audience-banner">
  ${lines.join('\n  ')}
</section>
`;
}

// -------------------------------------------------------------------
// Embed-snippet block — surface #1 of the badge plan.
//
// Above the eligibility floor: copy-paste embed snippet inline, plus a
// live SVG preview of how it renders.
// Below the floor: a brief hint pointing at the badge convention page
// and the "top issues" section that already exists on the page. We do
// NOT duplicate the failing-checks list here — the existing top-issues
// section already does that work; this block just routes the reader.
// -------------------------------------------------------------------

/**
 * Render the embed snippet section for an eligible tool's scorecard page.
 * The snippet markdown comes verbatim from `scorecard.badge.embed_markdown`
 * (schema 0.5) — the CLI is canonical for the URL convention so the embed
 * a tool author copies from anc.dev matches the embed `anc check` prints
 * after a passing run.
 *
 * @param {object} tool — registry entry (for the SVG preview alt text)
 * @param {object} scorecard — schema 0.5 scorecard
 * @returns {string} HTML fragment
 */
function renderEligibleEmbed(tool, scorecard) {
  const pct = scorecard.badge.score_pct;
  const embedMd = scorecard.badge.embed_markdown;
  return `<section class="scorecard-embed scorecard-embed--eligible">
  <h2>Embed the badge</h2>
  <p>This score (${pct}%) clears the <a href="/badge">badge floor</a> (${BADGE_FLOOR_DISPLAY_PCT}%). Copy this into your README:</p>
  <pre><code>${escHtml(embedMd)}</code></pre>
  <p class="scorecard-embed__preview">Preview: <img src="/badge/${escHtml(tool.name)}.svg" alt="agent-native badge for ${escHtml(tool.name)}" /></p>
</section>
`;
}

/**
 * Render the below-floor hint section. No copy-paste snippet, no
 * shaming — just a route to the convention page and a pointer back to
 * the top-issues section that already lists what to address.
 *
 * @param {number} pct — rounded percent (0–100)
 * @param {boolean} hasIssues — whether topIssues was non-empty
 * @returns {string} HTML fragment
 */
function renderBelowFloorHint(pct, hasIssues) {
  const floor = BADGE_FLOOR_DISPLAY_PCT;
  const gap = floor - pct;
  const issuesPointer = hasIssues
    ? ' The top issues above are the place to start.'
    : ' See the full check results below for the gaps.';
  return `<section class="scorecard-embed scorecard-embed--below">
  <h2>Embed the badge</h2>
  <p>The <a href="/badge">badge floor</a> is ${floor}%; this scorecard is at ${pct}% (${gap} point${gap === 1 ? '' : 's'} below). Once the score clears the floor, the embed snippet will appear here.${issuesPointer}</p>
</section>
`;
}

/**
 * Build a per-tool scorecard page body HTML.
 *
 * @param {object} tool — registry entry
 * @param {object} scorecard — schema 0.5 parsed JSON
 * @param {Array} topIssues — from extractTopIssues()
 * @param {object} principleScore — from computePrincipleScore()
 * @returns {string} HTML body
 */
export function buildScorecardBody(tool, scorecard, topIssues, principleScore, resolvedVersion, metadata) {
  const pct = scorecard.badge.score_pct;
  // The filename's <version> segment is the canonical version anchor.
  const version = resolvedVersion ?? null;
  // metadata is { tool, anc, run, target } from loadScoredTools(). Schema 0.5
  // guarantees these blocks are present (the load-time invariant rejects any
  // scorecard without them).
  const meta = metadata ?? {};

  // Breadcrumb
  let html = `<nav class="scorecard-breadcrumb" aria-label="Breadcrumb">
  <a href="/scorecards">&larr; Leaderboard</a>
</nav>
`;

  // Header
  html += `<header class="scorecard-header">
  <h1>${escHtml(tool.name)}</h1>
  <p class="scorecard-header__desc">${escHtml(tool.description)}</p>
  <div class="scorecard-header__meta">
    <span class="tier-badge tier-badge--${escHtml(tool.tier)}">${escHtml(tool.tier)}</span>
    <span>${escHtml(tool.language)}</span>
    ${tool.repo ? `<a href="https://github.com/${escHtml(tool.repo)}">${escHtml(tool.repo)}</a>` : tool.url ? `<a href="${escHtml(tool.url)}">${escHtml(tool.url)}</a>` : ''}
  </div>
</header>
`;

  // Score summary
  html += `<section class="scorecard-summary">
  <div class="scorecard-score-badge">
    <span class="scorecard-score-badge__pct">${pct}%</span>
    <span class="scorecard-score-badge__label">pass rate</span>
  </div>
  <div class="scorecard-principle-badge">
    <span class="scorecard-principle-badge__count">${principleScore.met}/${principleScore.total}</span>
    <span class="scorecard-principle-badge__label">principles met</span>
  </div>
</section>
`;

  // Coverage summary (v1.1+ only — gracefully absent on v1.0 scorecards)
  html += renderCoverageSummary(scorecard.coverage_summary);

  // Audience banner (v1.3+ only — null until audience detector ships)
  html += renderAudienceBanner(scorecard.audience, scorecard.audit_profile);

  // Top issues or all-pass message
  if (topIssues.length === 0) {
    html += `<section class="scorecard-issues scorecard-issues--clean">
  <h2>Status</h2>
  <p>All ${principleScore.total} principles met — no issues found.</p>
</section>
`;
  } else {
    const issueItems = topIssues
      .map((issue) => {
        const pNum = groupToPrincipleNum(issue.group);
        const statusClass = issue.status === 'fail' ? 'issue--fail' : 'issue--warn';
        const groupLink = pNum
          ? `<a href="/p${pNum}">${escHtml(PRINCIPLE_NAMES[issue.group] || issue.group)}</a>`
          : escHtml(issue.group);
        const evidence = issue.evidence ? `<span class="issue__evidence">${escHtml(issue.evidence)}</span>` : '';
        return `    <li class="issue ${statusClass}">
      <span class="issue__status">${escHtml(issue.status.toUpperCase())}</span>
      <span class="issue__label">${escHtml(issue.label)}</span>
      <span class="issue__group">${groupLink}</span>
      ${evidence}
    </li>`;
      })
      .join('\n');

    html += `<section class="scorecard-issues">
  <h2>Top Issues</h2>
  <ul class="issue-list">
${issueItems}
  </ul>
</section>
`;
  }

  // Full check results grouped by principle
  html += `<section class="scorecard-checks">
  <h2>All Checks</h2>
`;

  // Principle groups
  for (const group of PRINCIPLE_GROUPS) {
    const checks = scorecard.results.filter((r) => r.group === group);
    if (checks.length === 0) continue;
    const pNum = groupToPrincipleNum(group);
    const groupName = PRINCIPLE_NAMES[group] || group;
    const groupLink = pNum ? `/p${pNum}` : null;

    html += `  <div class="check-group">
    <h3 class="check-group__title">${groupLink ? `<a href="${groupLink}">` : ''}${escHtml(group)}: ${escHtml(groupName)}${groupLink ? '</a>' : ''}</h3>
    <table class="check-table">
      <tbody>
${renderCheckRows(checks)}
      </tbody>
    </table>
  </div>
`;
  }

  // Bonus groups (CodeQuality, ProjectStructure)
  const bonusChecks = scorecard.results.filter((r) => BONUS_GROUPS.includes(r.group));
  if (bonusChecks.length > 0) {
    html += `  <div class="check-group check-group--bonus">
    <h3 class="check-group__title">Code Quality</h3>
    <table class="check-table">
      <tbody>
${renderCheckRows(bonusChecks)}
      </tbody>
    </table>
  </div>
`;
  }

  html += `</section>
`;

  // Details — Tool-identity rows (Version, Audit date) first; run-context
  // rows (Duration, Platform, Mode) middle; provenance (Anc build) last;
  // Install closes. Every value runs through escHtml — the CLI captures
  // tool.version, anc.{version,commit}, run.platform.{os,arch}, target.kind
  // as free-form strings that could carry HTML special characters.
  const detailRows = [`<dt>Version scored</dt><dd>${escHtml(version || '—')}</dd>`];
  const auditDate = formatStartedAt(meta.run?.started_at);
  if (auditDate) detailRows.push(`<dt>Audit date</dt><dd>${escHtml(auditDate)}</dd>`);
  const duration = formatDuration(meta.run?.duration_ms);
  if (duration) detailRows.push(`<dt>Duration</dt><dd>${escHtml(duration)}</dd>`);
  if (meta.run?.platform?.os && meta.run?.platform?.arch) {
    detailRows.push(
      `<dt>Platform</dt><dd><code>${escHtml(meta.run.platform.os)}/${escHtml(meta.run.platform.arch)}</code></dd>`,
    );
  }
  if (meta.target?.kind) {
    detailRows.push(`<dt>Mode</dt><dd>${escHtml(meta.target.kind)}</dd>`);
  }
  const ancBuild = renderAncBuildHtml(meta.anc);
  if (ancBuild) detailRows.push(`<dt>Anc build</dt><dd>${ancBuild}</dd>`);
  detailRows.push(`<dt>Install</dt><dd><code>${escHtml(tool.install || '—')}</code></dd>`);

  html += `<section class="scorecard-meta">
  <h2>Details</h2>
  <dl class="meta-list">
    ${detailRows.join('\n    ')}
  </dl>
</section>
`;

  // Embed snippet (above floor) or below-floor hint. Placed after the
  // detail sections and before the reproduce-locally CTA so the reading
  // order is: score → details → here's what to do (embed if eligible,
  // reproduce always).
  html += scorecard.badge.eligible
    ? renderEligibleEmbed(tool, scorecard)
    : renderBelowFloorHint(pct, topIssues.length > 0);

  // CTA — reproduce THIS scorecard locally. For command-mode v0.4 scorecards,
  // render `run.invocation` verbatim — it's the literal argv that produced
  // this scorecard, so reproducing it is byte-exact rather than synthesized.
  // For project-mode runs (target.path may carry local filesystem layout) and
  // grandfathered scorecards (no run.invocation), fall back to the synthesized
  // form. escHtml is mandatory: the invocation contains user-controlled argv.
  let reproCommand;
  if (meta.target?.kind === 'command' && typeof meta.run?.invocation === 'string') {
    reproCommand = escHtml(meta.run.invocation);
  } else {
    const profileFlag = scorecard.audit_profile ? ` --audit-profile ${scorecard.audit_profile}` : '';
    reproCommand = `anc check --command ${escHtml(tool.binary)}${profileFlag}`;
  }
  const ctaText =
    topIssues.length === 0
      ? `Reproduce this scorecard for <code>${escHtml(tool.name)}</code> locally:`
      : `Reproduce this scorecard for <code>${escHtml(tool.name)}</code> locally and inspect the failing checks:`;
  html += `<section class="scorecard-cta">
  <p>${ctaText}</p>
  <pre><code>${reproCommand}</code></pre>
  <p class="scorecard-cta__note"><a href="/install">Install <code>anc</code></a> first if you don't have it.
  Add <code>--output json</code> to get the same JSON shape committed under
  <a href="https://github.com/brettdavies/agentnative-site/tree/main/scorecards"><code>scorecards/</code></a>.</p>
</section>`;

  return html;
}

// -------------------------------------------------------------------
// Markdown builders
// -------------------------------------------------------------------

/**
 * Build leaderboard markdown twin — a readable markdown table.
 *
 * @param {Array} leaderboard — from computeLeaderboard()
 * @returns {string} markdown
 */
export function buildLeaderboardMarkdown(leaderboard) {
  const lines = [
    '# ANC 100 — Agent-Native CLI Leaderboard',
    '',
    'Automated agent-readiness scores for real CLI tools, scored against the [eight principles](/).',
    '',
    '| # | Tool | Tier | Lang | Score | Principles |',
    '|---|------|------|------|-------|------------|',
  ];

  for (const entry of leaderboard) {
    // Every leaderboard entry has a scorecard at this point.
    const score = `${entry.scorecard.badge.score_pct}%`;
    const ps = entry.principleScore;
    const principles = `${ps.met}/${ps.total}`;
    lines.push(
      `| ${entry.rank} | [${entry.tool.name}](/score/${entry.tool.name}) | ${entry.tool.tier} | ${entry.tool.language} | ${score} | ${principles} |`,
    );
  }

  lines.push('');
  return lines.join('\n');
}

/**
 * Build per-tool scorecard markdown twin.
 *
 * @param {object} tool — registry entry
 * @param {object | null} scorecard
 * @param {Array} topIssues
 * @param {object} principleScore
 * @returns {string} markdown
 */
export function buildScorecardMarkdown(tool, scorecard, _topIssues, principleScore, resolvedVersion, metadata) {
  const version = resolvedVersion ?? null;
  const meta = metadata ?? {};
  const lines = [`# ${tool.name}`];
  lines.push('');
  lines.push(tool.description);
  lines.push('');

  const pct = scorecard.badge.score_pct;
  const floorPct = BADGE_FLOOR_DISPLAY_PCT;
  lines.push(`**Score:** ${pct}% pass rate`);
  lines.push(`**Principles:** ${principleScore.met}/${principleScore.total} met`);
  lines.push('');

  // Embed snippet (above floor) or below-floor hint. Mirrors the HTML
  // surface so an agent fetching the .md twin sees the same convention.
  if (scorecard.badge.eligible) {
    lines.push('## Embed the badge');
    lines.push('');
    lines.push(`This score (${pct}%) clears the [badge floor](/badge) (${floorPct}%). Copy this into your README:`);
    lines.push('');
    lines.push('```markdown');
    lines.push(scorecard.badge.embed_markdown);
    lines.push('```');
    lines.push('');
  } else {
    const gap = floorPct - pct;
    lines.push('## Embed the badge');
    lines.push('');
    lines.push(
      `The [badge floor](/badge) is ${floorPct}%; this scorecard is at ${pct}% (${gap} point${gap === 1 ? '' : 's'} below). Once the score clears the floor, the embed snippet will appear here.`,
    );
    lines.push('');
  }

  // Check results table — formatted by the shared row helper so the
  // /score/<tool>.md and /live-score/<binary>.md surfaces stay in lockstep.
  // Empty `baseUrl` produces site-relative links (`/p3`); the build's
  // absolutifyMarkdownLinks pass rewrites those to absolute anc.dev URLs
  // for the twin output (matches the other markdown pages in this file).
  for (const row of formatCheckTableMarkdownLines(scorecard.results)) {
    lines.push(row);
  }
  lines.push('');

  // Metadata — mirrors the HTML "Details" block for triple-emit parity.
  // Each v0.4 row is gated on the underlying field being present, so
  // grandfathered scorecards omit the run-context rows naturally.
  if (tool.repo) {
    lines.push(`**Repo:** [${tool.repo}](https://github.com/${tool.repo})`);
  } else if (tool.url) {
    lines.push(`**Source:** [${tool.url}](${tool.url})`);
  }
  lines.push(`**Language:** ${tool.language}`);
  lines.push(`**Version scored:** ${version || '—'}`);
  const auditDateMd = formatStartedAt(meta.run?.started_at);
  if (auditDateMd) lines.push(`**Audit date:** ${auditDateMd}`);
  const durationMd = formatDuration(meta.run?.duration_ms);
  if (durationMd) lines.push(`**Duration:** ${durationMd}`);
  if (meta.run?.platform?.os && meta.run?.platform?.arch) {
    lines.push(`**Platform:** \`${meta.run.platform.os}/${meta.run.platform.arch}\``);
  }
  if (meta.target?.kind) {
    lines.push(`**Mode:** ${meta.target.kind}`);
  }
  const ancBuildMd = renderAncBuildMarkdown(meta.anc);
  if (ancBuildMd) lines.push(`**Anc build:** ${ancBuildMd}`);
  lines.push(`**Install:** \`${tool.install || '—'}\``);

  // Reproduce CTA — same target.kind === 'command' gate as the HTML branch.
  // Critical: this markdown is consumed by /llms-full.txt and content-
  // negotiation `Accept: text/markdown` agents. A project-mode invocation
  // could embed a local filesystem path, so fall back to the synthesized
  // form unless we know the invocation is the safe canonical command shape.
  lines.push('');
  let reproMd;
  if (meta.target?.kind === 'command' && typeof meta.run?.invocation === 'string') {
    reproMd = meta.run.invocation;
  } else {
    const profileFlag = scorecard.audit_profile ? ` --audit-profile ${scorecard.audit_profile}` : '';
    reproMd = `anc check --command ${tool.binary}${profileFlag}`;
  }
  lines.push('## Reproduce locally');
  lines.push('');
  lines.push('```bash');
  lines.push(reproMd);
  lines.push('```');
  lines.push('');

  return lines.join('\n');
}
