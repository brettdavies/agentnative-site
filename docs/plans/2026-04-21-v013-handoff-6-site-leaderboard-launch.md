---
title: "Handoff 6 of 6: v0.1.3 ANC 100 leaderboard launch (site)"
type: handoff
order: 6
phase: v0.1.3
depends_on: [1, 2, 3, 4, 5]
prerequisites: ["CLI handoff 5 (v0.1.3) shipped", "100-tool registry baseline complete with committed scorecards"]
blocks: []
---

# Handoff 6: v0.1.3 ANC 100 leaderboard launch (site)

**Written for**: the session that turns the pre-GA project into a public leaderboard. Happens only after CLI handoff 5
has shipped `anc` v0.1.3 AND the 100-tool registry has baseline scores. This is the launch-facing release. CLI-side
v0.1.3 work (audience classifier, `audit_profile` suppression, `p1-env-hints` pattern 2) is **not owned by this plan** —
see "Split from original combined H5" below.

## Split from original combined H5

This plan was originally a combined H5 covering both CLI and site work. Per the agentnative project convention ("each
repo's `docs/plans/` owns the work that happens in that repo"), the CLI-side scope was split into a separate handoff
living in its own repo:

- **CLI H5 (v0.1.3)** — source of truth in `agentnative` repo at
  `docs/plans/2026-04-21-v013-handoff-5-cli-audience-classifier.md`. Delivers the audience classifier, the
  `--audit-profile` flag + suppression, and `p1-env-hints` Pattern 2.
- **Site H6 (v0.1.3)** — this document. Delivers the banner, leaderboard filters, `/scorecards` go-live, and methodology
  note.

Release ordering is strict: CLI H5 ships first (as `anc` v0.1.3 on crates.io + Homebrew), then the site's
committed scorecards are regenerated against the new binary, then this handoff executes. Do not start this work until
the CLI half has shipped and the 10 committed scorecards have been refreshed.

The original filename and handoff number were renamed (H5 → H6) to reflect the post-split sequence; the content below
has been scoped down to site-only work.

## Sibling handoffs

| # | Phase  | Repo               | Doc                                                                              |
| - | ------ | ------------------ | -------------------------------------------------------------------------------- |
| 1 | v0.1.1 | `agentnative`      | `docs/plans/2026-04-20-v011-handoff-1-agentnative-impl.md`                       |
| 2 | v0.1.1 | `agentnative-site` | `docs/plans/2026-04-20-v011-handoff-2-site-spec-coverage.md` (+ session brief)   |
| 3 | v0.1.1 | `agentnative-site` | `docs/plans/2026-04-20-v011-handoff-3-scorecard-regen.md`                        |
| 4 | v0.1.2 | `agentnative`      | `docs/plans/2026-04-20-v012-handoff-4-behavioral-checks.md`                      |
| 5 | v0.1.3 | `agentnative`      | `docs/plans/2026-04-21-v013-handoff-5-cli-audience-classifier.md` *(CLI, ships first)* |
| 6 | v0.1.3 | `agentnative-site` | `docs/plans/2026-04-21-v013-handoff-6-site-leaderboard-launch.md` *(this doc)*   |

## The job, in one sentence

Surface the CLI-emitted `audience` and `audit_profile` fields in the per-tool page, ship the ANC 100 leaderboard with
filters and sorting, and publish the methodology note that frames audience classification as informational signal rather
than authoritative verdict.

## Hard prerequisites: DO NOT launch without these

1. **CLI v0.1.3 shipped** with the audience classifier, `audit_profile` suppression, and the Pattern 2 env-hints fix.
   Verify via `anc --version` and `anc check <tool> --output json | jaq '.audience, .audit_profile'` returning string
   values (not `null`) when the inputs warrant it.
2. **`registry.yaml` has ≥100 tools AND every tool has a baseline scorecard committed.** Current status at handoff
   creation: ~80 entries, 10 with committed scorecards. **Launching before this is met makes the leaderboard look
   punitive** — 5 of 10 current tools would drop under new checks, producing the HN narrative "new linter rates famous
   tools badly based on rules written last week" (per the CEO review's outside voice Finding #7).

If either prerequisite isn't ready, do not start this handoff. Registry growth + initial scoring is its own
track; it's not covered here.

## Read these first

1. `~/.gstack/projects/brettdavies-agentnative/ceo-plans/2026-04-20-p1-doctrine-spec-coverage.md` — "Accepted Scope
   (v0.1.3)" section.
2. `docs/brainstorms/anc-100-audit-requirements.md` — the original leaderboard spec (R1-R20) in this repo. Skip
   requirements already met by v0.1.1 + v0.1.2.
3. `~/dev/agentnative/docs/plans/2026-04-21-v013-handoff-5-cli-audience-classifier.md` — the CLI-side plan this site
   work consumes. Read the "Key Technical Decisions" and "System-Wide Impact" sections in particular to understand the
   shape of `audience` and `audit_profile` values emitted in the scorecard JSON.

Do NOT re-read doctrine transcripts.

## Scope

### In `agentnative-site` (site) — everything below is this plan's scope

- **Audience banner on `/score/<tool>`** — render when `audience != "agent_optimized"` OR `audit_profile` is present
  (non-null). Copy stance: informational, not shaming. Example: "This tool appears optimized for humans, not agents.
  P1/P2/P7 warnings below reflect that audience choice rather than defects." When `audit_profile` is present, the banner
  cites the applied profile and links to the methodology note explaining the suppression category.
- **Suppressed-check rendering on `/score/<tool>`** — checks with evidence matching `suppressed by audit_profile:
  <category>` get a distinct visual treatment (muted, tagged "N/A by category") separate from genuine Skip results. The
  per-check row still shows what was excluded and why.
- **Leaderboard filters on `/scorecards`** — "Agent-optimized only" toggle. TUI-by-design (`audit_profile: human-tui`)
  and file-traversal (`audit_profile: file-traversal`) tools hidden by default; visible when toggled on. Additional
  filter axes from the anc-100 brainstorm (R10-R14) as scope allows.
- **Go-live on `/scorecards`** — whatever R10-R14 of the ANC 100 audit brainstorm hasn't shipped already:
  sortable/filterable leaderboard, tier filters, install-CTA per scorecard, `llms-full.txt` inclusion.
- **Methodology note** — explicit sentence about audience classification being aggregate and informational, not
  authoritative. The per-check evidence is the ground truth. Link from the audience banner and from the `/scorecards`
  page header.

### Not in this plan (see CLI H5)

- Audience classifier logic (the 4-signal-check rule). Lives in `agentnative/src/scorecard/audience.rs`.
- `ExceptionCategory` → suppressed check IDs mapping. Lives in `agentnative/src/principles/registry.rs`.
- `--audit-profile` CLI flag. Lives in `agentnative/src/cli.rs`.
- Drift test for the 4 signal check IDs.
- `p1-env-hints` Pattern 2 (bash-style `$FOO` detection).

## Out of scope

- PTY probes — deferred to post-v0.1.x.
- `CheckStatus::Coverage` variant — still deferred. TODOS.md item.
- `--fix` track — parallel track, different release cycle.
- GitHub Action integration — strategic track, not this release.
- Any principle restructuring — deferred; revisit with leaderboard data.
- Audience classifier tuning (e.g., weighting signal checks, adding a fifth signal). If a tool is mislabeled, the fix
  lives in the CLI registry (`audit_profile` addition) or in the MUST set (new check in a future CLI release), NOT in
  site-side rendering.

## Branch + workflow

- Branch: `feat/v013-leaderboard-launch`.
- PR target: `dev`.
- After merge: follow the site's usual release flow; the leaderboard goes live on the next site deploy. There's no
  `agentnative-site` tag to coordinate with `agentnative`'s `v0.1.3` tag — the CLI version is immutable on crates.io;
  site deploys are continuous.
- Announcement coordination (Show HN, Tweet, etc.) is NOT part of this handoff. That's a product-launch track.

## Definition of done

- [ ] Per-tool `/score/<tool>` page renders the audience banner when applicable, with copy that matches the methodology
  stance.
- [ ] Suppressed checks on `/score/<tool>` show the distinct "N/A by category" treatment separate from genuine Skips.
- [ ] `/scorecards` leaderboard renders ≥100 tools; sorting and filtering work; the "Agent-optimized only" toggle hides
  TUI-by-design and file-traversal tools by default.
- [ ] Methodology note published; linked from the audience banner and from the `/scorecards` header.
- [ ] Manual sanity check (fixtures known from the CLI side): `gh` renders without a banner (agent-optimized); `lazygit`
  renders with a `human-tui` banner; `ripgrep` renders without a banner after the Pattern 2 env-hint fix; `fd` renders
  with a `file-traversal` banner.
- [ ] Regression sweep against the 10 committed scorecards: every page loads, no renderer throws on an unknown
  `audit_profile` string or unexpected `audience` value.
- [ ] `llms-full.txt` includes the new leaderboard surface and links to per-tool pages.

## Known gotchas

- The audience classifier is **informational, not authoritative**. The banner is a hint; the per-check evidence list
  below it is the truth. Never collapse the scorecard list into "tool passes/fails" based on audience alone. Per the CEO
  review's outside voice Finding #3: aggregate signal is strictly weaker than per-check evidence.
- `audit_profile` suppression does NOT delete check results from the scorecard JSON. The CLI emits suppressed checks as
  `CheckStatus::Skip` with evidence `"suppressed by audit_profile: <category>"`. Render them in the page, tagged as
  N/A-by-category — don't filter them out. Readers get to see what was excluded and why.
- Schema-compat: v1.1 scorecards never populated `audience` or `audit_profile` (both `null`). v1.3+ will. The site's
  `renderCoverageSummary()` + `renderAudienceBanner()` already feature-detect missing keys (from H2) — verify the
  detection still works when the keys are present but the banner logic branches on values rather than presence.
- Renderer robustness: `audience` can be any of `"agent_optimized"`, `"mixed"`, `"human_primary"`, or `null`.
  `audit_profile` can be any of `"human-tui"`, `"file-traversal"`, `"posix-utility"`, `"diagnostic-only"`, or `null`.
  Render defensively — an unknown string should fall through to a safe "unknown category" treatment rather than crash.
- When classifier disagrees with intuition (e.g., a tool you consider agent-hostile gets `audience: "agent_optimized"`),
  do NOT patch the site's rendering to override. File a registry `audit_profile` update on
  `agentnative-site/scorecards/registry.yaml` (if the tool fits an exception category) or escalate to the CLI side as a
  potential new check. The site renders what the CLI emits.

## After this PR merges

The ANC 100 leaderboard is live. Future work:

- Community registry submissions (R19).
- PTY probe principle revision (separate doctrine call).
- `--fix` track starts (parallel to spec work, CLI-side).
- GitHub Action integration (strategic track).
- Post-launch tuning based on real user feedback on the scorecard.
- Per-tool audience-banner copy iteration if the initial stance reads as scolding — the banner is one of the most
  visible pieces of prose on the site.
