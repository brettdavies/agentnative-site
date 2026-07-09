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
  P8: 'Discoverable Through Agent Skill Bundles',
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
 * Map an audit group string like "P3" to a principle number (3), or null
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
 * Extract the top failing/warning audits from a scorecard, FAIL before WARN.
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
 * Format a single audit as a markdown table row. Both the static
 * `/score/<tool>.md` (full audit table) and the live `/live-score/<binary>.md`
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
export function formatAuditRowMarkdown(check, opts = {}) {
  const baseUrl = (opts.baseUrl ?? '').replace(/\/$/, '');
  const pNum = groupToPrincipleNum(check.group);
  const groupLabel = pNum ? `[${check.group}](${baseUrl}/p${pNum})` : check.group;
  const evidence = (check.evidence ?? '').replaceAll('|', '\\|');
  const label = check.label.replaceAll('|', '\\|');
  return `| ${statusLabel(check.status)} | ${label} | ${groupLabel} | ${evidence} |`;
}

/**
 * Emit a complete markdown audit table (header + rows). When `checks` is
 * empty, returns an empty array so the caller can decide what to put in
 * its place (e.g., a "no issues" message).
 *
 * @param {Array<{status:string,label:string,group:string,evidence:string|null}>} checks
 * @param {{ baseUrl?: string }} [opts]
 * @returns {string[]} markdown lines
 */
export function formatAuditTableMarkdownLines(checks, opts = {}) {
  if (checks.length === 0) return [];
  return [
    '| Status | Audit | Principle | Evidence |',
    '|--------|-------|-----------|----------|',
    ...checks.map((c) => formatAuditRowMarkdown(c, opts)),
  ];
}

// -------------------------------------------------------------------
// Scoring + per-section HTML/markdown renderers shared by the build
// pipeline (src/build/scorecards-render.mjs) and the Worker live-score
// renderer (src/worker/score/summary-render.ts). Single source of truth
// so /score/<tool> and /score/live/<binary> stay structurally aligned.
// -------------------------------------------------------------------

// Badge eligibility floor (percent). Authoritative for the rendered
// "badge floor is N%" copy; the cohort-band fills in src/build/badge.mjs
// import this same constant so the floor + color bands never drift.
export const BADGE_ELIGIBILITY_FLOOR_PCT = 70;

// Evidence prefix the CLI emits for any check suppressed by `--audit-profile`.
// Mirrors `SUPPRESSION_EVIDENCE_PREFIX` in agentnative/src/principles/registry.rs
// — the trailing space is part of the documented contract.
const AUDIT_PROFILE_SUPPRESSION_PREFIX = 'suppressed by audit_profile: ';

/**
 * Map principle groups to pass/partial/fail/skip and return the met-of-total
 * principle count. Bonus groups (CodeQuality, ProjectStructure) are excluded
 * from the count.
 *
 * @param {{ results?: Array<{ group: string, status: string }> } | null} scorecard
 * @returns {{ met: number, total: number, details: Array<{ group: string, status: string }> }}
 */
export function computePrincipleScore(scorecard) {
  if (!scorecard || !Array.isArray(scorecard.results)) {
    return { met: 0, total: PRINCIPLE_GROUPS.length, details: [] };
  }
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
  return { met, total: PRINCIPLE_GROUPS.length, details };
}

// Detect a Skip whose evidence indicates audit_profile suppression and
// extract the category name. Returns null for organic Skips.
function suppressionCategory(check) {
  if (check.status !== 'skip' || !check.evidence) return null;
  if (!check.evidence.startsWith(AUDIT_PROFILE_SUPPRESSION_PREFIX)) return null;
  return check.evidence.slice(AUDIT_PROFILE_SUPPRESSION_PREFIX.length);
}

/**
 * Render an array of checks as `<tr>` rows for an audit table. Same
 * markup the static `/score/<tool>` page emits.
 *
 * @param {Array<{ status: string, label: string, evidence: string | null }>} checks
 * @returns {string}
 */
export function renderAuditRows(checks) {
  return checks
    .map((check) => {
      const category = suppressionCategory(check);
      const rowClass = category ? 'audit audit--skip audit--suppressed' : `audit audit--${check.status}`;
      const label = category ? `N/A by ${escHtml(category)}` : escHtml(statusLabel(check.status));
      const evidence = check.evidence ? escHtml(check.evidence) : '';
      return `        <tr class="${rowClass}">
          <td class="audit__status">${label}</td>
          <td class="audit__label">${escHtml(check.label)}</td>
          <td class="audit__evidence">${evidence}</td>
        </tr>`;
    })
    .join('\n');
}

/**
 * Render the three-way MUST/SHOULD/MAY coverage summary as an HTML
 * section. Empty string when the scorecard lacks `coverage_summary`.
 *
 * @param {{ must?: { total: number, verified: number }, should?: { total: number, verified: number }, may?: { total: number, verified: number } } | undefined} coverageSummary
 * @returns {string}
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

const AUDIENCE_COPY = {
  mixed:
    'This tool sends mixed signals: some agent-readable affordances are present, others are not. Treat the warnings below as friction points, not defects.',
  'human-primary':
    'This tool appears optimized for human use, not agents. P1/P2/P6/P7 warnings below reflect that audience choice rather than defects.',
};

// Mirrors the SUPPRESSION_TABLE in agentnative/src/principles/registry.rs.
// Keep in sync with the CLI when the table changes upstream.
const AUDIT_PROFILE_COPY = {
  'human-tui':
    'Scored as a TUI: the non-interactive audits (P1) and the SIGPIPE audit (P6) have been suppressed — TUI apps intercept the TTY by design and install their own signal handlers.',
  'file-traversal':
    'Scored as a file-traversal tool: subcommand-shape applicability filters already produce the expected Skip outcomes for fd/find-style tools, so no audits are explicitly suppressed by this profile today.',
  'posix-utility':
    'Scored as a POSIX utility: the non-interactive audits (P1) have been suppressed — POSIX utilities use stdin as their primary input, satisfying the no-prompt requirement vacuously.',
  'diagnostic-only':
    'Scored as a diagnostic-only tool: the dry-run audit (P5) has been suppressed — read-only tools perform no writes, so the write-safety mutation-boundary requirement does not apply.',
};

/**
 * Render the audience/audit-profile informational banner. Empty string
 * when there's nothing to surface (no audience signal AND no profile, or
 * agent-optimized with no profile).
 *
 * @param {string | null | undefined} audience
 * @param {string | null | undefined} auditProfile
 * @returns {string}
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
    '<p class="audience-banner__note">This is an informational signal, not an authoritative verdict — see <a href="/methodology#what-the-audience-signal-is-and-is-not">methodology</a>. The per-audit evidence below is the ground truth.</p>',
  );

  return `<section class="scorecard-audience-banner">
  ${lines.join('\n  ')}
</section>
`;
}

/**
 * Format `run.duration_ms` as a human-readable interval, or null on bad input.
 * @param {unknown} ms
 * @returns {string | null}
 */
export function formatDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

/**
 * Format an RFC 3339 timestamp as `YYYY-MM-DD HH:MM:SS UTC`. Returns null
 * on unparseable input so the caller can drop the row.
 * @param {unknown} rfc3339
 * @returns {string | null}
 */
export function formatStartedAt(rfc3339) {
  if (typeof rfc3339 !== 'string') return null;
  const d = new Date(rfc3339);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.toISOString().replace('T', ' ').slice(0, 19)} UTC`;
}

/**
 * Extract a printable anc-build version string from a scorecard's `anc`
 * block, or null when absent. HTML/markdown surfaces share this — the
 * caller decides whether to wrap in `<code>` or backticks.
 * @param {{ version?: unknown } | null | undefined} anc
 * @returns {string | null}
 */
export function getAncBuildVersion(anc) {
  if (!anc || typeof anc.version !== 'string') return null;
  return anc.version;
}

// -------------------------------------------------------------------
// Per-tool scorecard body + markdown twin — single source of truth for
// /score/<slug> (static, registry-joined) and /score/live/<binary>
// (Worker, no registry editorial fields). Editorial fields on `tool`
// (`tier`, `description`, `language`, `repo`/`url`, `install`) are
// optional: present for the curated path, absent for the live path. The
// `opts` parameter supplies breadcrumb override, freshness marker (live
// only), and reproducibility URL for the CTA tail.
// -------------------------------------------------------------------

const DEFAULT_BREADCRUMB = { href: '/scorecards', label: '← Leaderboard' };

function renderEligibleEmbed(tool, scorecard, opts) {
  const pct = scorecard.badge.score_pct;
  const embedMd = scorecard.badge.embed_markdown;
  const preview = opts.showBadgePreview
    ? `\n  <p class="scorecard-embed__preview">Preview: <img src="/badge/${escHtml(tool.name)}.svg" alt="agent-native badge for ${escHtml(tool.name)}" /></p>`
    : '';
  return `<section class="scorecard-embed scorecard-embed--eligible">
  <h2>Embed the badge</h2>
  <p>This score (${pct}%) clears the <a href="/badge">badge floor</a> (${BADGE_ELIGIBILITY_FLOOR_PCT}%). Copy this into your README:</p>
  <pre><code>${escHtml(embedMd)}</code></pre>${preview}
</section>
`;
}

function renderBelowFloorHint(pct, hasIssues) {
  const gap = BADGE_ELIGIBILITY_FLOOR_PCT - pct;
  const issuesPointer = hasIssues
    ? ' The top issues above are the place to start.'
    : ' See the full audit results below for the gaps.';
  return `<section class="scorecard-embed scorecard-embed--below">
  <h2>Embed the badge</h2>
  <p>The <a href="/badge">badge floor</a> is ${BADGE_ELIGIBILITY_FLOOR_PCT}%; this scorecard is at ${pct}% (${gap} point${gap === 1 ? '' : 's'} below). Once the score clears the floor, the embed snippet will appear here.${issuesPointer}</p>
</section>
`;
}

/**
 * Build the per-tool scorecard page body HTML. One renderer for both
 * `/score/<slug>` (build-time, registry-joined `tool`) and
 * `/score/live/<binary>` (Worker, scorecard-derived `tool` only). Calls
 * are differentiated by which optional fields `tool` carries and a few
 * cosmetic toggles in `opts`.
 *
 * @param {{
 *   name: string,
 *   binary: string,
 *   tier?: string,
 *   language?: string,
 *   description?: string,
 *   install?: string,
 *   repo?: string,
 *   url?: string,
 * }} tool
 * @param {object} scorecard — schema 0.5/0.6/0.7 parsed JSON
 * @param {{
 *   topIssues?: Array<{ status: string, label: string, group: string, evidence: string | null }>,
 *   principleScore?: { met: number, total: number },
 *   version?: string | null,
 *   metadata?: { tool?: object, anc?: object, run?: object, target?: object },
 *   breadcrumb?: { href: string, label: string },
 *   headerSubline?: string,
 *   titleSuffix?: string,
 *   showBadgePreview?: boolean,
 *   ctaNoteHtml?: string,
 *   hideBadgeEmbed?: boolean,
 *   hideReproduce?: boolean,
 *   hideVersionRow?: boolean,
 * }} [opts]
 * @returns {string} HTML body
 */
export function buildScorecardBody(tool, scorecard, opts = {}) {
  const pct = scorecard.badge.score_pct;
  const version = opts.version ?? scorecard.tool?.version ?? null;
  const meta = opts.metadata ?? {
    tool: scorecard.tool,
    anc: scorecard.anc,
    run: scorecard.run,
    target: scorecard.target,
  };
  const topIssues = opts.topIssues ?? extractTopIssues(scorecard);
  const principleScore = opts.principleScore ?? computePrincipleScore(scorecard);
  const breadcrumb = opts.breadcrumb ?? DEFAULT_BREADCRUMB;
  const titleSuffix = opts.titleSuffix ?? '';
  const headerSubline = opts.headerSubline ?? '';

  let html = `<nav class="scorecard-breadcrumb" aria-label="Breadcrumb">
  <a href="${escHtml(breadcrumb.href)}">${escHtml(breadcrumb.label)}</a>
</nav>
`;

  // Header. Description, tier badge, language tag, and repo/url link are
  // emitted only when present on the `tool` object — keeps the live path
  // (no registry editorial fields) clean without if-else branches in the
  // caller. `titleSuffix` (live: version pill) trails the h1 text;
  // `headerSubline` (live: binary+anc+spec+freshness) renders as a
  // small meta paragraph below the h1 to avoid h1 inflation.
  const metaParts = [];
  if (tool.tier)
    metaParts.push(`<span class="tier-badge tier-badge--${escHtml(tool.tier)}">${escHtml(tool.tier)}</span>`);
  if (tool.language) metaParts.push(`<span>${escHtml(tool.language)}</span>`);
  if (tool.repo) metaParts.push(`<a href="https://github.com/${escHtml(tool.repo)}">${escHtml(tool.repo)}</a>`);
  else if (tool.url) metaParts.push(`<a href="${escHtml(tool.url)}">${escHtml(tool.url)}</a>`);

  html += `<header class="scorecard-header">
  <h1>${escHtml(tool.name)}${titleSuffix ? ` ${titleSuffix}` : ''}</h1>
${headerSubline ? `  <p class="live-score-summary__meta">${headerSubline}</p>\n` : ''}${tool.description ? `  <p class="scorecard-header__desc">${escHtml(tool.description)}</p>\n` : ''}${metaParts.length > 0 ? `  <div class="scorecard-header__meta">\n    ${metaParts.join('\n    ')}\n  </div>\n` : ''}</header>
`;

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

  html += renderCoverageSummary(scorecard.coverage_summary);
  html += renderAudienceBanner(scorecard.audience, scorecard.audit_profile);

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

  const results = Array.isArray(scorecard.results) ? scorecard.results : [];
  html += `<section class="scorecard-audits">
  <h2>All Audits</h2>
`;
  for (const group of PRINCIPLE_GROUPS) {
    const checks = results.filter((r) => r.group === group);
    if (checks.length === 0) continue;
    const pNum = groupToPrincipleNum(group);
    const groupName = PRINCIPLE_NAMES[group] || group;
    const groupLink = pNum ? `/p${pNum}` : null;
    html += `  <div class="audit-group">
    <h3 class="audit-group__title">${groupLink ? `<a href="${groupLink}">` : ''}${escHtml(group)}: ${escHtml(groupName)}${groupLink ? '</a>' : ''}</h3>
    <table class="audit-table">
      <tbody>
${renderAuditRows(checks)}
      </tbody>
    </table>
  </div>
`;
  }
  const bonusChecks = results.filter((r) => BONUS_GROUPS.includes(r.group));
  if (bonusChecks.length > 0) {
    html += `  <div class="audit-group audit-group--bonus">
    <h3 class="audit-group__title">Code Quality</h3>
    <table class="audit-table">
      <tbody>
${renderAuditRows(bonusChecks)}
      </tbody>
    </table>
  </div>
`;
  }
  html += `</section>
`;

  // Details — every value escaped. tool.* fields are author-controlled
  // (registry editorial), scorecard.* fields come from CLI output that
  // could carry HTML metacharacters. Web targets pass hideVersionRow (no
  // binary version to report) and carry no run/target/anc blocks, so the
  // section collapses to nothing and is omitted below.
  const detailRows = opts.hideVersionRow ? [] : [`<dt>Version scored</dt><dd>${escHtml(version || '—')}</dd>`];
  const auditDate = formatStartedAt(meta.run?.started_at);
  if (auditDate) detailRows.push(`<dt>Audit date</dt><dd>${escHtml(auditDate)}</dd>`);
  const duration = formatDuration(meta.run?.duration_ms);
  if (duration) detailRows.push(`<dt>Duration</dt><dd>${escHtml(duration)}</dd>`);
  if (meta.run?.platform?.os && meta.run?.platform?.arch) {
    detailRows.push(
      `<dt>Platform</dt><dd><code>${escHtml(meta.run.platform.os)}/${escHtml(meta.run.platform.arch)}</code></dd>`,
    );
  }
  if (meta.target?.kind) detailRows.push(`<dt>Mode</dt><dd>${escHtml(meta.target.kind)}</dd>`);
  const ancBuild = getAncBuildVersion(meta.anc);
  if (ancBuild) detailRows.push(`<dt>Anc build</dt><dd>${escHtml(ancBuild)}</dd>`);
  if (tool.install) {
    detailRows.push(`<dt>Install</dt><dd><code>${escHtml(tool.install)}</code></dd>`);
  }
  if (detailRows.length > 0) {
    html += `<section class="scorecard-meta">
  <h2>Details</h2>
  <dl class="meta-list">
    ${detailRows.join('\n    ')}
  </dl>
</section>
`;
  }

  // Badge-embed block. Suppressed for web targets (no embeddable web
  // badge — KTD-11); CLI callers leave hideBadgeEmbed unset.
  if (!opts.hideBadgeEmbed) {
    html += scorecard.badge.eligible
      ? renderEligibleEmbed(tool, scorecard, opts)
      : renderBelowFloorHint(pct, topIssues.length > 0);
  }

  // Reproduce CTA. Suppressed for web targets (no `anc audit` reproduce
  // path); CLI callers leave hideReproduce unset.
  if (opts.hideReproduce) return html;

  // Prefer the exact recorded invocation when target.kind is `command`;
  // otherwise synthesize the safe canonical form.
  let reproCommand;
  if (meta.target?.kind === 'command' && typeof meta.run?.invocation === 'string') {
    reproCommand = escHtml(meta.run.invocation);
  } else {
    const profileFlag = scorecard.audit_profile ? ` --audit-profile ${scorecard.audit_profile}` : '';
    reproCommand = `anc audit --command ${escHtml(tool.binary)}${profileFlag}`;
  }
  const ctaText =
    topIssues.length === 0
      ? `Reproduce this scorecard for <code>${escHtml(tool.name)}</code> locally:`
      : `Reproduce this scorecard for <code>${escHtml(tool.name)}</code> locally and inspect the failing audits:`;
  const ctaNote =
    opts.ctaNoteHtml ??
    `<a href="/install">Install <code>anc</code></a> first if you don't have it.
  Add <code>--output json</code> to get the same JSON shape committed under
  <a href="https://github.com/brettdavies/agentnative-site/tree/main/scorecards"><code>scorecards/</code></a>.`;
  html += `<section class="scorecard-cta">
  <p>${ctaText}</p>
  <pre><code>${reproCommand}</code></pre>
  <p class="scorecard-cta__note">${ctaNote}</p>
</section>`;

  return html;
}

/**
 * Build the per-tool scorecard markdown twin. Editorial fields on `tool`
 * are optional (same shape as buildScorecardBody). `opts.baseUrl` makes
 * the principle links absolute for cross-origin consumers
 * (Worker /score/live/<binary>.md fetched with `Accept: text/markdown`).
 *
 * @param {object} tool
 * @param {object} scorecard
 * @param {{ version?: string | null, metadata?: object, principleScore?: { met:number,total:number }, baseUrl?: string, header?: string, footer?: string[], hideBadgeEmbed?: boolean, hideReproduce?: boolean, hideVersionRow?: boolean }} [opts]
 * @returns {string} markdown
 */
export function buildScorecardMarkdown(tool, scorecard, opts = {}) {
  const version = opts.version ?? scorecard.tool?.version ?? null;
  const meta = opts.metadata ?? {
    tool: scorecard.tool,
    anc: scorecard.anc,
    run: scorecard.run,
    target: scorecard.target,
  };
  const principleScore = opts.principleScore ?? computePrincipleScore(scorecard);
  const baseUrl = opts.baseUrl ?? '';
  const lines = [];

  if (opts.header) lines.push(opts.header);
  else lines.push(`# ${tool.name}`);
  lines.push('');
  if (tool.description) {
    lines.push(tool.description);
    lines.push('');
  }

  const pct = scorecard.badge.score_pct;
  lines.push(`**Score:** ${pct}% pass rate`);
  lines.push(`**Principles:** ${principleScore.met}/${principleScore.total} met`);
  lines.push('');

  // Badge-embed block. Suppressed for web targets (KTD-11).
  if (!opts.hideBadgeEmbed) {
    if (scorecard.badge.eligible) {
      lines.push('## Embed the badge');
      lines.push('');
      lines.push(
        `This score (${pct}%) clears the [badge floor](${baseUrl}/badge) (${BADGE_ELIGIBILITY_FLOOR_PCT}%). Copy this into your README:`,
      );
      lines.push('');
      lines.push('```markdown');
      lines.push(scorecard.badge.embed_markdown);
      lines.push('```');
      lines.push('');
    } else {
      const gap = BADGE_ELIGIBILITY_FLOOR_PCT - pct;
      lines.push('## Embed the badge');
      lines.push('');
      lines.push(
        `The [badge floor](${baseUrl}/badge) is ${BADGE_ELIGIBILITY_FLOOR_PCT}%; this scorecard is at ${pct}% (${gap} point${gap === 1 ? '' : 's'} below). Once the score clears the floor, the embed snippet will appear here.`,
      );
      lines.push('');
    }
  }

  for (const row of formatAuditTableMarkdownLines(scorecard.results ?? [], { baseUrl })) {
    lines.push(row);
  }
  lines.push('');

  if (tool.repo) {
    lines.push(`**Repo:** [${tool.repo}](https://github.com/${tool.repo})`);
  } else if (tool.url) {
    lines.push(`**Source:** [${tool.url}](${tool.url})`);
  }
  if (tool.language) lines.push(`**Language:** ${tool.language}`);
  if (!opts.hideVersionRow) lines.push(`**Version scored:** ${version || '—'}`);
  const auditDateMd = formatStartedAt(meta.run?.started_at);
  if (auditDateMd) lines.push(`**Audit date:** ${auditDateMd}`);
  const durationMd = formatDuration(meta.run?.duration_ms);
  if (durationMd) lines.push(`**Duration:** ${durationMd}`);
  if (meta.run?.platform?.os && meta.run?.platform?.arch) {
    lines.push(`**Platform:** \`${meta.run.platform.os}/${meta.run.platform.arch}\``);
  }
  if (meta.target?.kind) lines.push(`**Mode:** ${meta.target.kind}`);
  const ancBuildMd = getAncBuildVersion(meta.anc);
  if (ancBuildMd) lines.push(`**Anc build:** ${ancBuildMd}`);
  if (tool.install) lines.push(`**Install:** \`${tool.install}\``);

  // Reproduce-locally block. Suppressed for web targets (no `anc audit`
  // reproduce path); CLI callers leave hideReproduce unset.
  if (!opts.hideReproduce) {
    lines.push('');
    let reproMd;
    if (meta.target?.kind === 'command' && typeof meta.run?.invocation === 'string') {
      reproMd = meta.run.invocation;
    } else {
      const profileFlag = scorecard.audit_profile ? ` --audit-profile ${scorecard.audit_profile}` : '';
      reproMd = `anc audit --command ${tool.binary}${profileFlag}`;
    }
    lines.push('## Reproduce locally');
    lines.push('');
    lines.push('```bash');
    lines.push(reproMd);
    lines.push('```');
    lines.push('');
  }

  if (Array.isArray(opts.footer)) {
    for (const line of opts.footer) lines.push(line);
  }

  return lines.join('\n');
}
