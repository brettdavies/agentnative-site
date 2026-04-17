// Scorecard build module — reads registry.yaml + scorecards/*.json,
// produces data structures and HTML builders for leaderboard and
// per-tool scorecard pages.
//
// Pure functions: data-in, data-out. No side effects, no filesystem
// writes. The build orchestrator (build.mjs) handles I/O.

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { escHtml } from './util.mjs';

const TOOL_NAME_RE = /^[a-z0-9-]+$/;
const PRINCIPLE_GROUPS = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7'];
const BONUS_GROUPS = ['CodeQuality', 'ProjectStructure'];

// -------------------------------------------------------------------
// Data loading
// -------------------------------------------------------------------

/**
 * Parse registry.yaml, validate required fields and name format,
 * enforce uniqueness. Returns array of tool entries.
 *
 * @param {string} registryPath — absolute path to registry.yaml
 * @returns {Promise<Array<object>>}
 */
export async function loadRegistry(registryPath) {
  const raw = await readFile(registryPath, 'utf8');
  const doc = yaml.load(raw);
  const tools = doc?.tools;
  if (!Array.isArray(tools)) {
    throw new Error('registry.yaml: expected top-level "tools" array');
  }

  const seen = new Set();
  for (const t of tools) {
    if (!t.name || typeof t.name !== 'string') {
      throw new Error('registry.yaml: every tool must have a "name" string');
    }
    if (!TOOL_NAME_RE.test(t.name)) {
      throw new Error(
        `registry.yaml: name "${t.name}" must match /^[a-z0-9-]+$/ (lowercase, alphanumeric, hyphens)`,
      );
    }
    if (t.name === 'scorecards') {
      throw new Error('registry.yaml: "scorecards" is reserved — slug collision with the leaderboard page');
    }
    if (seen.has(t.name)) {
      throw new Error(`registry.yaml: duplicate name "${t.name}"`);
    }
    seen.add(t.name);

    for (const field of ['repo', 'binary', 'language', 'tier', 'creator', 'description']) {
      if (!t[field]) {
        throw new Error(`registry.yaml: tool "${t.name}" missing required field "${field}"`);
      }
    }
    if (!['workhorse', 'agent', 'notable'].includes(t.tier)) {
      throw new Error(`registry.yaml: tool "${t.name}" has invalid tier "${t.tier}"`);
    }
  }

  return tools;
}

/**
 * For each registry entry, read scorecards/<name>.json if it exists.
 * Tools without a scorecard file are included but marked unscored.
 *
 * @param {string} scorecardsDir — absolute path to scorecards/
 * @param {Array<object>} registry — from loadRegistry()
 * @returns {Promise<Array<{ tool: object, scorecard: object | null }>>}
 */
export async function loadScorecards(scorecardsDir, registry) {
  let files;
  try {
    files = new Set(await readdir(scorecardsDir));
  } catch {
    files = new Set();
  }

  const result = [];
  for (const tool of registry) {
    const filename = `${tool.name}.json`;
    if (files.has(filename)) {
      const raw = await readFile(join(scorecardsDir, filename), 'utf8');
      result.push({ tool, scorecard: JSON.parse(raw) });
    } else {
      result.push({ tool, scorecard: null });
    }
  }
  return result;
}

// -------------------------------------------------------------------
// Scoring
// -------------------------------------------------------------------

/**
 * Compute primary score: pass / (pass + warn + fail).
 * Skip and error are excluded from the denominator.
 * If denominator is 0, score is 0.
 *
 * @param {object | null} scorecard
 * @returns {number} 0–1
 */
export function computeScore(scorecard) {
  if (!scorecard) return 0;
  const { pass = 0, warn = 0, fail = 0 } = scorecard.summary;
  const denom = pass + warn + fail;
  return denom === 0 ? 0 : pass / denom;
}

/**
 * Map P1–P7 groups to pass/partial/fail and return "N/7 principles met".
 * CodeQuality and ProjectStructure are excluded from the N/7 count.
 *
 * @param {object | null} scorecard
 * @returns {{ met: number, total: 7, details: Array<{ group: string, status: string }> }}
 */
export function computePrincipleScore(scorecard) {
  if (!scorecard) return { met: 0, total: 7, details: [] };

  const details = [];
  for (const group of PRINCIPLE_GROUPS) {
    const checks = scorecard.results.filter((r) => r.group === group);
    if (checks.length === 0) {
      details.push({ group, status: 'skip' });
      continue;
    }
    const hasFail = checks.some((r) => r.status === 'fail');
    const hasWarn = checks.some((r) => r.status === 'warn');
    if (hasFail) details.push({ group, status: 'fail' });
    else if (hasWarn) details.push({ group, status: 'partial' });
    else details.push({ group, status: 'pass' });
  }

  const met = details.filter((d) => d.status === 'pass').length;
  return { met, total: 7, details };
}

/**
 * Compute layer scores: primary (behavioral + project) vs source.
 *
 * @param {object | null} scorecard
 * @returns {{ primary: number, source: number | null }}
 */
export function computeLayerScore(scorecard) {
  if (!scorecard) return { primary: 0, source: null };

  const primary = scorecard.results.filter((r) => r.layer === 'behavioral' || r.layer === 'project');
  const source = scorecard.results.filter((r) => r.layer === 'source');

  const ratio = (checks) => {
    const p = checks.filter((c) => c.status === 'pass').length;
    const w = checks.filter((c) => c.status === 'warn').length;
    const f = checks.filter((c) => c.status === 'fail').length;
    const d = p + w + f;
    return d === 0 ? 0 : p / d;
  };

  return {
    primary: ratio(primary),
    source: source.length === 0 ? null : ratio(source),
  };
}

/**
 * Extract top N failing/warning checks sorted by severity (FAIL > WARN).
 *
 * @param {object | null} scorecard
 * @param {number} limit
 * @returns {Array<{ id: string, label: string, group: string, status: string, evidence: string | null }>}
 */
export function extractTopIssues(scorecard, limit = 3) {
  if (!scorecard) return [];

  const issues = scorecard.results.filter((r) => r.status === 'fail' || r.status === 'warn');
  const order = { fail: 0, warn: 1 };
  issues.sort((a, b) => order[a.status] - order[b.status]);
  return issues.slice(0, limit);
}

/**
 * Sort tools by primary score descending. Unscored tools sort to bottom.
 *
 * @param {Array<{ tool: object, scorecard: object | null }>} tools
 * @returns {Array<{ tool: object, scorecard: object | null, score: number, rank: number, principleScore: object }>}
 */
export function computeLeaderboard(tools) {
  const scored = tools.map((entry) => ({
    ...entry,
    score: computeScore(entry.scorecard),
    principleScore: computePrincipleScore(entry.scorecard),
  }));

  // Scored tools first (descending), then unscored
  scored.sort((a, b) => {
    const aScored = a.scorecard !== null;
    const bScored = b.scorecard !== null;
    if (aScored !== bScored) return aScored ? -1 : 1;
    return b.score - a.score;
  });

  return scored.map((entry, i) => ({ ...entry, rank: i + 1 }));
}

// -------------------------------------------------------------------
// Principle metadata (for linking check groups to principle pages)
// -------------------------------------------------------------------

const PRINCIPLE_NAMES = {
  P1: 'Non-Interactive by Default',
  P2: 'Structured, Parseable Output',
  P3: 'Progressive Help Discovery',
  P4: 'Fail-Fast, Actionable Errors',
  P5: 'Safe Retries & Mutation Boundaries',
  P6: 'Composable, Predictable Command Structure',
  P7: 'Bounded, High-Signal Responses',
};

/**
 * Map a check group string to a principle number (1-7) or null for bonus groups.
 * @param {string} group
 * @returns {number | null}
 */
function groupToPrincipleNum(group) {
  const match = group.match(/^P(\d+)$/);
  return match ? Number(match[1]) : null;
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
        ${tierBadge(entry.tool.tier)}
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
    <a href="https://github.com/${escHtml(tool.repo)}">${escHtml(tool.repo)}</a>
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
        const groupLink = pNum ? `<a href="/p${pNum}">${escHtml(PRINCIPLE_NAMES[issue.group] || issue.group)}</a>` : escHtml(issue.group);
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
`;
    for (const check of checks) {
      const statusClass = `check--${check.status}`;
      html += `        <tr class="check ${statusClass}">
          <td class="check__status">${escHtml(check.status.toUpperCase())}</td>
          <td class="check__label">${escHtml(check.label)}</td>
          <td class="check__evidence">${check.evidence ? escHtml(check.evidence) : ''}</td>
        </tr>
`;
    }
    html += `      </tbody>
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
`;
    for (const check of bonusChecks) {
      const statusClass = `check--${check.status}`;
      html += `        <tr class="check ${statusClass}">
          <td class="check__status">${escHtml(check.status.toUpperCase())}</td>
          <td class="check__label">${escHtml(check.label)}</td>
          <td class="check__evidence">${check.evidence ? escHtml(check.evidence) : ''}</td>
        </tr>
`;
    }
    html += `      </tbody>
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
    lines.push(
      `| ${check.status.toUpperCase()} | ${check.label} | ${groupLabel} | ${check.evidence || ''} |`,
    );
  }
  lines.push('');

  // Metadata
  lines.push(`**Repo:** [${tool.repo}](https://github.com/${tool.repo})`);
  lines.push(`**Language:** ${tool.language}`);
  lines.push(`**Version scored:** ${tool.version || '—'}`);
  lines.push(`**Install:** \`${tool.install || '—'}\``);
  lines.push('');

  return lines.join('\n');
}
