// Badge SVG generation — emit `dist/badge/<tool>.svg` per scored tool.
//
// The badge surface is defined by the convention at /badge (content/badge.md).
// This module renders the SVG; eligibility-gating of the embed snippet on
// per-tool scorecard pages lives in scorecards-render.mjs.
//
// The renderer is `badge-maker` — the same library shields.io uses
// internally. Self-hosting via badge-maker means anc.dev owns the
// availability story end-to-end; no third-party endpoint, no shields.io
// account, no runtime upstream dependency.

import { makeBadge } from 'badge-maker';
import { SPEC_VERSION } from './util.mjs';

// Color thresholds — applied against the rounded percent score (0–100).
// Brightline green at the badge floor (80) so a reader instantly sees
// "this tool clears the bar". Yellow band covers the 60–79 mid-tier;
// red is reserved for genuinely off-target tools so the visual stays
// honest when a tool regresses.
const COLOR_GREEN = 'brightgreen';
const COLOR_YELLOW = 'yellow';
const COLOR_RED = 'red';

/**
 * Map a 0–100 percent score to a shields-style color name.
 *
 * @param {number} pct — integer percent (0–100)
 * @returns {string}
 */
export function badgeColor(pct) {
  if (pct >= 80) return COLOR_GREEN;
  if (pct >= 60) return COLOR_YELLOW;
  return COLOR_RED;
}

/**
 * Build the badge format object for a tool's score.
 *
 * The label cites the spec version the score is rooted in
 * (e.g., `agent-native v0.3`), so a reader sees both the standard and the
 * version baseline at a glance. The message is the rounded percent score.
 *
 * Pulled out of {@link renderBadgeSvg} as a pure function so tests can
 * assert the format without parsing SVG.
 *
 * @param {number} score — 0–1 from computeScore()
 * @param {string=} specVersion — e.g., '0.3.0'; defaults to SPEC_VERSION
 * @returns {{ label: string, message: string, color: string, labelColor: string, style: string }}
 */
export function badgeFormat(score, specVersion = SPEC_VERSION) {
  const pct = Math.round(score * 100);
  // Drop the patch component for the label so the badge stays terse:
  // `v0.3` is enough to identify the spec series; the patch is rarely
  // load-bearing for a reader scanning a README.
  const labelVersion = specVersion.split('.').slice(0, 2).join('.');
  return {
    label: `agent-native v${labelVersion}`,
    message: `${pct}%`,
    color: badgeColor(pct),
    labelColor: '#555',
    style: 'flat',
  };
}

/**
 * Render an SVG badge for a tool's score.
 *
 * Pure function — no I/O. The build orchestrator handles writing to
 * `dist/badge/<tool>.svg`.
 *
 * @param {number} score — 0–1 from computeScore()
 * @param {string=} specVersion
 * @returns {string} SVG source
 */
export function renderBadgeSvg(score, specVersion) {
  return makeBadge(badgeFormat(score, specVersion));
}
