// Scorecard rendering — HTML and markdown builders for leaderboard and
// per-tool scorecard pages. Template concern only; data loading and
// scoring live in scorecards.mjs.

import { computeScore } from './scorecards.mjs';
import { BONUS_GROUPS, PRINCIPLE_GROUPS, PRINCIPLE_NAMES, escHtml } from './util.mjs';

/**
 * Map a check group string to a principle number (1-7) or null for bonus groups.
 * @param {string} group
 * @returns {number | null}
 */
function groupToPrincipleNum(group) {
  const match = group.match(/^P(\d+)$/);
  return match ? Number(match[1]) : null;
}

/**
 * Render an array of checks as `<tr>` rows for a check-table.
 * @param {Array<{ status: string, label: string, evidence: string | null }>} checks
 * @returns {string}
 */
function renderCheckRows(checks) {
  return checks
    .map(
      (check) => `        <tr class="check check--${check.status}">
          <td class="check__status">${escHtml(check.status.toUpperCase())}</td>
          <td class="check__label">${escHtml(check.label)}</td>
          <td class="check__evidence">${check.evidence ? escHtml(check.evidence) : ''}</td>
        </tr>`,
    )
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

  const scoreCell = (entry) => {
    if (!entry.scorecard) return '<td class="lb-score lb-score--none" data-sort="-1">—</td>';
    const pct = Math.round(entry.score * 100);
    return `<td class="lb-score" data-sort="${pct}">${pct}%</td>`;
  };

  const principleCell = (entry) => {
    const ps = entry.principleScore;
    return `<td class="lb-principles" data-sort="${ps.met}">${ps.met}/${ps.total}</td>`;
  };

  const rows = leaderboard
    .map(
      (entry) => `      <tr data-tier="${escHtml(entry.tool.tier)}" data-lang="${escHtml(entry.tool.language)}">
        <td class="lb-rank">${entry.rank}</td>
        <td class="lb-tool"><a href="/score/${escHtml(entry.tool.name)}">${escHtml(entry.tool.name)}</a></td>
        <td class="lb-desc">${escHtml(entry.tool.description)}</td>
        <td class="lb-tier">${tierBadge(entry.tool.tier)}</td>
        <td class="lb-lang">${escHtml(entry.tool.language)}</td>
        ${scoreCell(entry)}
        ${principleCell(entry)}
      </tr>`,
    )
    .join('\n');

  const tierCounts = {};
  for (const e of leaderboard) {
    tierCounts[e.tool.tier] = (tierCounts[e.tool.tier] || 0) + 1;
  }

  return `<section class="leaderboard-hero">
  <h1>ANC 100 — Agent-Native CLI Leaderboard</h1>
  <p class="leaderboard-hero__lede">Automated agent-readiness scores for real CLI tools, scored against the <a href="/">seven principles</a>.</p>
</section>

<section class="leaderboard-controls" aria-label="Filters">
  <div class="tier-filters" role="group" aria-label="Filter by tier">
    <button type="button" class="tier-filter tier-filter--active" data-tier="all">All (${leaderboard.length})</button>
    <button type="button" class="tier-filter" data-tier="workhorse">Workhorse (${tierCounts.workhorse || 0})</button>
    <button type="button" class="tier-filter" data-tier="agent">Agent (${tierCounts.agent || 0})</button>
    <button type="button" class="tier-filter" data-tier="notable">Notable (${tierCounts.notable || 0})</button>
  </div>
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

/**
 * Render an informational audience banner.
 * Returns empty string if `audience` is null/undefined (v1.0 compat or stub).
 *
 * @param {string | null} audience — scorecard.audience (e.g., "human-primary")
 * @param {string | null} auditProfile — scorecard.audit_profile (e.g., "tui-by-design")
 * @returns {string} HTML fragment
 */
export function renderAudienceBanner(audience, auditProfile) {
  if (!audience) return '';

  const profilePill = auditProfile ? ` <span class="audit-profile-pill">${escHtml(auditProfile)}</span>` : '';

  return `<section class="scorecard-audience-banner">
  <p class="audience-banner__text">Audience signal: <strong>${escHtml(audience)}</strong>${profilePill}</p>
  <p class="audience-banner__note">This is an informational classification based on the tool's
  check results, not a quality judgment. Tools optimized for human use may intentionally
  skip agent-specific affordances.</p>
</section>
`;
}

/**
 * Build a per-tool scorecard page body HTML.
 *
 * @param {object} tool — registry entry
 * @param {object | null} scorecard — parsed JSON
 * @param {Array} topIssues — from extractTopIssues()
 * @param {object} principleScore — from computePrincipleScore()
 * @returns {string} HTML body
 */
export function buildScorecardBody(tool, scorecard, topIssues, principleScore) {
  const score = computeScore(scorecard);
  const pct = Math.round(score * 100);

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

  if (!scorecard) {
    html += `<section class="scorecard-summary">
  <p>This tool has not yet been scored. Run <code>anc check --command ${escHtml(tool.binary)}</code> locally to generate a scorecard.</p>
</section>`;
    return html;
  }

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

  // Metadata
  html += `<section class="scorecard-meta">
  <h2>Details</h2>
  <dl class="meta-list">
    <dt>Version scored</dt><dd>${escHtml(tool.version || '—')}</dd>
    <dt>Audit date</dt><dd>${escHtml(tool.scored_at || '—')}</dd>
    <dt>Install</dt><dd><code>${escHtml(tool.install || '—')}</code></dd>
  </dl>
</section>
`;

  // CTA
  const ctaText =
    topIssues.length === 0
      ? 'Run <code>anc check .</code> in CI to keep it that way.'
      : 'Run <code>anc check .</code> locally for the full report.';
  html += `<section class="scorecard-cta">
  <p>${ctaText}</p>
  <pre><code>cargo install agentnative &amp;&amp; anc check .</code></pre>
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
    'Automated agent-readiness scores for real CLI tools, scored against the [seven principles](/).',
    '',
    '| # | Tool | Tier | Lang | Score | Principles |',
    '|---|------|------|------|-------|------------|',
  ];

  for (const entry of leaderboard) {
    const score = entry.scorecard ? `${Math.round(entry.score * 100)}%` : '—';
    const ps = entry.principleScore;
    lines.push(
      `| ${entry.rank} | [${entry.tool.name}](/score/${entry.tool.name}) | ${entry.tool.tier} | ${entry.tool.language} | ${score} | ${ps.met}/${ps.total} |`,
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
export function buildScorecardMarkdown(tool, scorecard, topIssues, principleScore) {
  const lines = [`# ${tool.name}`];
  lines.push('');
  lines.push(tool.description);
  lines.push('');

  if (!scorecard) {
    lines.push('This tool has not yet been scored.');
    lines.push('');
    return lines.join('\n');
  }

  const score = computeScore(scorecard);
  lines.push(`**Score:** ${Math.round(score * 100)}% pass rate`);
  lines.push(`**Principles:** ${principleScore.met}/${principleScore.total} met`);
  lines.push('');

  // Check results table
  lines.push('| Status | Check | Principle | Evidence |');
  lines.push('|--------|-------|-----------|----------|');
  for (const check of scorecard.results) {
    const pNum = groupToPrincipleNum(check.group);
    const groupLabel = pNum ? `[${check.group}](/p${pNum})` : check.group;
    lines.push(`| ${check.status.toUpperCase()} | ${check.label} | ${groupLabel} | ${check.evidence || ''} |`);
  }
  lines.push('');

  // Metadata
  if (tool.repo) {
    lines.push(`**Repo:** [${tool.repo}](https://github.com/${tool.repo})`);
  } else if (tool.url) {
    lines.push(`**Source:** [${tool.url}](${tool.url})`);
  }
  lines.push(`**Language:** ${tool.language}`);
  lines.push(`**Version scored:** ${tool.version || '—'}`);
  lines.push(`**Install:** \`${tool.install || '—'}\``);
  lines.push('');

  return lines.join('\n');
}
