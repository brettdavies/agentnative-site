// Scorecard rendering — HTML and markdown builders for leaderboard and
// per-tool scorecard pages. Template concern only; data loading and
// scoring live in scorecards.mjs.

import { BADGE_FLOOR, BONUS_GROUPS, escHtml, PRINCIPLE_GROUPS, PRINCIPLE_NAMES, resolveBaseUrl } from './util.mjs';

/**
 * Map a check group string to a principle number (1-7) or null for bonus groups.
 * @param {string} group
 * @returns {number | null}
 */
function groupToPrincipleNum(group) {
  const match = group.match(/^P(\d+)$/);
  return match ? Number(match[1]) : null;
}

// Evidence prefix the CLI emits for any check suppressed by `--audit-profile`.
// Mirrors `SUPPRESSION_EVIDENCE_PREFIX` in agentnative/src/principles/registry.rs
// — the trailing space is part of the documented contract; the CLI source calls
// out downstream site renderers as pinned consumers of this exact string.
const AUDIT_PROFILE_SUPPRESSION_PREFIX = 'suppressed by audit_profile: ';

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
 * @param {Array<{ status: string, label: string, evidence: string | null }>} checks
 * @returns {string}
 */
function renderCheckRows(checks) {
  return checks
    .map((check) => {
      const category = suppressionCategory(check);
      const rowClass = category ? 'check check--skip check--suppressed' : `check check--${check.status}`;
      const statusLabel = category ? `N/A by ${escHtml(category)}` : escHtml(check.status.toUpperCase());
      const evidence = check.evidence ? escHtml(check.evidence) : '';
      return `        <tr class="${rowClass}">
          <td class="check__status">${statusLabel}</td>
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

  const scoreCell = (entry) => {
    if (!entry.scorecard) return '<td class="lb-score lb-score--none" data-sort="-1">—</td>';
    const pct = Math.round(entry.score * 100);
    return `<td class="lb-score" data-sort="${pct}">${pct}%</td>`;
  };

  const principleCell = (entry) => {
    // Unscored entries get an em-dash, not "0/7" — which would falsely read
    // as "failed all 7 principles." `data-sort="-1"` matches the score
    // column's sort behavior so unscored rows cluster at the bottom.
    if (!entry.scorecard) return '<td class="lb-principles lb-principles--none" data-sort="-1">—/7</td>';
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

  // Eligible-tool count for the badge callout. Counts only scored tools
  // at or above BADGE_FLOOR — the same gate the per-tool scorecard pages
  // use. Lets the callout cite a real number ("24 tools currently qualify")
  // instead of a vague "tools that qualify."
  const eligibleCount = leaderboard.filter((e) => e.scorecard && e.score >= BADGE_FLOOR).length;
  const floorPct = Math.round(BADGE_FLOOR * 100);

  return `<section class="leaderboard-hero">
  <h1>ANC 100 — Agent-Native CLI Leaderboard</h1>
  <p class="leaderboard-hero__lede">Automated agent-readiness scores for real CLI tools, scored against the <a href="/">seven principles</a>. See the <a href="/methodology">methodology</a> for how scores, audience signals, and audit profiles work.</p>
</section>

<section class="leaderboard-controls" aria-label="Filters">
  <div class="tier-filters" role="group" aria-label="Filter by tier">
    <button type="button" class="tier-filter tier-filter--active" data-tier="all">All (${leaderboard.length})</button>
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
 * @param {string} toolName
 * @param {string=} baseUrl — explicit override; defaults via resolveBaseUrl
 * @returns {string} `[![agent-native](https://anc.dev/badge/<tool>.svg)](https://anc.dev/score/<tool>)`
 */
export function buildEmbedMarkdown(toolName, baseUrl) {
  const base = resolveBaseUrl(baseUrl);
  return `[![agent-native](${base}/badge/${toolName}.svg)](${base}/score/${toolName})`;
}

/**
 * Render the embed snippet section for an eligible tool's scorecard page.
 *
 * @param {object} tool — registry entry
 * @param {number} pct — rounded percent (0–100)
 * @returns {string} HTML fragment
 */
function renderEligibleEmbed(tool, pct) {
  const embedMd = buildEmbedMarkdown(tool.name);
  return `<section class="scorecard-embed scorecard-embed--eligible">
  <h2>Embed the badge</h2>
  <p>This score (${pct}%) clears the <a href="/badge">badge floor</a> (${Math.round(BADGE_FLOOR * 100)}%). Copy this into your README:</p>
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
  const floor = Math.round(BADGE_FLOOR * 100);
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
 * @param {object | null} scorecard — parsed JSON
 * @param {Array} topIssues — from extractTopIssues()
 * @param {object} principleScore — from computePrincipleScore()
 * @param {number} score — pre-computed 0–1 score from computeScore()
 * @returns {string} HTML body
 */
export function buildScorecardBody(tool, scorecard, topIssues, principleScore, score, resolvedVersion) {
  const pct = Math.round(score * 100);
  // Prefer the version from the matched scorecard filename when present; fall
  // back to the registry pin for legacy entries where version is set.
  const version = resolvedVersion ?? tool.version ?? null;

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
    <dt>Version scored</dt><dd>${escHtml(version || '—')}</dd>
    <dt>Audit date</dt><dd>${escHtml(tool.scored_at || '—')}</dd>
    <dt>Install</dt><dd><code>${escHtml(tool.install || '—')}</code></dd>
  </dl>
</section>
`;

  // Embed snippet (above floor) or below-floor hint. Placed after the
  // detail sections and before the reproduce-locally CTA so the reading
  // order is: score → details → here's what to do (embed if eligible,
  // reproduce always).
  html += score >= BADGE_FLOOR ? renderEligibleEmbed(tool, pct) : renderBelowFloorHint(pct, topIssues.length > 0);

  // CTA — reproduce THIS scorecard locally. Includes --audit-profile when
  // the tool was scored under one, so the reproduction matches the
  // committed scorecard's suppression set exactly.
  const profileFlag = scorecard.audit_profile ? ` --audit-profile ${scorecard.audit_profile}` : '';
  const reproCommand = `anc check --command ${escHtml(tool.binary)}${profileFlag}`;
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
    'Automated agent-readiness scores for real CLI tools, scored against the [seven principles](/).',
    '',
    '| # | Tool | Tier | Lang | Score | Principles |',
    '|---|------|------|------|-------|------------|',
  ];

  for (const entry of leaderboard) {
    const score = entry.scorecard ? `${Math.round(entry.score * 100)}%` : '—';
    const ps = entry.principleScore;
    const principles = entry.scorecard ? `${ps.met}/${ps.total}` : '—/7';
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
 * @param {number} score — pre-computed 0–1 score from computeScore()
 * @returns {string} markdown
 */
export function buildScorecardMarkdown(tool, scorecard, _topIssues, principleScore, score, resolvedVersion) {
  const version = resolvedVersion ?? tool.version ?? null;
  const lines = [`# ${tool.name}`];
  lines.push('');
  lines.push(tool.description);
  lines.push('');

  if (!scorecard) {
    lines.push('This tool has not yet been scored.');
    lines.push('');
    return lines.join('\n');
  }

  const pct = Math.round(score * 100);
  const floorPct = Math.round(BADGE_FLOOR * 100);
  lines.push(`**Score:** ${pct}% pass rate`);
  lines.push(`**Principles:** ${principleScore.met}/${principleScore.total} met`);
  lines.push('');

  // Embed snippet (above floor) or below-floor hint. Mirrors the HTML
  // surface so an agent fetching the .md twin sees the same convention.
  if (score >= BADGE_FLOOR) {
    lines.push('## Embed the badge');
    lines.push('');
    lines.push(`This score (${pct}%) clears the [badge floor](/badge) (${floorPct}%). Copy this into your README:`);
    lines.push('');
    lines.push('```markdown');
    lines.push(buildEmbedMarkdown(tool.name));
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
  lines.push(`**Version scored:** ${version || '—'}`);
  lines.push(`**Install:** \`${tool.install || '—'}\``);
  lines.push('');

  return lines.join('\n');
}
