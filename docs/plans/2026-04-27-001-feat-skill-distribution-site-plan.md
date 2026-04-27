---
title: "feat: Site /install + /install.json endpoints + producer cutover (Units 2–5 of skill-distribution master plan)"
type: feat
status: active
date: 2026-04-27
master_plan: ./2026-04-24-001-feat-skill-distribution-endpoint-plan.md
related_session: ../../../agentnative-skill/docs/plans/2026-04-27-001-bootstrap-agentnative-skill-plan.md
origin: master plan Units 2–5, executed in dedicated session
---

# feat: Site /install + /install.json endpoints + producer cutover

## Session Context

This plan is executed by a **dedicated session whose cwd is `~/dev/agentnative-site/`**. A parallel session in
`~/dev/agentnative-skill/` runs the bootstrap plan (Unit 1). The two sessions exchange exactly **one artifact**: the
v0.1.0 commit SHA produced there, consumed here as `source.commit` in `src/data/install.json`.

**Master plan (canonical reference):** `./2026-04-24-001-feat-skill-distribution-endpoint-plan.md` — Units 2–5.
**Sibling skill plan:** `~/dev/agentnative-skill/docs/plans/2026-04-27-001-bootstrap-agentnative-skill-plan.md`.

This document defines execution shape; the master plan defines architectural rationale (header policy, JSON shape, test
scenarios). Read the master plan's Units 2–5 first.

## State at Session Start

Before kicking off this plan, the orchestrator must confirm:

- [ ] Skill session reports `agentnative-skill v0.1.0 ready for site pin.` with a 40-char commit SHA. Capture the SHA;
  it pins `source.commit` in Unit 2.
- [ ] `gh api repos/brettdavies/agentnative-skill/git/ref/tags/v0.1.0 --jq '.object.sha'` resolves to the same SHA the
  skill session reported (independent verification — also catches a tag pointing at an annotated-tag object instead of a
  commit; if so, dereference per the global SHA-pinning rule).
- [ ] Skill repo is still PRIVATE. The cutover (visibility flip) is the closing step of Unit 5 here.
- [ ] Working tree of `~/dev/agentnative-site/` is clean on `dev`.

## Goals

1. Emit `/install.json` (canonical machine surface) and `/install` (HTML render, identical commands) at site build time.
2. Worker serves `.json` extensions with the right headers and skips the `Accept: text/markdown` content-negotiation
   rewrite for them.
3. Tests gate the contract: structural + JSON-HTML byte-equivalence in fast PR CI; 4-host live e2e in `deep-check.yml`;
   daily synthetic availability probe via scheduled workflow.
4. Documentation reflects the new endpoints, the release runbook, and the VOICE register for `/install`.
5. **Coordinate the public-visibility flip** of `agentnative-skill` with this PR's lifecycle so the network-touching e2e
   doesn't run against a private repo.

## Non-Goals (re-stated from master plan)

- No `/skill/<name>` URL pattern. Defer to v2 when N>1 skills.
- No `marketplace.json`, no `curl | sh`, no install scripts.
- No new Worker bindings; it stays asset-only with content-negotiation headers.
- No D1/KV/R2.
- No backporting other skills into `/install.json` — the v1 manifest is single-skill.

## Branch & PR Strategy

Per repo memory (`feedback_dev_branch_squash_flow.md` and `feedback_auto_squash_merge.md`): dev off main, features off
dev, squash-PR to dev. Auto-squash-merge on green checks. Single final dev → main PR ships everything.

The four units are linearly dependent (Unit 3 reads Unit 2's data file; Unit 4 tests the artifacts of Units 2+3; Unit 5
documents all of them). Two viable shapes:

- **Option A (preferred): one feature branch, four ordered commits, one squash-PR to `dev`.** Reviewers see the units as
  commits; squash collapses them on merge. Lower coordination overhead because the units are tightly coupled — there is
  no "ship just Unit 2 and stop" outcome.
- **Option B: four feature branches, four squash-PRs to `dev`.** Heavier on PR ceremony; only worth it if a unit slips
  and ships in a separate window. The master plan does not require this granularity.

**This plan assumes Option A.** Branch name: `feat/skill-distribution-endpoints`. Commits below map to units; commit
boundaries are the squash inputs but the merge is single.

## Implementation

### Unit 2: `/install.json` data file + build emitter + Worker JSON headers

**Objective:** Vendor the manifest and serve it from the Worker with the right headers.

**Files to create / modify:**

- **NEW** `src/data/install.json` — the full v1 manifest, hand-maintained. Required keys per master plan §
  "/install.json shape": `schema_version`, `type`, `name`, `version`, `description`, `principles_url`, `license`,
  `source` (`type`/`url`/`commit`), `install` (per-host map covering `claude_code`, `codex`, `cursor`, `opencode`),
  `verify`, `update`, `uninstall`, `install_page_html`. **`source.commit` = the SHA captured at session start.**
- **NEW** `src/build/install.mjs` — exports `loadInstallData()` and `emitInstallJson(data)`. Validation in
  `loadInstallData`: every required key present; `commit` is 40-char hex (`/^[0-9a-f]{40}$/`); `version` is semver;
  `install` map non-empty; per-host commands start with `git clone --depth 1` and terminate with an explicit destination
  path (no bare clones — defense for the repo-name asymmetry). Emit `dist/install.json` with sorted keys, two-space
  indent, trailing newline.
- **MODIFY** `src/build/build.mjs` — call `loadInstallData()` then `emitInstallJson()`. Pattern after the existing
  scorecard subdir emission (master plan cites lines 283–305).
- **MODIFY** `src/worker/headers.ts` — add a JSON-extension branch detected by URL ending in `.json` (NOT a URL prefix
  like `^/install\.json$` — extension lets `/skill/<name>.json` in v2 reuse the branch without churn). Headers per
  master plan: `Content-Type: application/json; charset=utf-8`, `Cache-Control: public, max-age=300, s-maxage=86400,
  stale-while-revalidate=60`, `Access-Control-Allow-Origin: *`, `X-Robots-Tag: noindex`. Skip the `Link:` and
  `X-Llms-Txt` markdown-twin headers.
- **MODIFY** `src/worker/index.ts` — the `Accept: text/markdown` content-negotiation rewrite must short-circuit on paths
  ending in `.json` so it doesn't try to fetch a non-existent `/install.md` substitute when the `.json` was requested
  with that header. Add an explicit early-return.

**Validation gates (Unit 2 done):**

- `bun run build` produces `dist/install.json`. Re-run idempotent (byte-stable across two runs).
- New unit test in `tests/regression.test.ts`: parses `dist/install.json`; required keys present; `source.commit` ===
  the SHA from `src/data/install.json`.
- New unit test in `tests/worker.test.ts`: GET `/install.json` returns headers per spec; GET `/install.json` with
  `Accept: text/markdown` returns the JSON (not 404).

**Reference (institutional learnings, from master plan):**

- `docs/solutions/best-practices/cloudflare-workers-static-assets-custom-headers-2026-04-14.md` — all headers in
  `src/worker/headers.ts`, never in a `_headers` file.
- `docs/solutions/configuration-fixes/wrangler-placement-smart-wrong-for-static-asset-site-2026-04-14.md` — no
  `placement: smart`.

**Suggested commit boundary:** `feat(install): emit /install.json with JSON-extension Worker headers`

---

### Unit 3: `/install` HTML render (templated from `/install.json`)

**Objective:** Render the human-facing install page from the SAME data file Unit 2 emits as JSON. Single source of truth
— drift is structurally impossible because there's only one source.

**Files to modify:**

- **MODIFY** `src/build/install.mjs` — add `emitInstallHtml(data)` and `emitInstallMarkdown(data)`.
- Build a markdown intermediate from a static prose template + per-host install table interpolated from `data.install`.
  Sections in order match master plan §"`/install` HTML": Title + lede; Choose your host (table with copy-buttons); What
  this does; Already installed?; Update; Uninstall; Trust model; Verify; Programmatic.
- Run the markdown through the existing unified+remark-rehype+shiki pipeline (`src/build/render.mjs`) for code-block
  highlighting parity with the rest of the site.
- Write `dist/install.md` (the markdown twin for `Accept: text/markdown` agents) and `dist/install.html`.
- **MODIFY** `src/build/build.mjs` — invoke `emitInstallHtml()` and `emitInstallMarkdown()` after `emitInstallJson()`.
- **MODIFY** `src/build/sitemap.mjs` — add `/install` to the sitemap (humans index this; `/install.json` does NOT enter
  the sitemap because of `X-Robots-Tag: noindex`).
- **MODIFY** `src/build/llms.mjs` — add `/install` and `/install.json` entries to `llms.txt` and a section to
  `llms-full.txt`.

**Voice / register decisions:**

- Trust-model paragraph: VOICE.md Register 1 (third-person, confident verdict, failure mode first). Static prose; does
  not change per release.
- Command sections: Register 2 imperative ("Run …", "Update by …", "Remove with …").
- Master plan note: VOICE.md doesn't yet declare the `/install` register — Unit 5 adds it. Until then the prose voice in
  Unit 3's emitter is informed by master plan §"`/install` HTML" guidance.

**Validation gates (Unit 3 done):**

- `bun run build` emits `dist/install.html` AND `dist/install.md`.
- Regression test asserts `data.install.claude_code` substring appears verbatim in BOTH `dist/install.html` and
  `dist/install.md`.
- `dist/sitemap.xml` contains `/install`. `dist/llms.txt` contains `/install` and `/install.json`.
- Local browser smoke: `bun run preview` (or whatever the existing dev-server entrypoint is — check `package.json`
  scripts), navigate to `http://localhost:<port>/install`, copy buttons render, code blocks highlight.

**Suggested commit boundary:** `feat(install): render /install HTML + /install.md twin from install.json`

---

### Unit 4: Tests, 4-host e2e, synthetic availability probe

**Objective:** Hold the contract. Three test layers: structural (regression, fast PR gate), live (e2e, deep-check), and
synthetic (scheduled probe).

**Files to modify / create:**

- **MODIFY** `tests/regression.test.ts` — assertions:
- `dist/install.json`, `dist/install.html`, `dist/install.md` all exist after `bun run build`.
- Each `install.<host>` value in `dist/install.json` appears byte-for-byte in `dist/install.html` and `dist/install.md`
  (the JSON-HTML parity check; master plan §Unit 4 test scenarios).
- `verify.expected` === `source.commit` (until v2 schema decouples them, the build is the freshness gate).
- **MODIFY** `tests/worker.test.ts` — JSON-extension header tests (positive cases for `/install.json` and a synthetic
  `/foo.json` to confirm the branch matches by extension); CN-rewrite skip test (`Accept: text/markdown` against
  `/install.json` returns JSON not 404); negative test that non-`.json` paths still get HTML-branch headers.
- **MODIFY** `tests/e2e/agents.e2e.ts` — for EACH host advertised in `install.json`'s `install` map (claude_code, codex,
  cursor, opencode):

1. Fetch `/install.json` from staging; extract the host's command.
2. Run the command in a sandboxed temp HOME (override `HOME` to a per-test tmpdir; substitute the destination path's `~`
   accordingly).
3. Assert `SKILL.md` exists at the expected install path.
4. Assert `git -C <install-dir> rev-parse HEAD` === the `source.commit` from the manifest.
5. Assert `git -C <install-dir> ls-remote --exit-code origin <commit>` succeeds.

- Bare-clone footgun check: run `git clone --depth 1 <url>` (no destination) and assert the resulting directory is
  `agentnative-skill` (NOT `agent-native-cli`). This validates the asymmetry mitigation matters and the
  explicit-destination invariant in `loadInstallData()` is non-negotiable.
- **NEW** `.github/workflows/skill-availability.yml` — scheduled (cron: daily, e.g. `0 13 * * *` UTC = 9am ET). Runs
  `git ls-remote https://github.com/brettdavies/agentnative-skill.git HEAD`. Fails the run on non-zero exit. No
  notification beyond the GitHub Actions failure email — the master plan does not call for Slack/PagerDuty in v1.

**Hard-rule reminders (from session memory + global rules):**

- **No `continue-on-error: true` on the e2e or the probe.** `feedback_no_soft_fail_gates.md` is explicit: a soft-fail
  gate silently reverts the gate. If a test or check is unreliable, fix the cause or remove it; do not soften.
- **Local CI parity.** `feedback_ci_env_parity.md`: never push "will validate in CI." Run `bun test` and the e2e locally
  (against staging once deployed; against the producer repo via SSH while it's still private — see Cutover) before
  pushing.
- **Action SHA pinning.** Per global CLAUDE.md, every `uses:` line in `skill-availability.yml` pins to a 40-char SHA
  with a `# vX.Y.Z` trailing comment. Resolve via `gh api repos/<owner>/<repo>/commits/<tag> --jq .sha`. The audit
  script `~/.claude/skills/github-repo-setup/scripts/pin-actions.sh` can verify post-write.

**Validation gates (Unit 4 done):**

- `bun test` passes locally and in fast PR CI.
- E2e suite passes locally against the producer repo (SSH while private; HTTPS once public).
- `skill-availability.yml` runs successfully on a manual `gh workflow run` invocation.

**Suggested commit boundary:** `test(install): add structural + e2e + synthetic probe coverage for skill distribution`

---

### Unit 5: Documentation, cross-references, and **cutover orchestration**

**Objective:** Document the surface, the release runbook, and execute the public-visibility flip of `agentnative-skill`
in the right order.

**Files to modify (docs):**

- **MODIFY** `docs/DESIGN.md` — new §3.X "Skill distribution":
- `/install` (HTML, human-primary) and `/install.json` (canonical, machine-primary) — agent-primary architecture.
- Header contract per Unit 2.
- JSON schema (inline; no separate spec file in v1).
- Cache-purge step in the release runbook.
- **MODIFY** `docs/VOICE.md` — Surface-Specific Notes: declare `/install` as mixed-register (Register 2 imperative for
  command sections; Register 1 third-person for the trust-model paragraph). Note that `/install.json` is data-only; no
  voice register applies.
- **MODIFY** `AGENTS.md` — add a paragraph naming `/install` and `/install.json` with one-line purposes. Keep terse —
  the file is for agents, not narrative.
- **MODIFY** `RELEASES.md` — append "Skill releases" section with the four-step procedure:

1. In `agentnative-skill`: edit, commit, tag (`v0.x.y`), push.
2. In `agentnative-site`: bump `src/data/install.json` (`version` and `source.commit`).
3. PR to `dev`; CI runs e2e to verify pin reachability and 4-host install. Deploy after merge.
4. Cache-purge `/install.json` and `/install` via Cloudflare cache-purge API. Required for security-relevant updates;
   recommended for all releases to keep the s-maxage budget honest.

- **MODIFY** `STATUS.md` — mark the originating todo done; reference the published skill repo (link will work once the
  cutover flips public).
- **MODIFY** `.context/compound-engineering/todos/001-ready-p2-serve-anc-skill-from-endpoint.md` — flip status to
  `complete`; add a Work Log entry summarizing the architecture pivots and final shape. **This file is local-only per
  global CLAUDE.md — do NOT commit it. The plan-mode rule about plans being committable does not extend to todos.**
- **MODIFY** site README if it references `~/dev/agent-skills/agent-native-cli/` (grep first; only edit if hits exist).

**Cross-repo doctrine consideration:** Per `cross-repo-artifact-sync-commit-over-fetch-20260420.md`, the site vendors a
single string (the commit SHA) committed at site build time. No fetch-on-build, no submodule. Document this in
`docs/DESIGN.md` if not already covered.

**Cutover sequence (the heart of Unit 5):**

The producer repo must be public BEFORE the `deep-check.yml` e2e runs against it post-deploy.

**Pre-cutover checklist** — verify with the PR open against `dev`, before any merge:

- PR fast-CI green (regression + worker tests).
- Local e2e suite green against the still-private producer repo (SSH).
- `gh api repos/brettdavies/agentnative-skill/commits/v0.1.0 --jq .sha` matches `src/data/install.json` `source.commit`.
- SECURITY.md present in producer repo (`gh api repos/brettdavies/agentnative-skill/contents/SECURITY.md` → 200).
- Branch + tag protection in place: `gh api repos/brettdavies/agentnative-skill/rulesets` lists both rulesets.

**Sequenced steps:**

1. Squash-merge the feature PR → `dev`.
2. Open the final `dev` → `main` PR (per memory: dev-flow squash-merge). Verify CI green on the merge commit too.
3. Flip the producer repo public via `gh repo edit brettdavies/agentnative-skill --visibility public`, then confirm with
   `gh repo view brettdavies/agentnative-skill --json visibility -q .visibility` (expect `PUBLIC`).
4. Run `deep-check.yml` on demand against the dev-merged staging URL (or the live deploy if dev → main has already
   merged). All four host clones must succeed via HTTPS now. If any clone fails, do NOT merge dev → main — investigate.
5. Squash-merge dev → main. Site deploys to anc.dev.
6. Post-deploy cache-purge `/install`, `/install.json`, `/install.md` via the Cloudflare cache-purge API. Use the
   Cloudflare API token referenced in 1Password — do NOT echo the value; refer to it by the 1Password field name per
   global CLAUDE.md "Secrets and identifiers" rule.
7. Smoke-test live with the three checks below.
8. Trigger `skill-availability.yml` once manually (`gh workflow run skill-availability.yml`) to seed a green run on the
   schedule.

**Live smoke checks (step 7):**

```bash
curl -s https://anc.dev/install.json | jq -e '.source.commit | length == 40'    # commit is 40-char hex
curl -sI https://anc.dev/install.json | grep -i 'content-type: application/json'
curl -s https://anc.dev/install | grep -F "$(curl -s https://anc.dev/install.json | jq -r .install.claude_code)"
```

**Validation gates (Unit 5 done):**

- All docs reflect the shipped surface.
- Producer repo is public; `gh repo view` confirms.
- Live `/install`, `/install.json`, `/install.md` return expected content + headers.
- Cache-purge confirmed (via response `cf-cache-status: MISS` on the next request).
- `skill-availability.yml` has at least one green run.

**Suggested commit boundaries (for the squash inputs in Option A):**

- `docs(install): document /install endpoints, voice register, and skill-release runbook`
- (Cutover commands themselves are NOT commits — they are operational gh CLI invocations executed during merge.)

---

## Risks & Mitigations (this session only)

| Risk                                                                         | Mitigation                                                                                                                                                                                 |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Site session starts before the skill SHA is in hand                          | "State at Session Start" checklist (above) makes this a hard gate                                                                                                                          |
| `source.commit` drifts from producer HEAD between site PR open and merge     | Skill repo's branch+tag protection blocks force-moves; `v0.1.0` tag is immutable; the SHA in `install.json` references the tag's commit                                                    |
| Deep-check e2e runs against a still-private producer repo and fails opaquely | Cutover step 4 (public flip) precedes step 5 (deep-check); step 5 is gated on the public flip being verified                                                                               |
| `_headers` file accidentally introduced                                      | Solutions doc forbids; reviewers and `agent-native-architecture` skill review catches                                                                                                      |
| Soft-fail (`continue-on-error: true`) sneaks into the e2e or probe           | Memory `feedback_no_soft_fail_gates.md`; reviewer catches; pre-merge grep `rg 'continue-on-error' .github/workflows/`                                                                      |
| Cache-purge skipped, stale pin lingers up to 24h                             | Cutover step 7 mandates the purge; runbook in `RELEASES.md` documents it as required for security-class updates                                                                            |
| Cloudflare API token echoed in chat / commits                                | Global CLAUDE.md "Secrets and identifiers" rule; never reproduce the literal value, refer by 1Password field name                                                                          |
| Local CI parity drift (Playwright / e2e env)                                 | Memory `feedback_ci_env_parity.md`; use Playwright Docker image or `sudo install-deps`; never push "will validate in CI"                                                                   |
| Bare-clone footgun e2e flakes if the producer's default branch is renamed    | Producer repo's default branch = `dev` per skill plan Step 6; bare clone produces `agentnative-skill/` directory regardless of default branch — assertion is on directory name, not branch |
| Auto-squash-merge on a PR that hasn't been reviewed                          | Memory `feedback_auto_squash_merge.md` — auto-merge is for "checks pass + scope unchanged"; reviewer (user) explicitly approves before merge if scope looks bigger than expected           |
| User invokes `/typeset` or `/design-review` on the install page after Unit 3 | Memory `feedback_route_visual_fixes_via_skills.md` — route visual/typography polish through skills, not direct CSS edits                                                                   |

## Files Touched (this repo)

```text
src/
  build/
    build.mjs              # MODIFY (call install emitter)
    install.mjs            # NEW (loadInstallData, emitInstallJson, emitInstallHtml, emitInstallMarkdown)
    sitemap.mjs            # MODIFY (add /install)
    llms.mjs               # MODIFY (add /install + /install.json)
  data/
    install.json           # NEW (full v1 manifest)
  worker/
    headers.ts             # MODIFY (JSON-extension branch)
    index.ts               # MODIFY (skip CN rewrite for .json paths)
.github/workflows/
  skill-availability.yml   # NEW (daily probe)
tests/
  regression.test.ts       # MODIFY (install artifacts + JSON-HTML parity)
  worker.test.ts           # MODIFY (JSON-extension headers + CN-rewrite skip)
  e2e/
    agents.e2e.ts          # MODIFY (4-host install + bare-clone footgun)
docs/
  DESIGN.md                # MODIFY (skill distribution section)
  VOICE.md                 # MODIFY (/install register)
  plans/
    2026-04-27-001-feat-skill-distribution-site-plan.md  # this plan, committed alongside the work
AGENTS.md                  # MODIFY
RELEASES.md                # MODIFY (skill-release runbook section)
STATUS.md                  # MODIFY (todo done, link skill repo)

# Local-only, NOT committed (per global CLAUDE.md):
.context/compound-engineering/todos/001-ready-p2-serve-anc-skill-from-endpoint.md   # status flip + work log
```

## Sources & References

- **Master plan:** `./2026-04-24-001-feat-skill-distribution-endpoint-plan.md` (Units 2–5)
- **Sibling skill plan (parallel session):**
  `~/dev/agentnative-skill/docs/plans/2026-04-27-001-bootstrap-agentnative-skill-plan.md`
- **Origin todo (local):** `.context/compound-engineering/todos/001-ready-p2-serve-anc-skill-from-endpoint.md`
- **Existing site code:**
- `src/worker/index.ts`, `src/worker/headers.ts`, `src/worker/accept.ts`
- `src/build/build.mjs`, `src/build/scorecards.mjs` (loadRegistry pattern), `src/build/render.mjs`,
  `src/build/sitemap.mjs`, `src/build/llms.mjs`
- `tests/regression.test.ts`, `tests/worker.test.ts`, `tests/e2e/agents.e2e.ts`
- **Solutions referenced (read before touching the corresponding code):**
- `docs/solutions/best-practices/cloudflare-workers-static-assets-custom-headers-2026-04-14.md`
- `docs/solutions/configuration-fixes/wrangler-placement-smart-wrong-for-static-asset-site-2026-04-14.md`
- `docs/solutions/best-practices/byte-equivalence-regression-tests-for-copied-design-artifacts-2026-04-14.md`
- `docs/solutions/architecture-patterns/cross-repo-artifact-sync-commit-over-fetch-20260420.md`
- **Session memory (auto-loaded):** `~/.claude/projects/-home-brett-dev-agentnative-site/memory/MEMORY.md` —
  particularly the dev-flow squash-merge, auto-squash-merge, no-soft-fail, CI env parity, and route-visual-via-skills
  entries.
- **Global rules:** `~/.claude/CLAUDE.md` — SHA pinning, secret handling, branch discipline, no AI attribution, dev /
  feature-branch flow, plans-on-dev exception, long-artifacts-go-to-files.
