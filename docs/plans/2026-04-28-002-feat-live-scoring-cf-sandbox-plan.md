---
title: "feat: Live scoring via Cloudflare Sandbox + Worker (v3 — install-binary only)"
type: feat
status: active
date: 2026-04-28
revised: 2026-05-04
origin: docs/brainstorms/live-scoring-spike.md
---

# feat: Live Scoring via Cloudflare Sandbox + Worker (v3)

> **REWRITE NOTE (2026-05-04).** This document replaces v2 (filed 2026-04-28). v2 was incorrectly framed against the
> 2026-04-17 CEO design's Premises #2 (no toolchains, install-from-binary only) and #4 (web shows summary + top-3,
> CTA is install-anc-locally). v2 carried Debian-trixie-slim glibc (~3.5-4.5 GB on `standard-1`), a GitHub clone +
> source-only fallback path, and a full-scorecard web rendering — none of which match the design. v3 returns to the
> design's Alpine + musl image (~100-300 MB on `basic`), drops the clone phase entirely (we install pre-built
> binaries; we never compile), restricts the web result to summary + top-3 issues with the install-anc-locally CTA
> as primary, and adds the input-parser unit that v2 never had. Show HN remains gated on this functionality.

---

## Summary

Ship the "paste a tool identifier → get an `anc` scorecard" surface that the Show HN launch positions as the viral hook.
Input is permissive (registry slug, parseable install command like `brew install ripgrep`, or a GitHub repo URL that
resolves through a 4-step binary-discovery chain to a downloadable pre-built binary). Web shows summary + top-3 issues
only — full source/project depth lives in `anc` running locally. The site's primary CTA is install-anc-locally; the live
scorer is the proof-of-life that gets shared. Registry-known inputs serve committed scorecards from disk with a
theatrical spinner (no sandbox spawn). Unknown inputs that resolve to an installable binary spawn an Alpine + musl
sandbox container, install via the appropriate package manager (apk / cargo binstall / pip wheel / npm / go install /
downloaded tarball), run `anc check --command <name> --output json`, write through to R2, return to the user. Anything
that doesn't resolve to an installable binary bounces out with the install-anc-locally CTA.

---

## Current state — 2026-05-14

### Shipped to dev (~50% to rollout)

- U1 — build-time `registry-index` + `discovery-hints-index` (PR
  [#78](https://github.com/brettdavies/agentnative-site/pull/78), commit `82b74dd`)
- U2 — Alpine + musl sandbox image source at `docker/sandbox/Dockerfile` (PR
  [#79](https://github.com/brettdavies/agentnative-site/pull/79), commit `bf14daf`)
- U3 — wrangler bindings live on staging AND production; DO is a stub returning `{error: 'sandbox_stub_until_u6'}` (PR
  [#81](https://github.com/brettdavies/agentnative-site/pull/81), commit `09fe91f`). Production-Worker side shipped
  2026-05-15 via release PR [#85](https://github.com/brettdavies/agentnative-site/pull/85) (merge SHA `e79b7ce`); DO
  migration v1 applied to the named-prod side on that deploy.
- U4 — input parser + GitHub URL discovery chain (PR [#80](https://github.com/brettdavies/agentnative-site/pull/80),
  commit `5ac59ca`)
- U3-followup — sandbox image migration off Docker Hub to the Cloudflare managed registry, with the default workflow
  reframed to staging-leads-prod (PR [#84](https://github.com/brettdavies/agentnative-site/pull/84), merged 2026-05-14).
  Staging container app `agentnative-site-staging-sandbox-staging` (id `a0309fd2-9622-4dd8-a6a8-faf95292f08e`) is live
  on `registry.cloudflare.com/<acct>/anc-sandbox:30f61f1`, version v2, 6/6 healthy. Production-Worker container app
  shipped 2026-05-15 via release PR [#85](https://github.com/brettdavies/agentnative-site/pull/85) on the same image pin
  (lockstep); CI main-targeting pin-equality guard exercised cleanly on PR #85's first run.
- discovery-hit-rate gate (PR [#77](https://github.com/brettdavies/agentnative-site/pull/77), commit `078d233`)

### Discovered post-U3 shipment (2026-05-14 audit)

Three findings surfaced during the U3-followup audit. The Docker Hub blocker is resolved; the other two are open.

**Docker Hub deprecation — RESOLVED via U3-followup (PR #84).** The `containers[].image` field used to pin
`docker.io/brettdavies/anc-sandbox@sha256:...`; the registry deprecation manifested as repeating `ImagePullError "the
image registry credentials are invalid"` on the staging container app. PR #84 ships local-build-once via `wrangler
containers build -p` and pins both env blocks to `registry.cloudflare.com/<acct>/anc-sandbox:<git-sha>`. Deploy never
rebuilds. GHA fallback via `cloudflare/wrangler-action@v3.14.1` stays available for the rare offline-Brett case
(~60-130s cold build per deploy; no GHA-side layer cache; push auto-skipped when the existing tag still matches).

**Routing drift — RESOLVED via release PR #85 (2026-05-15).** Release PR
[#85](https://github.com/brettdavies/agentnative-site/pull/85) (merge SHA `e79b7ce`) brought the named-production Worker
current with 11 dev-side PRs since #73 plus the docs/research cleanup commit, and `deploy.yml` created a fresh Custom
Domain binding for `anc.dev` against `agentnative-site` per the top-level `routes:` field. R2 bucket `anc-score-cache`
was created out-of-band beforehand. DO migration v1 (`new_sqlite_classes: ["Sandbox"]`) applied cleanly to the
named-prod side for the first time (one-way wall — production now cannot `wrangler rollback` across v1). Verified
post-deploy: `curl https://anc.dev/` returns 200 with no `x-robots-tag`; `curl
https://agentnative-site-staging.brettdavies.workers.dev/` returns 200 with `x-robots-tag: noindex`; CF API confirms one
record `hostname=anc.dev, service=agentnative-site, environment=production, enabled=true`. Surprise finding during
execution: the staging binding had already cleared between the prior session's audit and the start of the release
session (DELETE on the cited record id returned `Origin '8721a2ad...' not found`), so the planned mid-merge detach was a
no-op. CF derives custom-domain record ids deterministically from `(account, zone, hostname)`, so the new prod binding
reused the same id as the prior staging binding — the id in the audit was not stale, just reusable. Follow-ups: clean up
the orphan DO namespace on staging (`a4fb92ed020241cb802c1d5176a39608`) as a documented quarterly action, and PR
`docs/research/` into the `brettdavies/.github` reusable `guard-main-docs.yml` so that path is blocked from `main` like
`docs/plans/`/`docs/solutions/`/`docs/brainstorms/`/`docs/reviews/` already are.

**Default image workflow reframed — staging-leads-prod.** The original U3-followup spec said "pin both env blocks to the
same tag (shared-tag-pin)" with a rationale of "avoids the multi-env double-build". That rationale was a leftover from
the inline-Dockerfile-path pattern — under registry URIs, deploys never rebuild and the double-build penalty does not
exist. The two env blocks are independent CF resources (separate container apps, separate version histories) and can
legitimately diverge. PR #84 adopts staging-leads-prod as the default: new images bump `env.staging` only and soak on
the staging Worker, then a release PR to main promotes the top-level pin to match. The lockstep pattern remains
available as a shortcut for low-risk image bumps (base-image patches, dependency-only updates). CI guard in `ci.yml`
enforces this discipline per PR target: registry-existence is always checked on both pins; equality is enforced only
when `base_ref == main`.

### Pending (in execution order for the next session)

1. **U5** — Worker `/api/score` route + content negotiation + response shape + `spec-version.gen.ts`. Includes the
   `SCORE_LIMITER` rekey from per-IP to `session-cookie + tool-arg-hash` (see Cost ceiling and abuse mitigation
   section). Unblocks any user-facing wiring.
2. **U6** — replace DO stub with real `@cloudflare/sandbox`-extending DO; two-phase egress (`allowedInstall` then
   `noHttp`); `sandbox-exec.ts` orchestrator with per-PM install matrix and `anc check --command --output json`.
   Highest-risk single unit.
3. **U7** — R2 cache (read on hit, write on miss; key shape `scores/{slug}/{anc-v}/{tool-v}.json`).
4. **U8** — paste-input form on the homepage (`/`, NOT a dedicated `/score` subpage), Turnstile invisible mode +
   lazy-load on form interaction, CSP update for `challenges.cloudflare.com`, client-side polling, summary + top-3 +
   install-anc CTA, build-emitted `spec-version.gen.ts`. No markdown twin (live-scoring is HTML-only; agents have `anc
   check` locally). Result-presentation shape (inline / modal / shareable subpage) is an open U8 question.
5. **U9** — tests (mocked + opt-in live), monitoring runbook, RELEASES.md v3 procedure for live-scoring releases.

U7 and U8 can land in either order after U5 + U6. U9 is cross-cutting and should land alongside U6 / U8.

### Risks to design against during U5-U8

- **Cost ceiling has no native auto-cap on Cloudflare.** Per spike 04 (citing
  <https://developers.cloudflare.com/changelog/post/2026-04-13-billable-usage-dashboard-and-budget-alerts/>), the April
  2026 Budget Alerts + Billable Usage dashboard are email-only — there is no "Cloudflare disables your Worker when it
  crosses $X" primitive. Minimum viable defense for v3 launch (see Cost ceiling and abuse mitigation section below):
  Turnstile invisible mode + lazy-load on the homepage form, rekey `SCORE_LIMITER` from per-IP to `session-cookie +
  tool-arg-hash`, in-Worker KV `scoring_disabled` kill switch, and Cloudflare Budget Alert. A true hard daily cap (DO +
  alarm + cost-budget counter) is deferred to v3.1.
- **Abuse.** Anonymous + unauthenticated GitHub API path means the discovery chain hits `api.github.com` at the unauth
  60/hr/IP ceiling: IP exhaustion is shared across users. Consider a server-side GitHub PAT for discovery, or
  token-the-user.
- **Correctness.** Plan currently assumes `anc check --command <binary> --output json` matches local `anc check` output.
  PATH composition inside the container is also deferred. Specify both as part of U6 acceptance criteria.
- **Failure modes.** No `installSpec` for unsupported PMs (e.g., brew on Alpine): bounce-out is the design but the
  bounce-out UX isn't built. Sandbox cold-start, container crash, network timeout, two-phase egress misconfig are all
  unobservable today.
- **Rollback fragility (per spike 03).** Two new constraints land in the Risk Analysis section: (1) any DO migration
  permanently strands earlier versions from `wrangler rollback` (cite
  <https://developers.cloudflare.com/workers/configuration/versions-and-deployments/rollbacks/> Bindings section); (2)
  deleting a container image from the CF managed registry silently breaks rollback for any version that referenced it
  (cite <https://developers.cloudflare.com/containers/platform-details/limits/> footnote). Discipline: never delete
  shipped-version images, treat DO migrations as one-way walls.

### Branch baseline for next session

Continue from `dev` (post release PR [#85](https://github.com/brettdavies/agentnative-site/pull/85) merge, 2026-05-15).
`main` is now current with all post-#73 dev work and the production-side U3 + U3-followup deploy. The earlier
live-scoring feature branches (`feat/u1-build-indexes`, `feat/u2-sandbox-image`, `feat/u3-bindings`,
`feat/u4-input-parser`, `feat/discovery-hit-rate-gate`, `feat/u3-followup`) were squash-merged and have been deleted
locally; their content is on dev and main.

Next-session work begins with U5 (item 1 under Pending above). New feature branches off `dev`.

---

## Problem Frame

The agent-native standard is abstract without evidence. The `anc` linter is invisible without a public surface. The
viral loop is "user pastes their tool, gets a scorecard with the issues to fix, shares it" — SSL Labs for
agent-readiness. Without that surface, the Show HN post is "we wrote a standard and a CLI" with no demo. The leaderboard
of pre-scored tools is supporting evidence; the live scorer is what creates the share.

Today the Worker (`src/worker/index.ts`) is asset-only: every request proxies to `env.ASSETS` with one CN branch and one
header policy. There are no Containers, no Durable Objects, no R2, no `migrations` block. v3 introduces all four for the
first time on this Worker — a one-way migration that ships behind a stage-on-staging dry run.

See origin: [docs/brainstorms/live-scoring-spike.md](../brainstorms/live-scoring-spike.md). Cross-tracker: the
launch-readiness plan
([docs/plans/2026-04-28-001-feat-show-hn-launch-readiness-plan.md](2026-04-28-001-feat-show-hn-launch-readiness-plan.md))
explicitly defers live scoring to this plan; its CORRECTION block (2026-04-30 PM PT) names this surface as the launch
blocker.

### Why live scoring vs. leaderboard expansion as the launch hook

The leaderboard at `/scorecards` (96 tools scored, ready today) is a viable alternative launch artifact. It would ship
faster (no new infra, no cross-repo musl prerequisite) and creates engagement substrate for HN comments ("you ranked X
above Y, here's why that's wrong"). Live scoring is the chosen bet anyway. Why:

- **Interactive demo creates a moment.** The user types their tool, watches it get scored, sees "your CLI is 4/7
  agent-native, here are the 3 things to fix." That's a visceral discovery moment that a static leaderboard doesn't
  produce. The leaderboard is "we judged 96 tools"; live scoring is "we just judged YOURS." The latter is the share
  trigger.
- **The leaderboard is the supporting evidence, not the wedge.** A reader who sees a leaderboard asks "but does this
  actually mean something?" Live scoring against a tool they know answers that question by demonstration. The
  leaderboard becomes more credible AFTER they've seen the live scorer work, not before.
- **The bet is asymmetric.** If live scoring works, both the live demo + leaderboard compound (visitors paste, then
  browse the leaderboard for context). If live scoring fails, the leaderboard is still the durable artifact (no loss vs
  leaderboard-only launch). The downside of betting on live scoring is the build cost (this plan) + a delayed launch —
  both bounded.
- **SSL Labs analogy has limits.** SSL Labs works on a question every domain owner already wonders ("is my SSL setup
  secure?") with a known-norm baseline (A-F). Agent-readiness is a NEW standard the audience doesn't yet wonder about,
  and 4/7 doesn't map to a pre-existing reference frame. The plan accepts this limitation: the demo has to teach the
  standard AND show the score in one moment. That's a higher bar than SSL Labs faces, and v3's R9 (install-anc-locally
  CTA primary) is the framing tool that makes it work — the demo isn't the product, it's the doorway.

If discovery-chain hit-rate measurement (Pre-Implementation Validation, below) shows <50% resolution against HN-typical
inputs, this bet may need to flip to leaderboard-first. That's the explicit fallback.

---

## Requirements

- **R1. Permissive input.** `/score` form accepts (a) a registry slug (`ripgrep`); (b) a parseable install command
  (`brew install ripgrep`, `cargo install bird`, `bun add -g @anthropic-ai/claude-code`, `uv tool install datasette`,
  `pip install datasette`, `go install github.com/cli/cli/v2/cmd/gh@latest`, `npm install -g wrangler`); (c) a GitHub
  repo URL (`https://github.com/owner/repo`).
- **R2. Registry-known fast path (theater).** When the resolved tool name is in `registry.yaml` AND a fresh scorecard
  exists on disk (`scorecards/<name>-v<version>.json`), serve it inline with a 2 s minimum spinner. NO sandbox spawn.
- **R3. GitHub URL discovery chain.** For URL input not in registry, in order: (a) pasted URL is itself a binary asset
  (Content-Type or `.tar.gz`/`.tar.xz`/`.zip`/`.exe` suffix); (b) GitHub Releases API — most-recent-release asset whose
  name matches `<repo>` ± platform suffix; (c) common distribution lookup (brew formulae index, crates.io, npm registry,
  PyPI) by repo name; (d) README parse for the first fenced code block containing an install command whose package name
  matches the repo. If none resolve to an installable binary: bounce out with R9's CTA. Each step is bounded by a soft
  timeout (≤2 s/step, ≤8 s total) before falling through.
- **R4. Live sandbox path (unknown but installable).** Spawn the Alpine + musl sandbox; install via the appropriate
  package manager OR direct binary download; run `anc check --command <binary> --output json`; parse + return. Total
  budget 30-60 s including cold start.
- **R5. Memoization.** R2 cache on `scores/{tool-slug}/{anc-version}/{tool-version-or-sha7}.json`. Repeat live runs for
  the same triple return from R2 in sub-100 ms. Cache key includes `anc-version` so binary upgrades auto-invalidate.
- **R6. Rate limit.** Workers Rate Limiting binding gates the live sandbox path. Per-IP `simple: { limit: 10, period: 60
  }`. Registry-theater path is unmetered (static asset read). 429 responses include `Retry-After` and SSL-Labs-pattern
  `X-Max-Assessments` / `X-Current-Assessments` informational headers.
- **R7. Security.** (a) URL validation at the Worker boundary: HTTPS-only; for GitHub URL input, host allowlist of
  `github.com` / `api.github.com` / `raw.githubusercontent.com`; reject `http://`, `file://`, `ftp://`, RFC1918,
  link-local, IPv6 ULA, cloud-metadata IPs; ASCII-only host check (homoglyph SSRF). (b) Two-phase egress inside the
  sandbox via the SDK 0.9.x `outboundHandlers` mechanism. Phase 1: `setOutboundHandler("allowedInstall", {
  allowedHostnames: hosts })` — runs the inline `allowedInstall` async function (declared on the Sandbox DO class as a
  static `outboundHandlers` map), which checks `ctx.params.allowedHostnames` and either passes through via `fetch(req)`
  or returns 403. Phase 2: `setOutboundHandler("noHttp")` before `anc check` runs — runs the inline `noHttp` async
  function, which returns 403 for every request. Handlers are inline functions in the same Worker bundle, NOT separate
  sub-Workers (no service bindings needed in `wrangler.jsonc`). TLS interception is on by default per-instance (CF
  Sandbox SDK 0.9.x).
- **R8. No toolchains in the sandbox image.** `anc` is downloaded as a pre-built musl binary from
  `github.com/brettdavies/agentnative-cli/releases/...` at image build time. The image carries package managers (apk,
  cargo-binstall, pip, npm, go) but NOT compilers other than what apk's go package transitively ships (the Alpine `go`
  package is the full toolchain — Alpine doesn't split runtime/toolchain; see `go install` K-decision for the
  reconciliation). Tools that require source compilation MUST bounce out with R9's CTA.
- **R9. Install-anc-locally CTA is primary.** The web result is summary + top-3 issues + a one-line install command
  (`brew install agentnative` or `cargo install agentnative`) + a "run `anc check .` in your project" snippet. Full
  scorecard depth (source checks, project checks, all checks) lives in local `anc` only. The web is the demo, not the
  product.
- **R10. Agent-native content negotiation.** `/api/score` honors `Accept: text/markdown` (rendered scorecard markdown),
  `Accept: application/json` (default), `.md` / `.json` URL-suffix twins, mirroring `/skill` (`src/build/skill.mjs`).
  `.json`-suffix paths bypass the existing CN markdown rewrite per the triple-emit pattern.
- **R11. Response contract.** Every `/api/score` response includes `spec_version`, `anc_version`, `checker_url` (link to
  the running checker — `https://anc.dev/score`) per the SoT contract for spec-repo downstream consumers. Missing any of
  the three is a fail-fast 5xx, not a quiet omission.
- **R12. Cost ceiling (honest derivation).** Two cache layers exist; conflating them gives wrong cost numbers.
- **Registry fast-path hit ratio** (registry-known input → committed scorecard from `dist/` via `env.ASSETS`): high in
  steady-state (96 tools cover most "famous" CLIs), near-zero marginal cost (static asset reads). NOT R2.
- **R2 cache hit ratio for unknown-tool path** (live sandbox response cached on `(slug, anc-v, tool-v)`): structurally
  LOW during a viral spike (each pasted novel repo is a unique cache key; two strangers pasting the same novel repo
  within 24h is rare). Realistic assumption: <20% during HN-spike window, climbing to 60-80% in steady-state as the
  cache warms.
- **Steady-state ceiling** (mixed traffic, post-launch): ≤$10/mo at 50 unknown-tool runs/day; ≤$30/mo at 500/day. These
  hold under steady-state R2 hit ratio assumption.
- **HN-spike ceiling** (≈10k runs over 2-4 h, mostly unknown-tool path because viral readers paste their own tools, not
  registry tools): ≤$50 ONLY IF the singleton `basic` instance + per-IP rate limit (R6: 10/min/IP) actually caps sandbox
  throughput. Math: 1 instance × `basic` × 4 h × ~$0.0005/30s run × ~480 runs (60s avg/run) ≈ $2-5 raw container cost.
  The cap, NOT R2, is what holds the spike ceiling. R2 reduces post-spike repeat-view cost.
- **Spike-breach guard** (operational): if hourly Container vCPU-seconds exceed ceiling on day 1, set `max_instances: 0`
  to force registry-fast-path-only and 502 the sandbox path while preserving the leaderboard. Documented in monitoring
  runbook (U9). The cost ceiling is enforced by `max_instances` cap + a kill-switch, not by cache-hit assumptions that
  don't hold during launch.

---

## Scope Boundaries

- v3 covers tools installable from a pre-built binary path. Compilation-only tools (no published binary in any package
  manager AND no `cargo binstall` / Releases binary asset) bounce out with the install-anc-locally CTA.
- v3 does NOT clone repositories. Source/project checks are a local-`anc` capability, surfaced through R9's CTA.
- v3 does NOT replace the batch-scoring pipeline. The 96-tool leaderboard at `/scorecards` is still served from
  committed `scorecards/*.json`. v3 augments with on-demand scoring for not-yet-scored tools.
- v3 covers GitHub-hosted repos for URL input. Bitbucket, GitLab, self-hosted git → out of scope.
- v3 does NOT introduce GPU passthrough — Containers schema does not support it.
- v3 does NOT add an authenticated-user concept. No GitHub OAuth, no user accounts, no per-user history.

### Deferred to Follow-Up Work

- **Upstream PR: agentnative-cli adds `x86_64-unknown-linux-musl` target.** This plan blocks on it (see Dependencies &
  Prerequisites). Tracked as a separate plan in the agentnative-cli repo.
- **README parse via LLM.** v3 ships a deterministic regex/heuristic parser. LLM-based parsing (Workers AI or external)
  deferred to v3.1 if the heuristic miss-rate is too high in practice. Failure mode is the same as any discovery miss:
  bounce out with the install-anc-locally CTA — never a wrong answer, only a missed opportunity to show one.
- **Score-diff history per repo.** R2 keying by version/SHA already supports this; the query/render path is v3.1.
- **Non-GitHub providers (GitLab, Bitbucket, sourcehut).** Defer to v4 if there is demand signal.
- **Authenticated-user surfaces** (per-user score history, badges in user profiles).
- **`/skill/<name>` URL pattern parity** for `/score/<name>` — orthogonal feature, separate plan.
- **DO-based global rate limit counter** (Option B from the live-scoring research). v3 ships per-CF-location counters
  (Workers Rate Limiting binding); upgrade only if rotating-PoP abuse appears.

---

## Context & Research

### Relevant Code and Patterns

- **`src/worker/index.ts`** (~55 LOC) — asset-only with a CN branch and header post-processor. v3 adds a path-prefix
  branch above the asset call: `if (pathname.startsWith('/api/score')) return handleScore(...)`. The asset-first
  invariant for non-`/api/score` routes stays intact.
- **`src/worker/headers.ts`** — JSON branch already keys on `pathname.endsWith('.json')`. `/api/score.json` inherits
  CORS `*` + `noindex` + `application/json` + short cache for free. `/api/score` (no extension) needs an `/api/`-aware
  case in `isJson()` OR direct header setting in the score handler.
- **`src/worker/accept.ts`** — RFC-9110 q-value content negotiation via the `accepts` package. Reuse verbatim for
  `/api/score.md`. Preference list extends from `['text/html', 'text/markdown']` to `['text/html', 'application/json',
  'text/markdown']` for the live endpoint.
- **`src/build/build.mjs:236-263`** — `subPages` array (the loop near `check`/`install`/`about`/`badge`/`changelog`/
  `methodology`/`scorecard-schema`). The new `/score` form HTML page slots here as a custom-body entry (form-driven, not
  pure markdown). Client JS injection follows the `extraScripts` pattern at `build.mjs:280` (leaderboard).
- **`src/build/skill.mjs` + `src/data/skill.json`** — the canonical "single-source data → emits HTML + MD twin +
  canonical JSON" precedent. (Note: `src/build/install.mjs` does NOT exist — `/install` is a plain content sub-page from
  `content/install.md`. The skill module is the right model to mirror.)
- **`src/build/scorecards-render.mjs:buildScorecardBody`** — current renderer composes header + score badge + audience
  banner + `<section class="scorecard-checks">` (full check tables) + `<section class="scorecard-meta">`. v3 needs a new
  `buildScoreSummaryBody(scorecard, topIssues)` that reuses the header/score/issues blocks and SKIPS the
  scorecard-checks and scorecard-meta sections. The "top 3 issues" projection already exists as
  `extractTopIssues(scorecard, limit=3)` in `src/build/scorecards.mjs:431` — reuse, don't reinvent.
- **`registry.yaml` + `src/build/scorecards.mjs:loadRegistry()`** — per-tool fields: `name` (slug), `binary`,
  `language`, `tier`, `creator`, `install` (free-text install command), `description`, plus one of `repo` or `url`,
  optional `audit_profile`, `version_extract`. Build-time emission of `dist/registry-index.json` (mapping `owner/repo`
  AND tool slug → entry) lets the Worker do an O(1) lookup without parsing YAML at request time. The `install` field is
  currently free-text; v3 must parse it (or add an `install_kind: brew|cargo-binstall|bun|uv|pip|go|none` structured
  field — TBD in U1).
- **`tests/worker.test.ts:26 makeEnv`** — stub-env testing pattern. Reusable for stubbing `env.SCORE` (DO),
  `env.SCORE_CACHE` (R2), `env.SCORE_LIMITER` (Rate Limit binding) without `wrangler dev`.
- **`scripts/hooks/pre-push`** — runs `bun run lint` → `bun run build` → `bun test` → `bun x wrangler deploy --dry-run`.
  v3's `wrangler.jsonc` additions (containers, durable_objects, migrations, r2_buckets, ratelimits) must bundle cleanly
  even when class implementations are still stubs.

### Institutional Learnings

-

[docs/solutions/architecture-patterns/cf-sandbox-secure-cli-execution-2026-04-17.md](../solutions/architecture-patterns/cf-sandbox-secure-cli-execution-2026-04-17.md)
— THE foundational v3 doc. Alpine + musl, ~100-200 MB, `basic` instance, install via apk / cargo binstall / pip wheel /
npm. The doc's "never toolchains" framing was relaxed during U2 (Alpine's `go` package ships the full toolchain — see
`go install` K-decision reconciliation). Two-phase egress (`allowedInstall` → `noHttp`) — both are user-defined inline
async functions on the Sandbox DO class's static `outboundHandlers` map per SDK 0.9.x (NOT separate Workers — the
earlier "SubWorker" framing was wrong). Image now ships `cloudflare/sandbox:0.9.2-musl` SHA-pinned; the `libstdc++` copy
was empirically confirmed redundant 2026-05-05 (apk's `libstdc++-14.2.0-r4` provides it transitively). -
[docs/solutions/architecture-patterns/cached-theater-live-fallback-2026-04-17.md](../solutions/architecture-patterns/cached-theater-live-fallback-2026-04-17.md)
— registry-known = theater (cached JSON + cosmetic 2-3 s spinner) is the source of v3's R2 framing, not v3's invention.
Two-path split: known → static, unknown → container, R2-cached on `(input, version)`. 95%+ cached = ~$0; 90/10 = ~$2/mo;
50/50 = ~$25/mo. -
[docs/solutions/best-practices/cloudflare-workers-static-assets-custom-headers-2026-04-14.md](../solutions/best-practices/cloudflare-workers-static-assets-custom-headers-2026-04-14.md)
— headers must live in Worker code, not `_headers`. Already enforced. v3 sets live-response headers inline
(`Cache-Control: no-store` for live, `public, max-age=300` for cached, plus `application/json` + CORS). -
[docs/solutions/best-practices/account-id-out-of-public-repo-2026-04-14.md](../solutions/best-practices/account-id-out-of-public-repo-2026-04-14.md)
— `account_id` stays out of `wrangler.jsonc`. Already enforced; v3 does not change this. -
[docs/solutions/developer-experience/cloudflare-api-token-headless-wrangler-1password-2026-04-13.md](../solutions/developer-experience/cloudflare-api-token-headless-wrangler-1password-2026-04-13.md)
— mint a v3-scoped CF token: `Workers Scripts: Write` + `Containers: Write` + `Durable Objects: Write` + `R2 Storage:
Write`. -
[docs/solutions/best-practices/versioned-scorecard-filenames-and-non-github-registry-2026-04-20.md](../solutions/best-practices/versioned-scorecard-filenames-and-non-github-registry-2026-04-20.md)
— R2 key includes `anc-version`. An `anc` upgrade auto-invalidates without manual purging. Refuse to cache if
`target_version` or `anc_version` is missing. -
[docs/solutions/best-practices/sot-contract-for-spec-repos-with-downstream-consumers-2026-04-22.md](../solutions/best-practices/sot-contract-for-spec-repos-with-downstream-consumers-2026-04-22.md)
— every live `/api/score` response MUST include `spec_version`, `anc_version`, `checker_url`. R11 in this plan; enforced
via regression test, not code review. -
[docs/solutions/best-practices/agentnative-version-model-2026-05-01.md](../solutions/best-practices/agentnative-version-model-2026-05-01.md)
— six version concepts across four repos. Live response uses `scorecard.spec_version` (the version `anc` was compiled
against at score time), NOT `SPEC_VERSION` (vendored snapshot) and NOT `SITE_SPEC_VERSION` (footer reconciliation). Read
`anc_version` from the running binary at exec time; never from a constant. -
[docs/solutions/best-practices/triple-emit-content-negotiation-rename-safe-2026-04-29.md](../solutions/best-practices/triple-emit-content-negotiation-rename-safe-2026-04-29.md)
— `.json` paths bypass the Accept-header MD rewrite. Live response stays JSON unconditionally; an `Accept:
text/markdown` request against `/api/score.json` returns JSON, not a non-existent `.json.md` twin. Flags that v3 departs
from this Worker's prior "no R2/DO/KV bindings" rename-cheap posture — a deliberate trade-off documented in K-decisions
below. -
[docs/solutions/best-practices/cross-repo-artifact-consumption-static-sites-2026-04-21.md](../solutions/best-practices/cross-repo-artifact-consumption-static-sites-2026-04-21.md)
— network-free builds. v3 does not build-time fetch from sibling repos; vendor any cross-repo data into `src/data/`.
Feature-detect optional fields on consumer side for graceful degradation. -
[docs/solutions/logic-errors/accept-header-q-value-parsing-content-negotiation-2026-04-14.md](../solutions/logic-errors/accept-header-q-value-parsing-content-negotiation-2026-04-14.md)
— use the `accepts` package for `/api/score.md`. Preference list extends to include `application/json`. Existing 27 CN
tests in `tests/worker.test.ts` extend, don't rewrite. -
[docs/solutions/best-practices/rust-url-validation-https-only-with-localhost-exception-2026-04-20.md](../solutions/best-practices/rust-url-validation-https-only-with-localhost-exception-2026-04-20.md)
— validate URL input at the Worker boundary. HTTPS-only, host allowlist (`github.com` and friends for URL input),
RFC1918 + link-local + cloud-metadata + IPv6 ULA reject. ASCII-only host (homoglyph SSRF). DROP the loopback exception
in production. Sandbox `setOutboundHandler` is defense-in-depth, not the primary check. -
[docs/solutions/architecture-patterns/anc-cli-output-envelope-pattern-2026-04-29.md](../solutions/architecture-patterns/anc-cli-output-envelope-pattern-2026-04-29.md)
— the `anc --output json` envelope shape the container's stdout produces. Worker passes through verbatim, only adding
`checker_url` and confirming `spec_version`/`anc_version` are present (5xx if not — fail fast, don't fabricate). -
[docs/solutions/build-errors/rustup-target-add-pinned-toolchain-2026-04-16.md](../solutions/build-errors/rustup-target-add-pinned-toolchain-2026-04-16.md)
— `dtolnay/rust-toolchain` action does not auto-install matrix targets after `rust-toolchain.toml` pin. The upstream
agentnative-cli PR adding `x86_64-unknown-linux-musl` MUST add `rustup target add x86_64-unknown-linux-musl` as an
explicit step in `release.yml`. Surfaced as a constraint on the prerequisite PR, not on this plan's units. -
[docs/solutions/best-practices/workflow-dispatch-on-deploy-for-recovery-2026-04-14.md](../solutions/best-practices/workflow-dispatch-on-deploy-for-recovery-2026-04-14.md)
— `deploy.yml` must include `workflow_dispatch` with `ref` input. Already present; verify v3 deploys still honor it
after the Container build step is added.

### External References

- [Cloudflare Sandbox SDK overview](https://developers.cloudflare.com/sandbox/)
- [Sandbox configuration (Wrangler)](https://developers.cloudflare.com/sandbox/configuration/wrangler/)
- [Sandbox Dockerfile reference](https://developers.cloudflare.com/sandbox/configuration/dockerfile/)
- [Outbound traffic guide](https://developers.cloudflare.com/sandbox/guides/outbound-traffic/)
- [Containers pricing](https://developers.cloudflare.com/containers/pricing/)
- [Containers limits + instance types](https://developers.cloudflare.com/containers/platform-details/limits/)
- [Container class lifecycle](https://developers.cloudflare.com/containers/container-class/)
- [R2 pricing](https://developers.cloudflare.com/r2/pricing/)
- [Workers Rate Limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
-

[2026-04-13 Sandbox GA + outbound + TLS changelog](https://developers.cloudflare.com/changelog/post/2026-04-13-sandbox-outbound-workers-tls-auth/)

- [2026-03-26 Outbound Workers changelog](https://developers.cloudflare.com/changelog/post/2026-03-26-outbound-workers/)
- [Container image management](https://developers.cloudflare.com/containers/platform-details/image-management/) — CF
  managed registry, inline build via `image: "./Dockerfile"`, `wrangler containers push` for CI workflows
- [2025-11-21 active-CPU pricing](https://developers.cloudflare.com/changelog/post/2025-11-21-new-cpu-pricing/)
- [GitHub REST API — Releases](https://docs.github.com/en/rest/releases/releases)
- [Homebrew formulae JSON API](https://formulae.brew.sh/docs/api/)
- [crates.io API](https://crates.io/data-access)
- [npm registry API](https://github.com/npm/registry)
- [PyPI JSON API](https://warehouse.pypa.io/api-reference/json.html)
- [SSL Labs Terms — assessment headers + cool-off pattern](https://www.ssllabs.com/about/terms.html)
- Internal research synthesis:
  [docs/research/2026-04-28-cloudflare-live-scoring-v2.md](../research/2026-04-28-cloudflare-live-scoring-v2.md)
  (sections §1-3, §5, §7-9 still load-bearing; §4 base-image and §10 `cf` CLI investigation superseded)
- CEO design (outside repo): `~/.gstack/projects/brettdavies-agentnative-site/brett-dev-design-20260417-145305.md`
  Premises #1, #2, #3, #4, #6 are this plan's locked framing.

---

## Key Technical Decisions

- **Image base: Alpine + musl, 221 MB compressed (measured 2026-05-05), `basic` instance type pool of 3.** Restores
  design Premise #2 + #6. Reverses v2's silent re-glibc to Debian-trixie-slim. The earlier "100-300 MB" estimate was
  optimistic-correct (P1 backlog "likely 400-600 MB" was overestimated and is now resolved). Cost ceiling re-derived
  against current pricing (see DO+Containers pairing K-decision below for the awake-idle correction): ~$0.25-0.75/day
  active during HN spike with rate-limit; up to ~$21/mo passive when 3 instances are awake-idle (memory + disk billed)
  and ~$0 when sleeping. The 8 GB-disk `standard-1` premise that v2 carried is wrong for this workload.
- **`anc` binary: pre-built musl bottle, downloaded at image build time from the upstream `x86_64-unknown-linux-musl`
  release artifact.** Hard prerequisite (see Dependencies & Prerequisites). The Dockerfile's anc-install layer pins to a
  SHA-resolved release URL, never a moving tag. We do NOT compile `anc` inside our pipeline — keeps single source of
  truth at agentnative-cli.
- **Sandbox SDK pin: `@cloudflare/sandbox@0.9.x`, musl variant tag (`:0.9.x-musl`).** Shipped Dockerfile pins
  `cloudflare/sandbox:0.9.2-musl@sha256:b4cb1d69…` (digest, not tag — bump procedure documented in
  `docker/sandbox/README.md`). Mirror the SDK npm version EXACTLY in the worker bundle's `@cloudflare/sandbox`
  dependency — the SDK warns on mismatch. Note: the `0.9.2-musl` tag exists on Docker Hub but is NOT documented on CF's
  Sandbox Dockerfile-reference page; an undocumented variant could be deprecated without notice — capture as a Risk row.
  **`libstdc++.so.6` resolved (2026-05-05):** apk's `libstdc++-14.2.0-r4` (transitive dep of `nodejs`/`go`) provides it
  on Alpine 3.21; the explicit `COPY --from=sandbox-base /usr/lib/libstdc++.so.6` at Dockerfile line 47 is redundant and
  can be dropped (saves ~2.79 MB uncompressed; verified by building a no-stdcxx variant and resolving `ldd /sandbox`
  cleanly).
- **DO + Containers pairing: SQLite-backed DO (`new_sqlite_classes`).** Mandatory for Container DOs; key-value backend
  not supported. Worker version rollback is constrained: `wrangler rollback` only works among versions on the SAME side
  of a DO migration boundary. Once migration v1 (`new_sqlite_classes: ["Sandbox"]`) ships, you can roll back to any
  post-v1 version but NOT to a pre-v1 version. Cross-migration rollback requires a follow-up migration with
  `deleted_classes`, which is the documented recipe in the runbook. **Pool of 3 instances** via `getRandom(env.SCORE,
  3)` (NOT a singleton). Local measurement (2026-05-05, dev hardware): ripgrep install + score = 3 s total (cargo-
  binstall 3 s, anc check <1 s). On CF Containers `basic` (1/4 vCPU, network egress different from local) project
  conservative ~5x slowdown → ~15 s per request, so per-instance throughput is ~4 req/min sustained, 3 instances yield
  ~12 req/min sustained. The earlier estimate of "1-2 req/min per instance, 10-30 s install, 5-15 s score" was
  pessimistic. Larger packages (npm with many deps, pip with no wheel) will trend slower; rerun the measurement on CF
  `basic` during U6 with at least one cargo-binstall, one pip-wheel, and one npm tool to validate before shipping. Cost
  framing (corrected 2026-05-05 against current Containers pricing): a `basic` instance has TWO idle states —
  **sleeping** (~$0.50/mo each, only storage billed) and **awake-idle** (~$7/mo each, memory + disk both billed while
  warm). The 3-instance pool's idle cost ranges from ~$0 (all asleep) to ~$21/mo (all awake-idle). The earlier "$22/mo
  absolute worst case" framing happens to match all-awake-idle, NOT "24/7 awake under load" — clarify in RELEASES.md
  cost notes. Active CPU is the dominant line item under load and is capped by `SCORE_LIMITER`.
- **R2 cache key: `scores/{tool-slug}/{anc-version}/{tool-version-or-sha7}.json`.** Includes `anc-version` per the
  versioned-scorecard pattern so `anc` upgrades auto-invalidate. Refuse to cache (and refuse to read from cache) if
  `anc_version` or `tool_version` is missing — fail-fast, no half-state.
- **Two-phase egress (non-negotiable per R7) — Pattern Y: named handlers with per-request logging.** `noHttp` and
  `allowedInstall` are USER-DEFINED handler names declared as INLINE async functions on the Sandbox DO class's static
  `outboundHandlers` map (per https://developers.cloudflare.com/sandbox/guides/outbound-traffic/) — NOT separate
  Workers, NOT service bindings. They run in the Workers runtime alongside the DO, in the same bundle. Per-request
  egress logging is the reason for choosing Y over the simpler `setAllowedHosts([])` primitive (Pattern X): handlers see
  the URL/headers of each outbound request, so attempted-but-blocked egress is observable as security signal. Decided
  2026-05-05.

  ```ts
  export class Sandbox extends BaseSandbox {}
  Sandbox.outboundHandlers = {
    allowedInstall: async (req, env, ctx) => {
      const url = new URL(req.url);
      console.log({ phase: "install", host: url.hostname, allowed: ctx.params.allowedHostnames.includes(url.hostname) });
      if (ctx.params.allowedHostnames.includes(url.hostname)) return fetch(req);
      return new Response(null, { status: 403 });
    },
    noHttp: async (req) => {
      console.log({ phase: "noHttp", host: new URL(req.url).hostname, blocked: true });
      return new Response(null, { status: 403 });
    },
  };
  ```

  Per-request invocation in `sandbox-exec.ts`:

  ```ts
  await sandbox.setOutboundHandler("allowedInstall", { allowedHostnames: hosts });
  await sandbox.exec(installCmd);
  await sandbox.setOutboundHandler("noHttp");
  await sandbox.exec("anc check ...");
  ```

  Install hosts are whichever the resolver picked (`formulae.brew.sh`, `crates.io` + `static.crates.io`,
  `registry.npmjs.org`, `pypi.org` + `files.pythonhosted.org`, `proxy.golang.org`, or `github.com` for direct binary
  downloads). TLS interception is on by default; no explicit configuration needed.
- **Per-package-manager script-execution audit (security baseline).** Phase 1 egress is open to install hosts; any
  install-time code execution during Phase 1 inherits that egress. Audit per package manager so no install path silently
  grants arbitrary egress to attacker-controlled code:
- **`npm install -g`:** runs `preinstall`/`install`/`postinstall` scripts from `package.json`. **MUST pass
  `--ignore-scripts`** (applied in U6 install table). Edge case: legitimate packages whose binary is produced by a
  postinstall fail to install correctly → bounce out with R9 CTA. Acceptable.
- **`pip install`:** running `setup.py` from sdist executes arbitrary Python. **MUST pass `--only-binary=:all:`**
  (applied in U6 install table) so only wheels are accepted. sdist-only packages bounce out.
- **`cargo binstall`:** by design, no script hooks — downloads pre-built binary asset only. Safe. (Note: `cargo install`
  WOULD compile from source AND run build scripts; we explicitly do not invoke `cargo install`.)
- **`apk add` (Alpine):** signed packages from `dl-cdn.alpinelinux.org`; standard packages do not run install scripts.
  Safe.
- **`bun add -g` / `bun install -g`:** runs lifecycle scripts by default (Bun mirrors npm semantics). **MUST pass
  `--ignore-scripts`** when invoking from sandbox. Update U6 install table accordingly.
- **`uv tool install`:** uv installs Python packages into isolated venvs; wheels are preferred and sdist execution
  requires explicit opt-in. Default behavior is safe; document the implicit assumption.
- **`go install`:** downloads source and compiles. **Reconciled with shipped reality (2026-05-05):** Dockerfile line 67
  ships `apk add go`, which is the FULL Alpine Go toolchain (Alpine doesn't split runtime/toolchain), so `go install
  <module>@latest` WILL succeed by compiling the module from source inside the sandbox. **Re-evaluation 2026-05-18 (U6
  blocker-resolution session) — DECIDED: keep `go` in the image.** Original framing was overstated. `gc` parses,
  type-checks, and emits machine code — it does NOT execute user code at compile time (unlike `pip` sdist `setup.py` or
  Rust `build.rs`). Phase 1 egress to `proxy.golang.org` lets attacker source pull arbitrary transitive Go modules, but
  those deps are also Go source, also compiled, also not executed at compile time. The first attacker-controlled
  execution surface is the produced binary running under `anc check --command <binary>`, which runs under Phase 2
  (`noHttp`, 60 s combined `install + score` timeout) — same trust boundary as `cargo binstall` / `pip --only-binary` /
  `direct`. Compile-cost attack vector (deep dep tree, pathological generics) is bounded by the same 60 s timeout.
  Outcome: net blast radius for `go install` is not materially worse than other PMs in the table; the only meaningful
  cost was the original framing's overstatement. ~50 MB compressed image savings from dropping `go` was real but not
  worth the live-scoring coverage loss. Three options were enumerated during re-eval: (a) keep `go` in the image (CHOSEN
  — accept the bounded risks, full Go-tool coverage); (b) drop `go` from the apk install line and bounce `pm=go` at
  `chain_resolved_install_failed`; (c) keep the toolchain but front `go install` with a Worker-side reject (parser
  admits for classification, install table refuses to invoke). If a future security incident or a CF SDK change
  invalidates the bounded-blast-radius reasoning above, option (b) or (c) remains a one-line revert.
- **`brew install`:** brew runs install + post-install scripts during formula installation. Scripts execute with Phase 1
  egress. **Mitigated by dropping brew from the sandbox image entirely** (per Finding F3, Linuxbrew requires glibc and
  is not viable on Alpine/musl). Brew-only tools bounce out with R9 CTA. The install-table entry for `brew install
  <pkg>` is therefore parser-only (input classification); execution path returns `install_unsupported` → bounce out.
- **Direct binary download (`curl -fsSL <url> | tar xz`):** the binary itself is attacker-controlled artifact. Sandbox
  isolates execution but Phase 1 egress is open during download. SHA verification is NOT required at this point (we
  don't have a known-good SHA for arbitrary user-pasted binaries) — the trust boundary is "user opts in by pasting a URL
  pointing at this binary." See related concern in adversarial F9 (binary discovery first-match without signing) —
  separate finding.
  
  This audit IS the security baseline for the sandbox install layer. Any new package manager added to the image must
  go through this audit and have its decision documented here.
- **No GitHub authentication.** v3 only scores public targets. We do not clone (so we don't hit `git` rate limits); we
  do API-call to `api.github.com/repos/<owner>/<repo>/releases/latest` (60 req/hr/IP unauthenticated, pooled across CF
  egress IPs — meaningful but acceptable given R6 rate-limits us to ~14k requests/day even at 100% miss). Add a GitHub
  App token via Outbound Worker only if anonymous limits actually bite in production. v2's Outbound-Worker-with-token
  apparatus is dropped from v3.
- **Rate limit primitive: Workers Rate Limiting binding (Option A).** Built-in, no DO scaffold. Per-CF-location counters
  (acceptable for abuse protection). Initial config: `simple: { limit: 10, period: 60 }` per IP. Upgrade to DO-based
  global counter (Option B) only if rotating-PoP abuse appears.
- **Web result: summary + top-3 issues only.** New `buildScoreSummaryBody(scorecard, topIssues)` renderer reusing
  `extractTopIssues` (already in `src/build/scorecards.mjs:431`). Skips `scorecard-checks` and `scorecard-meta`
  sections. Primary CTA renders as the prominent action: "Run `anc check .` in your project for source + project depth."
  Secondary footer: "Install `anc`: `brew install agentnative` or `cargo install agentnative`."
- **Headers in Worker code, not `_headers`.** Live JSON: `Cache-Control: no-store`. Cache-hit JSON: `public,
  max-age=300`. Both: `Access-Control-Allow-Origin: *`, `X-Robots-Tag: noindex`, `application/json; charset=utf-8`.
- **URL validation at Worker boundary.** Centralize in `src/worker/score/validate.ts` — one function per input kind
  (registry slug, install command, GitHub URL). HTTPS-only for URLs. Host allowlist (`github.com`, `api.github.com`,
  `raw.githubusercontent.com`). Reject RFC1918, link-local, cloud-metadata (`169.254.169.254/32`), IPv6 ULA
  (`fc00::/7`), localhost. ASCII-only host check.
- **Discovery-chain redirect handling: manual + revalidate (mandatory).** CF Workers `fetch()` follows redirects by
  default. The discovery chain derives fetch targets from user-pasted input AND from third-party API responses (GitHub
  Releases `asset.browser_download_url`, registry endpoint redirects). An attacker influencing any 3xx Location header
  could point our Worker fetch at an RFC1918 address or `169.254.169.254`, bypassing R7's allowlist (which only
  validated the original URL). Policy:
- Every discovery fetch passes `{ redirect: "manual" }`.
- On 3xx response, the Location header is parsed and revalidated against the SAME SSRF rules (HTTPS-only, appropriate
  host allowlist for the call, RFC1918 + link-local + IPv6 ULA + cloud-metadata reject, ASCII-only host check).
- If revalidation passes, the Worker manually issues the next fetch with the same `redirect: "manual"` policy.
- Redirect chain depth is capped at 3 hops; further redirects fail with `discovery_redirect_loop`.
- Sandbox-side install fetches (`cargo binstall`, `pip install`, `npm install`, `apk add`, `curl -L`) follow each tool's
  default redirect handling. The sandbox is the blast-radius limiter; the Worker is the SSRF gatekeeper. The
  architectural line: Worker enforces SSRF, sandbox enforces egress (two-phase egress, `noHttp` before `anc check`).
- Test scenario added to U5 (response-shape) and U4 (discover-binary): "Worker rejects discovery fetch that redirects to
  an RFC1918 address with a documented error code, never follows."
- **Container image registry: Cloudflare managed registry via inline build (Way 1).** `image:
  "./docker/sandbox/Dockerfile"` in `wrangler.jsonc` — `wrangler deploy` builds the image and pushes to
  `registry.cloudflare.com` (R2-backed, account-scoped) using the existing `CF_API_TOKEN`. No Docker Hub credentials, no
  Docker Hub pull-rate-limit exposure at sandbox cold-start. The account ID stays out of `wrangler.jsonc` (per
  `account-id-out-of-public-repo-2026-04-14`) because wrangler resolves it from auth at deploy time, not from a literal
  URI in config. Image immutability shifts from a `@sha256:` literal in config to a Worker-version-bound image push;
  rollback strategy is constrained by DO migrations (see Risk Analysis row "DO migration blocks `wrangler rollback`").
  CI caching strategy is pending empirical validation: `cloudflare/wrangler-action`'s docker invocation isn't publicly
  documented, so it's unknown whether it honors a buildx layer cache (`docker/setup-buildx-action` + `cache-from/to:
  type=gha`) or only plain `docker build`. U3 includes a sub-task to measure first-deploy and warm-rebuild times and
  pick the matching cache backend. Worst case (no cache): every deploy pays the full image build (~5-8 min on
  first-ever; faster on subsequent if Docker daemon layer cache survives between runs); best case (layer cache hits):
  site-only deploys pay ~30-60 s for cache validation, image-source-changed deploys ~2-4 min for partial rebuild + push.
  The decoupled-workflow alternative (separate image-build pipeline pushing to CF registry, deploy referencing
  `registry.cloudflare.com/<account-id>/...:<tag>`) was rejected because the literal account ID in `wrangler.jsonc`
  violates the existing rule; the templated-config workaround (Way 2) is deferred as YAGNI until measured wall-clock
  cost actually bites.
- **Registry-index emission at build time.** `src/build/registry-index.mjs` emits `dist/registry-index.json`. Includes
  BOTH a tool-slug index (`{ "ripgrep": { ... } }`) and a `owner/repo` index (`{ "BurntSushi/ripgrep": { ... } }`) so
  the Worker can do an O(1) lookup whether the input was a slug or a URL. `audit_profile` is included so the live path
  can pass it to `anc check --audit-profile <category>`.
- **`spec_version` in responses: build-time injection.** The Worker bundle has no filesystem access. Build emits
  `src/worker/spec-version.gen.ts` exporting `SPEC_VERSION` (read from `src/data/spec/VERSION`) and `SITE_SPEC_VERSION`
  (read from `content/principles/VERSION`). The Worker imports these at module load and surfaces them in responses.
  Cached responses use the `spec_version` from the cached scorecard payload, NOT the build-time constant — matches the
  agentnative-version-model precedent.
- **`anc_version` in responses: read from the running binary at exec time.** For live responses, capture from `anc
  --version` stdout in the sandbox; persist into the cache payload. For cached responses, read from the payload. Never
  from a build-time constant.
- **`checker_url` in responses: hard-coded to `https://anc.dev/score`.** That IS the running checker. R11 is satisfied;
  if anc.dev domain ever moves, this string updates with it.

---

## Open Questions

### Resolved by U3-followup spike (2026-05-14)

These were P0/P1 open questions before the four-subagent spike on 2026-05-14. The spike outputs (Q1-Q4) and the
follow-up Q1 + Q4.1 + Q4.2 user clarifications resolved them; the answers are now woven into the plan body. The spike
files have been deleted; this plan is the source of truth.

- **Q1 — Container deploy semantics for the inline Dockerfile.** Resolved by spike 01 (citing
  <https://developers.cloudflare.com/containers/platform-details/image-management/>,
  <https://developers.cloudflare.com/workers/wrangler/configuration/#containers>,
  <https://developers.cloudflare.com/workers/wrangler/commands/containers/>). `wrangler deploy` builds locally via
  `docker build` (NOT Cloudflare-side); destination is `registry.cloudflare.com/<acct>/<image>:<tag>` authenticated via
  `CF_API_TOKEN`; build context defaults to the Dockerfile's parent directory; `containers` is non-inheritable per-env.
  Final shape per Q1 follow-up: build locally with `wrangler containers build -p -t <git-sha>`, then pin both env blocks
  at the resulting tag and deploy with no rebuild. See U3-followup spec body for the complete procedure +
  experimental-verification list.
- **Q2 — wrangler-action + container build cache.** Resolved by spike 02 (sources include the
  `cloudflare/wrangler-action` src trace + `cloudflare/workers-sdk` packages/containers-shared/src/build.ts). wrangler
  shells out to plain `docker build` with no `--cache-from/--cache-to` flags; layering `docker/setup-buildx-action` +
  `actions/cache` does NOT help because wrangler doesn't consume the cache they would populate. GHA cold builds are
  ~60-130s on `ubuntu-latest`; push-side dedup IS automatic (`"Image already exists remotely, skipping push"` log line
  is the canary). "Measure before optimizing" applies; current decision is no caching wiring on the GHA fallback path.
- **Q3 — Rollback recipe + image versioning.** Resolved by spike 03 (citing
  <https://developers.cloudflare.com/workers/configuration/versions-and-deployments/rollbacks/>,
  <https://developers.cloudflare.com/containers/platform-details/limits/>,
  <https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/>). Two hard constraints
  documented as new Risk Analysis rows: (1) DO migrations are one-way walls — `wrangler rollback` cannot cross them; (2)
  deleting a container image silently breaks rollback for any version that referenced it. Image-retention discipline
  (never delete shipped-version images; quarterly manual prune review) added to U3-followup + RELEASES.md guidance.
- **Q4 — Cost ceiling and abuse mitigation.** Resolved by spike 04 (citing
  <https://developers.cloudflare.com/changelog/post/2026-04-13-billable-usage-dashboard-and-budget-alerts/>,
  <https://developers.cloudflare.com/turnstile/>,
  <https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/>). No native auto hard-cap exists; Budget
  Alerts are email-only; the Workers ratelimit binding is per-POP. The "Cost ceiling and abuse mitigation" section
  codifies the four-step MVP defense (Turnstile invisible mode + lazy-load on the homepage form, rekey `SCORE_LIMITER`
  from per-IP to `session-cookie + tool-arg-hash`, in-Worker KV `scoring_disabled` kill switch, Cloudflare Budget
  Alert). True hard daily cap (DO + alarm + cost-budget counter) deferred to v3.1.

### Resolved During Planning

- **Image base (Alpine vs Debian):** Alpine + musl per design. Reversal of v2's silent re-glibc.
- **anc binary acquisition (compile-in-place vs upstream musl release):** Upstream first, block on it (see Dependencies
  & Prerequisites). Cleanest pipeline; one canonical source.
- **GitHub authentication (App token via Outbound Worker vs unauthenticated):** Unauthenticated for v3. Public targets
  only; no clone phase; only API calls hit `api.github.com` (60 req/hr/IP anonymous). Reconsider only if anonymous
  limits bite in production.
- **Rate limit primitive (binding vs DO):** Workers Rate Limiting binding for v3. Upgrade later if needed.
- **R2 cache key shape:** `scores/{tool-slug}/{anc-version}/{tool-version-or-sha7}.json`. Includes `anc-version`.
- **Container image registry:** Cloudflare managed registry. The original "inline build during `wrangler deploy`" shape
  was superseded post-shipment by the U3-followup local-build-once + shared-tag-pin pattern (resolved by spike 01,
  2026-05-14): build locally with `wrangler containers build -p -t <git-sha>`, pin both env blocks at the resulting
  `registry.cloudflare.com/<acct>/anc-sandbox:<git-sha>` URI, deploy with no rebuild. Decouples build from deploy,
  preserves SHA-pinning ergonomic, avoids the multi-env double-build that arises from `containers` being a
  non-inheritable binding. The literal account ID in `image:` is acceptable because Wrangler resolves it at push time,
  not from the committed config (the auth-time generation distinguishes this from a literal account ID committed
  alongside config). See U3-followup unit spec for full procedure.
- **Registry-fast-path detection:** precomputed `dist/registry-index.json` at build time, dual-keyed (slug +
  owner/repo).
- **Web result shape:** summary + top-3 issues + install-anc-locally CTA. Full check tables + meta deferred to local
  `anc`.
- **Input shape:** registry slug OR install command OR GitHub URL with discovery chain. R1, R3.
- **README parsing approach:** deterministic regex/heuristic for v3. LLM call deferred to v3.1 if needed. Failure mode
  is bounce-out, not wrong-answer.

### Deferred to Implementation

- **Exact `anc check` invocation flags for the live path.** Plan assumes `anc check --command <binary> --output json
  [--audit-profile <category>]` (verified against `anc --help` for v0.3.0 — `--command <NAME>` resolves a command from
  `PATH` and runs behavioral checks). Confirm at implementation time that the resolved binary on `PATH` matches what the
  install path produced (cargo binstall puts binaries in `~/.cargo/bin`; brew in `$HOMEBREW_PREFIX/bin`; etc.) and that
  PATH is set accordingly inside the sandbox.
- **Install-command parser grammar.** The set of commands to parse (`brew install <pkg>`, `brew <pkg>` shorthand, `cargo
  install <pkg>`, `cargo binstall <pkg>`, `bun add -g <pkg>`, `bun install -g <pkg>`, `uv tool install <pkg>`, `pip
  install <pkg>`, `pip3 install <pkg>`, `pipx install <pkg>`, `npm install -g <pkg>`, `npm i -g <pkg>`, `yarn global add
  <pkg>`, `pnpm add -g <pkg>`, `go install <module>@latest`). Implementation picks the regex shape and the
  canonical-tool-name resolution (e.g., `bun add -g @anthropic-ai/claude-code` resolves to binary name `claude`). Edge
  cases handled by bounce-out.
- **GitHub Releases asset matching heuristic.** Match by repo name ± platform suffix (`-linux-x86_64`,
  `-x86_64-unknown-linux-musl`, `-amd64-linux`, etc.). Implementation defines the suffix priority list and the
  tarball-vs-bare-binary handling.
- **README parse heuristic specifics.** First fenced code block whose first non-comment line matches one of the
  install-command shapes AND whose package name matches the repo name (case-insensitive, with hyphen/underscore
  normalization). Implementation defines the exact heuristic.
- **Container PATH composition.** Setting `$PATH` to include `~/.cargo/bin`, `$HOMEBREW_PREFIX/bin`, `~/go/bin`,
  `~/.local/bin` depends on which package managers we ship. Implementation composes the right `ENV PATH` line in the
  Dockerfile.
- **Wireframe-level layout for the summary + top-3 + CTA.** Defer to design review (`/plan-design-review` or
  `/design-review`) before U8 implementation. Initial implementation: re-use the existing per-tool scorecard page
  header/score/issues layout, drop the check-tables section, add the prominent CTA block.
- **Polling vs streaming for live progress.** Initial implementation: client polls `/api/score?session=<id>` every 2 s.
  WebSocket / SSE upgrade deferred unless polling proves to be too chatty.
- **Concurrency scaling.** Default `max_instances: 3` via `getRandom(env.SCORE, 3)` (see K-decision on DO + Containers
  pairing). Spike during U6 implementation: measure cold-start + install + score timings on `basic` instance with
  representative tools, adjust pool size if measured throughput is materially below the 3-instance estimate. Idle
  instances cost storage only (~$0.50/mo each); active CPU is rate-limit-capped, so over-provisioning the pool is cheap
  insurance.
- **`?fromCache=false` exposure (SSL Labs pattern).** Expose publicly with the cool-off; tighten if abuse seen.

### Document Review Backlog (P1/P2)

Findings surfaced by `/ce-doc-review` (2026-05-04, 7 reviewers) that were not promoted to plan-body changes. P0s were
walked through interactively and integrated above. Items below are recorded for triage during `/ce-work` or a future
review pass. Each names the source reviewer and a one-line resolution suggestion.

#### Security (P1, 4 items)

- **README parse install-command flag injection** (security-lens). Parsed install commands may carry attacker flags
  (e.g., `cargo install foo --git https://attacker.com`). `parse-install.ts` MUST template-construct the install command
  from extracted `(pm, package_name)` only, never interpolate additional tokens from the README fenced block. Reject any
  extra flags as `unparseable_install_command`. Apply during U4 implementation.
- **`cargo-binstall` SHA verification mechanism unspecified** (security-lens). U2 line "Install `cargo-binstall`
  standalone binary (musl) via `curl | sh` from upstream (pinned URL/SHA)" doesn't define HOW the SHA is verified. `curl
  | sh` executes the script before any external check. Fix during U2: download to a file, verify against a hard-coded
  `sha256sum -c`, then execute. Same supply-chain discipline as the `anc` bottle install.
- **Session ID entropy unspecified** (security-lens). Polling sessions at `/api/score?session=<id>` use IDs that must be
  cryptographically random (`crypto.randomUUID()` or ≥32 bits CSPRNG). Sequential or time-based IDs would let an
  adversary poll for in-flight sessions of other users. Apply during U6/U8.
- **Two-phase egress in-flight kill semantics unverified** (adversarial). Plan asserts sequential `await` is sufficient
  between Phase 1 and Phase 2, but the SDK's behavior on in-flight TCP streams from the install phase is not documented
  in cited solutions docs. Before U6 ships: confirm via SDK source or CF support; if streams are NOT killed, layer
  `pkill curl wget` between phases. Add an integration test that opens a long-poll during install and asserts it dies
  before `anc check` runs.

#### Feasibility / engineering (P1, 5 items)

- **Image size budget — RESOLVED 2026-05-05.** Measured 221 MB compressed via `docker save | gzip | wc -c` against the
  shipped `docker/sandbox/Dockerfile` (cloudflare/sandbox:0.9.2-musl + apk install + cargo-binstall + anc bottle). P1
  pessimism (400-600 MB) was wrong; original "100-300 MB" claim correct. Image fits the `basic` instance disk (4 GB)
  with ~12x headroom. The "drop Go toolchain" lever is still available (~50 MB compressed savings) but is now decoupled
  from a size constraint and must be evaluated on its security+coverage tradeoffs alone (see go install K-decision
  reconciliation).
- **Polling architecture POST-holds-connection vs 202+poll undefined** (feasibility, design). Plan describes both
  shapes. POST returning 200 with full scorecard means the connection holds for 30-60s; client polling `?session=`
  during that hold doesn't make sense unless POST returns 202 immediately with a session ID. Pick one model in U5/U8:
  recommend POST returns 202 + `{session_id}` immediately; client polls GET `/api/score?session=<id>` every 2s; final
  200 returned on poll when session is complete. Polling reads R2 only (never DO) so it doesn't serialize behind the
  install.
- **Container disk reset on `sleepAfter: "5m"` invalidates warm-binary memoization** (feasibility). After 5 min idle,
  container disk resets — installed binaries don't survive. R2 cache persists, but every cold-after-sleep request
  reinstalls. Either widen `sleepAfter` to ~30m for spike windows OR document explicitly that there is no warm-binary
  memoization layer between container disk and R2 (every miss is a full reinstall). Operational decision; revisit in U6.
- **`go install` is recognized but unsupported in the sandbox image** (feasibility, scope-guardian, security audit).
  Captured in the per-package-manager script-execution audit (K-decisions). Surface in U4 parser comments and the
  bounce-out CTA copy ("recognized but not supported in the live sandbox; install anc locally").
- **SDK API shape inconsistency: `setOutboundByHost` vs `setOutboundHandler('allowHosts')`** (adversarial). Plan uses
  one API, cited solutions doc uses another. Composition semantics between Phase 1 (per-host) and Phase 2 (global
  `noHttp`) are not documented — does global override per-host, or do they layer? Before U6: read SDK source or write a
  one-paragraph clarification in the cf-sandbox solutions doc with a verified test. If they layer, redesign Phase 2 to
  explicitly clear per-host handlers first.

#### UX / design (P1, 4 items — bind to U8)

- **No ARIA live region spec for polling progress updates** (design-lens, P0 within design dimension). WCAG fail in
  shipped form. Add to U8 Approach: progress timeline container has `aria-live="polite"`. Single-line spec, but must
  land before U8 e2e tests.
- **No form label spec; risk of WCAG Level A failure** (design-lens, P0 within design dimension). Add to U8 Approach:
  input has explicit `<label>` (visible or `sr-only`). Single-line spec.
- **No UI spec for 502 / 504 / 500 error states** (design-lens). Plan names the API error shapes but not the user copy,
  recovery action, or CTA visibility for each. Add to U8 Approach during implementation: 502 ("install failed — try a
  different tool, or install anc locally"), 504 ("scoring took too long — install anc locally and run it in your
  project"), 500 (generic "something broke — try again").
- **No progress copy ladder for the 4-step timeline** (design-lens). "validate → resolve → install → score" needs
  user-facing copy for each step ("Checking your URL...", "Finding the install path...", "Installing `<tool-name>`...",
  "Scoring against 7 principles..."). Add during U8 + design-review pass.

#### Scope simplification (P1, 3 items)

- **Parser covers 11 install shapes; registry uses 3** (scope-guardian). YAGNI on `cargo`, `pip`/`pip3`/`pipx`,
  `npm`/`yarn`/`pnpm`, `go install`. Registry is 86 brew + 5 bun + 4 uv + 1 misc. Realistic minimum viable parser: brew,
  bun, uv, pip (wheels). Cut others to v3.1 unless they appear in user-pasted input data. Reduces U4 surface ~40%. Apply
  during U4 implementation as a default-cut decision; bring back individually if measurement shows user need.
- **`dist/score.md` static form twin serves no v3 goal** (scope-guardian) — **RESOLVED 2026-05-14 by U8 scope change.**
  Live-scoring is now embedded on the homepage (`/`), not a dedicated `/score` page. The markdown twin (`/index.md`)
  carries no form references by design, so there is no `dist/score.md` artifact to ship. Resolution per Q4.1 follow-up.
- **`summary-render.ts` placement contradiction** (scope-guardian). U8 declares it in `src/worker/score/` (Worker
  bundle) but says "reused by client via shared module" — separate bundle, no cross-import. Resolve in U8 implementation
  start: either (a) place in `src/shared/` so both bundles import; (b) Worker renders HTML server-side, client just
  injects the response; (c) duplicate the small renderer in client. Pick (a) for clean reuse OR (b) for simpler client.

#### Adversarial / strategic (P1, 4 items)

- **Unconsented third-party scorecards = harassment vector** (adversarial). Any user can score any public repo without
  maintainer consent. A high-profile maintainer with a 2/7 scorecard going viral on HN is a foreseeable bad day. Add to
  Scope Boundaries explicitly with mitigations: (a) every scorecard rendering shows `last-scored: <timestamp>` +
  "re-score" button; (b) prominent disclaimer "agent-readability ≠ tool quality"; (c) takedown contact in footer; (d)
  optional: per-repo opt-out via `.agentnative-noscore` file or registry entry. Decision needed: do we ship (d) in v3 or
  defer?
- **Binary discovery first-match without signing/provenance** (adversarial). Step 2 (GitHub Releases asset matching)
  picks "first asset matching repo+platform". Attacker publishes `repo/cli` with malware named to match the platform
  suffix → sandbox dutifully downloads + executes via `anc check --command`. Mitigations: require exact repo-name
  prefix; prefer signed assets when present (cosign/sigstore); for direct download, refuse repos with <N stars or <M
  months age (cheap heuristic that defeats easy attack). Address during U4 implementation.
- **Discovery chain is GitHub-shaped; v4 multi-provider is refactor not extension** (product-lens). Note in
  `discover-binary.ts` design: GitLab/Bitbucket support is a refactor not an extension. Document so v4 scope estimation
  is honest.
- **Discovery chain parallel/sequential semantics undefined** (adversarial, coherence). Step 3 fans out to 5 registries.
  "First hit wins by priority" + "parallel-fetch" are inconsistent. Pick semantics: "wait up to 2s for any-hit, then
  prefer by priority among arrivals" is reasonable. Document during U4. Note also: 4 GitHub API calls (steps 1, 2,
  possibly 4 README) against 60/hr anonymous limit — under HN spike from a single CF egress IP, exhaustion is possible.
  Plan says "pooled across CF egress IPs" but doesn't quantify.

#### P2 / advisory (5 items)

- **`spec_version` cache drift** (adversarial). Cached entry valid by R11 triad but stale by spec. Add `spec_version` to
  cache key OR refuse cache entries whose `spec_version` is older than current build constant. v3.1 polish.
- **Wedged singleton — no liveness check / pre-flight cleanup** (adversarial). If a previous run left state that breaks
  subsequent installs, every subsequent request 504s for 5min until container sleeps + resets. Add per-request
  pre-flight: `which anc && rm -rf /tmp/install-workdir-*`. ~30 min code; addresses all-504-for-5min failure mode.
- **Repology API may obviate the discovery chain** (adversarial). `repology.org/api/v1/project/<repo>` returns canonical
  install command across 100+ package managers. May reduce chain to "registry hit → repology hit → bounce out" with much
  higher coverage. Worth a 30-min spike before U4 implementation.
- **"Sandbox" terminology drift (4 referents)** (coherence). SDK / per-request instance / DO class / Docker image.
  Introduce aliases (CF Sandbox SDK, sandbox container instance, SCORE DO, sandbox Docker image) and apply consistently.
  Readability fix; not blocking.
- **`?fromCache=false` not surfaced in UI** (adversarial). Feature exists but undiscoverable. Add to U8 result page:
  "Scored at `<timestamp>` — re-score now" button that fires `?fromCache=false`. Also document in `/score.md` markdown
  twin.

---

## Output Structure

`[shipped]` lives on dev now, `[pending]` not yet started, `[mod]` an existing file modified on ship.

```text
docker/
  sandbox/                          # [shipped] — v3 image (Alpine + musl, no toolchains)
                                    #   Used by: CF runtime live-scoring of user-pasted tools (this plan).
                                    #   NOT used for batch-scoring the registry (that's docker/score/).
    Dockerfile                      # [shipped] — cloudflare/sandbox:0.9.2-musl + apk install + anc bottle
    README.md                       # [shipped/mod] U3 — local-build recipe + Dockerfile SHA-pin
                                    #   discipline + what's NOT in the image; production push moves
                                    #   inline to `wrangler deploy` per U3 (CF managed registry)
  score/                            # [shipped, pre-existing] — out of scope for THIS plan
                                    #   Debian/glibc batch-scoring image used by scripts/regen-scorecards.sh
                                    #   to produce dist/scorecards/*.json from registry.yaml.
                                    #   Orthogonal to docker/sandbox/ (different OS, different purpose, much
                                    #   larger). Documented here for inventory completeness; do not merge.
discovery-hints.yaml                # [shipped] — owner/repo -> {pm, package, binary} for U4 step 0.5
registry.yaml                       # [mod] (existing) — single-source tools data; consumed by U1 + U4
src/
  build/
    registry-index.mjs              # [shipped] — emits dist/registry-index.json + dist/discovery-hints-index.json
    build.mjs                       # [mod] — calls emitBuildIndexes after loadRegistry
    score-page.mjs                  # [pending] U8 — emits dist/score.html form + dist/score.md twin
  client/
    live-score.ts                   # [pending] U8 — form submit + fetch + 2s theater + progress polling
  worker/
    index.ts                        # [pending] U5 — adds /api/score path-prefix branch
    spec-version.gen.ts             # [pending] U8 (build-emitted) — SPEC_VERSION + SITE_SPEC_VERSION constants
    score/                          # [shipped] — Worker-side score handler module
      validate.ts                   # [shipped] — input classification (slug / install-command / GitHub URL)
      parse-install.ts              # [shipped] — install-command parser (brew/cargo/bun/uv/pip/npm/go/yarn/pnpm)
      discover-binary.ts            # [shipped] — 4-step discovery chain with F1-tightened step 3
      registry-lookup.ts            # [shipped] — registry-index + discovery-hints hit-test
      handler.ts                    # [pending] U5 — /api/score route entry; URL validate + rate limit + cache + DO
      cache.ts                      # [pending] U7 — R2 read/write keyed by scores/{slug}/{anc-v}/{tool-v}.json
      do.ts                         # [pending] U6 (stub at U3) — Sandbox DO class (extends Sandbox)
      sandbox-exec.ts               # [pending] U6 — two-phase egress + install + anc check + result parsing
      response-shape.ts             # [pending] U5 — spec_version + anc_version + checker_url triad
      content-negotiation.ts        # [pending] U5 — /api/score.md vs /api/score.json branching
      summary-render.ts             # [pending] U8 — buildScoreSummaryBody (header + score + top-3 + CTA)
dist/
  registry-index.json               # [shipped] — emitted artifact (gitignored), 96 slugs / 93 owner/repos
  discovery-hints-index.json        # [shipped] — emitted artifact (gitignored), 3 seed hints
  score.html                        # [pending] U8 — paste-input form page with install-anc CTA
  score.md                          # [pending] U8 — markdown twin of /score
  js/
    live-score.js                   # [pending] U8 — bundled output of src/client/live-score.ts
tests/
  worker.test.ts                    # [pending] U5 (modify) — adds /api/score branch tests, extends CN preferences
  registry-index.test.ts            # [shipped] — build-time emission unit tests (22 tests)
  regression.test.ts                # [mod] — adds regression #7 for live-scoring indexes (3 tests)
  dockerfile-sandbox.test.ts        # [shipped] — static shape assertions on docker/sandbox/Dockerfile (12 tests)
  score-validate.test.ts            # [shipped] — input validation matrix (21 tests)
  score-parse-install.test.ts       # [shipped] — install-command parser table (33 tests)
  score-discover-binary.test.ts     # [shipped] — GitHub URL discovery chain with mocked fetcher (18 tests)
  score-registry-lookup.test.ts     # [shipped] — registry+hints lookup ordering + case-insensitive (10 tests)
  score-handler.test.ts             # [pending] U5 — handler.ts unit tests
  score-cache.test.ts               # [pending] U7 — R2 cache read/write
  score-response-shape.test.ts      # [pending] U5 — spec_version/anc_version/checker_url triad enforcement
  score-contract.test.ts            # [pending] U9 — cross-validates /api/score JSON ↔ committed scorecards
  e2e/
    score.e2e.ts                    # [pending] U8 — Playwright form-submit happy path (chromium, mocked API)
    score-live.e2e.ts               # [pending] U9 — opt-in live sandbox project (excluded from default suite)
docs/
  plans/
    2026-04-28-002-feat-live-scoring-cf-sandbox-plan.md  # this file (rewrite)
  research/
    2026-05-04-discovery-chain-hit-rate.md  # [shipped] — Pre-Implementation Validation gate write-up
  runbooks/
    live-scoring-monitoring.md      # [pending] U9 — cost-watch, alert thresholds, common failures
scripts/
  measure-discovery-hit-rate.mjs    # [shipped] — gate reproducer (local-only, not deployed)
wrangler.jsonc                      # [pending] U3 — adds containers, durable_objects, migrations,
                                    #   r2_buckets, ratelimits bindings (mirror in env.staging)
.github/workflows/
  deploy.yml                        # [pending] U3 — image build runs inside `wrangler deploy` via
                                    #   `image: "./docker/sandbox/Dockerfile"` (no separate push step,
                                    #   no Docker Hub credentials); cache backend (buildx + type=gha
                                    #   vs none) picked by the U3 caching-measurement sub-task
RELEASES.md                         # [pending] U9 — adds v3 release procedure (image + migration + smoke)
README.md                           # [pending] U8 — mentions /score in the user-facing surface map
```

---

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification.
> The implementing agent should treat it as context, not code to reproduce.*

```mermaid
sequenceDiagram
    autonumber
    participant U as User Browser
    participant W as Worker (anc.dev)
    participant L as Workers Rate Limiter
    participant A as ASSETS (registry-index.json)
    participant R as R2 (SCORE_CACHE)
    participant D as Sandbox DO (SCORE, singleton)
    participant S as Container (anc-sandbox, Alpine+musl)
    participant G as github.com / api.github.com
    participant P as Package Registry (brew/crates/npm/pypi/go)

    U->>W: POST /api/score {input}
    W->>W: classify input (slug | install-cmd | URL) + validate
    alt validation fails
        W-->>U: 400 {error: "invalid_input", details}
    end

    W->>A: lookup registry-index.json (slug + owner/repo)
    alt registry hit + scorecard exists
        W->>A: read dist/scorecards/<name>-v<v>.json
        W-->>U: 200 scorecard + spec_version + anc_version + checker_url (≥2s theater)
    else registry miss
        W->>L: limit({key: ipAddress})
        alt rate-limited
            L-->>W: {success: false}
            W-->>U: 429 + Retry-After + X-Current-Assessments
        end

        opt input was install-command
            W->>W: parse → {package_manager, package_name, binary_name}
        end
        opt input was GitHub URL
            W->>W: discovery chain
            W->>G: (a) sniff Content-Type / extension
            W->>G: (b) GET releases/latest, match asset by name+platform
            W->>P: (c) lookup brew/crates/npm/pypi by repo name
            W->>G: (d) GET README, parse first matching install code block
            alt no match
                W-->>U: 404 {error: "no_installable_binary", cta: "install anc locally"}
            end
        end

        W->>R: get scores/{slug}/{anc-v}/{tool-v}.json
        alt R2 cache hit
            R-->>W: cached scorecard
            W-->>U: 200 scorecard + (spec_version, anc_version, checker_url) (sub-100ms)
        else R2 miss
            W->>D: getSandbox(env.SCORE, "anc-scorer")
            D->>S: container.start() (cold start 1-3s)
            D->>S: setOutboundByHost(<install-host>, "allowedInstall")
            S->>P: install command (apk / cargo binstall / pip / npm / go install / brew)
            P-->>S: pre-built binary on $PATH
            D->>S: setOutboundHandler("noHttp")
            S->>S: anc --version → capture anc_version
            S->>S: anc check --command <binary> --output json [--audit-profile <p>]
            S-->>D: scorecard JSON (envelope per anc-output-envelope-pattern)
            D->>R: put scores/{slug}/{anc-v}/{tool-v}.json (best-effort)
            D-->>W: scorecard + anc_version
            W->>W: shape response (add spec_version, checker_url; validate triad)
            W-->>U: 200 scorecard + (spec_version, anc_version, checker_url) (15-60s)
        end
    end
```

The shape: Worker is gatekeeper (classify, validate, registry-lookup, rate-limit, R2-lookup, response shape). DO +
Sandbox is the heavy-lift fallback. R2 is the memoization layer. Registry-fast-path serves from a static asset;
cache-fast-path serves from R2; cold-path spins the sandbox singleton. There is NO clone phase, NO Outbound Worker for
token injection, NO source-only fallback — those are v2 artifacts the rewrite drops.

---

## Dependencies & Prerequisites

**HARD BLOCKER (cross-repo) — SATISFIED 2026-05-04 by `agentnative-cli` v0.3.1.** Release ships
`agentnative-x86_64-unknown-linux-musl.tar.gz` (plus aarch64 musl as a bonus) with `sha256sum.txt` populated. Verified
locally: `file` reports `static-pie linked, stripped`; `ldd` reports `statically linked`; `anc --version` returns `anc
0.3.1`. Static linkage means the binary drops cleanly into any minimal Linux environment including Alpine — no container
smoke-test was required to confirm runtime compatibility.

**Verification artifacts:**

- Release: `gh release view v0.3.1 --repo brettdavies/agentnative-cli` (10 archives including both linux musl arches).
- Local probe: `agentnative-x86_64-unknown-linux-musl/anc --version` returned `anc 0.3.1`.
- `cargo install` / `cargo binstall` validation deferred — U2's image bakes the binary directly via `curl` + tarball
  extract; binstall path is exercised by U6's install probes against unknown tools.

**Original blocker text (preserved for context):** This plan does NOT execute until the upstream `agentnative-cli` repo
publishes a release that includes the `x86_64-unknown-linux-musl` target.

- Required upstream change: add `x86_64-unknown-linux-musl` to the `build` job matrix in
  `agentnative-cli/.github/workflows/release.yml` (currently 5 targets: gnu-linux x2, darwin x2, msvc-windows).
- Required CI step: explicit `rustup target add x86_64-unknown-linux-musl` after the `dtolnay/rust-toolchain` step, per
  the `rustup-target-add-pinned-toolchain-2026-04-16` learning. Toolchain is pinned to 1.94.1 in `rust-toolchain.toml`;
  targets do not auto-install.
- Verification before unblocking this plan:
- `gh release view --repo brettdavies/agentnative-cli vX.Y.Z` shows 6 archives including
  `agentnative-x86_64-unknown-linux-musl.tar.gz`.
- `sha256sum.txt` includes the musl tarball.
- `cargo install` / `cargo binstall agentnative --target x86_64-unknown-linux-musl` works against the new release.
- The musl binary runs cleanly in an Alpine container: `docker run --rm -v $(pwd)/anc:/anc alpine:3.21 /anc --version`
  returns `anc X.Y.Z`.
- Tracked in: separate plan in agentnative-cli repo (`docs/plans/<date>-NNN-feat-musl-release-target-plan.md`). Created
  as the first action under this plan.

**Plausible upstream-PR review concerns to pre-address.** Before filing the PR, write a one-page brief addressing each:

- **Release artifact size budget.** 6th target adds ~10-30 MB to the release bundle (one tarball + entry in
  `sha256sum.txt`). Trivial.
- **Release-time delta.** musl cross-compile in CI typically adds 2-4 minutes per release (matrix expands by 1).
  Annoying but bounded; release cadence is monthly-ish, not per-PR.
- **Trusted Publishing scope.** `cargo publish` Trusted Publishing OIDC scope is per-crate, not per-target — no scope
  change needed. Verify by reading the existing `release.yml` OIDC config.
- **Windows MSVC sibling matrix flakiness.** Matrix expansion can amplify existing flakiness. Mitigation: musl target is
  pure-Rust deps (no native FFI), so it should be the most-reliable target in the matrix, not the least. If flakiness
  rises, retry semantics handle it.
- **Runtime behavior differences (musl vs glibc).** musl libc differs from glibc in DNS resolution (no NSS), threading
  (smaller default stack), locale handling. `anc` is a CLI linter that reads files and emits JSON — it doesn't depend on
  these subsystems. Add a smoke test in `release.yml` that runs `anc --version` and `anc check --output json` against a
  fixture inside an Alpine container.

**Re-plan trigger (NOT a fallback).** If the upstream PR is rejected for technical reasons OR stalls beyond the
agentnative-cli team's bandwidth, v3 PAUSES and returns to `/plan-ceo-review` for re-scoping. **Do NOT silently adopt a
"compile-in-our-CI" path** — compiling `anc` inside the agentnative-site sandbox-image build would reverse Premise #2
(no toolchains in the image) which is the v3 design's load-bearing simplification. A compile-in-CI revision is a
separate plan with its own framing, not a quiet fallback under this one. The v2 plan rev silently made exactly this kind
of compromise; v3 is the correction. Do not re-make v2's mistake.

Soft prerequisites (do not block U1, but block deployment):

- CF account scope: `Workers Scripts: Write` + `Containers: Write` + `Durable Objects: Write` + `R2 Storage: Write` on
  the `CLOUDFLARE_API_TOKEN` used by `deploy.yml`. Mint via 1Password per
  `cloudflare-api-token-headless-wrangler-1password-2026-04-13`.
- R2 bucket created: `anc-score-cache` (prod) + `anc-score-cache-staging` (staging).
- CF managed registry will be auto-provisioned by `wrangler deploy` on first deploy of the Sandbox container; no Docker
  Hub repo needed (image lives at `registry.cloudflare.com/<account>/...` after first deploy).

---

## Pre-Implementation Validation

**Status: PASSED 2026-05-04** ([PR #77](https://github.com/brettdavies/agentnative-site/pull/77), commit `078d233`)**.**
76.0% tight hit rate against 50 trending CLI repos (≥70% threshold → `pass-ship-as-written`). Per-language: Rust 92% /
Python 50% / Go 85% / JS 75%. Two findings absorbed back into the plan:

- **F1 → U4 spec change.** The literal U4 step-3 predicates admit cross-registry name collisions (e.g. `cobra` on
  crates.io is an unrelated Python-Haskell joke crate, not `spf13/cobra`). U4 now requires per-registry repository-field
  match plus, where available, a binary-target check. Without this tightening the chain produces *wrong-answer*
  failures, not just *missed-opportunity* bounces (R9 violation). Plus a new step 0.5 — explicit `discovery-hints.yaml`
  lookup — to absorb known false-negatives where ecosystem metadata is incomplete (Aider, OpenHands, Sherlock).
- **F4 → U6 + U8 spec change.** The original "no_installable_binary" bounce class is too coarse. U6 returns a
  three-class error envelope (`chain_no_resolve` / `chain_resolved_install_failed` /
  `chain_resolved_no_binary_produced`); U8 surfaces distinct CTA copy per class.

Evidence: [docs/research/2026-05-04-discovery-chain-hit-rate.md](../research/2026-05-04-discovery-chain-hit-rate.md).
Reproducer: `bun scripts/measure-discovery-hit-rate.mjs`.

---

**Original gate text (preserved for context):**

**Discovery-chain hit-rate measurement (gates U2 image build).** Before U2 starts, validate that the install-binary-only
constraint (R8) doesn't bounce out the bulk of HN-typical traffic. The plan's "missed-opportunity, never wrong-answer"
framing for bounce-outs is only acceptable if the bounce rate is low enough that the share-loop survives. HN audience
skews toward indie/experimental Rust + Python + Go tools — exactly the bucket most likely to lack a published binary.

**What to measure:**

1. Sample 50 GitHub-trending CLI repos across Rust, Python, Go, JS (12-13 each), drawn from the GitHub trending feed
   over the past 30-90 days. Filter for repos that look like CLI tools (binary entry point, README mentions install).
2. Run a paper version of the discovery chain against each: a local Node/bun script that exercises the same 4-step logic
   (direct binary URL → GitHub Releases asset → registry lookup against brew/crates/npm/pypi/go → README parse). No
   sandbox, no live install — just the resolution chain.
3. Classify each result: `registry-fast-path-hit` (would short-circuit), `discovery-resolves-to-binary`,
   `bounce-out-no-binary`. Record which step resolved (or which step exhausted).

**Acceptance gate:**

- **≥70% resolve to a binary** (registry hit OR discovery-chain hit): Plan ships as written.
- **50-69% resolve:** Acceptable but flag in Risk Analysis with monitoring threshold; the bounce-out CTA copy gets
  emphasis design work in U8 (it's a frequent path, not an edge case).
- **<50% resolve:** Plan needs scope rework BEFORE U2. Options to surface back to the user: (a) expand registry seed to
  250+ tools so registry-fast-path covers more of the long tail; (b) revisit the install-binary-only rule (does the
  image admit a Rust toolchain for `cargo install` fallback?); (c) reframe the launch hook around the leaderboard with
  /score as a secondary surface (the "do-nothing baseline" the plan currently doesn't compare against).

**Files:**

- Create: `scripts/measure-discovery-hit-rate.mjs` (local script; not deployed)
- Create: `docs/research/2026-MM-DD-discovery-chain-hit-rate.md` (write-up of methodology + results)

**Verification:** Markdown report committed before U2 starts. Hit rate published. If the gate fails, the user is
re-engaged before further units start.

This validation is meta to the plan: it gates the plan itself, not a unit.

---

## Implementation Units

### Shipping Progress (last updated 2026-05-14)

| Unit | Status    | Shipping refs                                                                                        |
| ---- | --------- | ---------------------------------------------------------------------------------------------------- |
| U1   | [shipped] | PR [#78](https://github.com/brettdavies/agentnative-site/pull/78) — commit `82b74dd`                 |
| U2   | [shipped] | PR [#79](https://github.com/brettdavies/agentnative-site/pull/79) — commit `bf14daf` (see U3-fu)     |
| U3   | [partial] | PR [#81](https://github.com/brettdavies/agentnative-site/pull/81) — commit `09fe91f` (bindings only) |
| U4   | [shipped] | PR [#80](https://github.com/brettdavies/agentnative-site/pull/80) — commit `5ac59ca`                 |
| U5   | [pending] | depends on U3 (bindings shipped) + U4 (parser, shipped)                                              |
| U6   | [pending] | depends on U2 (image, shipped) + U3-followup + U4 (shipped) + U5                                     |
| U7   | [pending] | depends on U3-followup + U6                                                                          |
| U8   | [pending] | depends on U5                                                                                        |
| U9   | [pending] | cross-cutting; depends on U1-U8                                                                      |

**Phase 1 (foundation: data + image + parser) is complete.** U3 partially landed in PR #81: wrangler bindings
(`containers`, DO `SCORE`, R2 `SCORE_CACHE`, ratelimit `SCORE_LIMITER`) are live on prod + staging; the DO at
`src/worker/score/do.ts` is a stub returning `{error: 'sandbox_stub_until_u6'}`; the container `image:` field still pins
`docker.io/brettdavies/anc-sandbox@sha256:...`. The Docker Hub registry was deprecated post-shipment, so a U3-followup
unit must migrate `image:` to inline `./docker/sandbox/Dockerfile` and wire the Cloudflare managed registry build into
`.github/workflows/deploy.yml`. Phase 2 (sandbox install + R2 cache + UX) follows — see "Current state — 2026-05-14"
near the top of this document for the rollout-order summary. The Pre-Implementation Validation gate
([PR #77](https://github.com/brettdavies/agentnative-site/pull/77)) ran ahead of Phase 1 and conditioned the U1, U4, U6,
U8 specs via the F1 + F4 findings (see plan amend commit `08a9a24`).

---

- [x] U1. **Build-time registry-index + discovery-hints index emission** — shipped 2026-05-04
  ([#78](https://github.com/brettdavies/agentnative-site/pull/78), `82b74dd`)

**Goal:** Emit two precomputed JSON indexes at build time:

1. `dist/registry-index.json` — dual-keyed map (slug → entry, owner/repo → entry) of every committed-scorecard tool, so
   the Worker can do O(1) lookups whether the input was a slug or a GitHub URL.
2. `dist/discovery-hints-index.json` — owner/repo → install-spec map for tools the discovery chain would otherwise
   bounce due to incomplete or non-canonical ecosystem metadata (e.g. brew formula whose `homepage` doesn't reference
   the GitHub repo). Consumed by U4's step 0.5 (between registry-fast-path and step 2). Pre-Implementation Validation
   gate finding F1.

Pure build-step change; no CF dependencies; lands first because it unblocks U4 + U5 + U6.

**Requirements:** R2, R3.

**Dependencies:** None.

**Files:**

- Create: `src/build/registry-index.mjs`
- Create: `discovery-hints.yaml` (seeded from gate findings; lives at repo root next to `registry.yaml`)
- Modify: `src/build/build.mjs` (insert step after `loadRegistry` near the sub-page loop)
- Test: `tests/registry-index.test.ts`
- Test: `tests/discovery-hints-index.test.ts`
- Modify: `tests/regression.test.ts` (add structural assertions on both `dist/*-index.json` files)

**Approach:**

- Read `registry.yaml` via existing `loadRegistry()` (`src/build/scorecards.mjs`).
- For each tool, derive the GitHub `owner/repo` (from `repo:` field, or parse from `url:` if `repo:` absent).
- Emit `dist/registry-index.json` with shape:

  ```json
  {
    "by_slug": { "ripgrep": { name, binary, install, audit_profile, repo, ... } },
    "by_owner_repo": { "BurntSushi/ripgrep": { name, binary, install, audit_profile, repo, ... } }
  }
  ```

- Include `audit_profile` so the live path can pass it to `anc check --audit-profile <category>`.
- Tools with neither `repo:` nor `url:` → entry skipped, build warning emitted (not a failure).
- Tools with same `owner/repo` (fork) → second wins, build warning.
- Read `discovery-hints.yaml` (top-level `hints:` array) and emit `dist/discovery-hints-index.json` with shape:

  ```json
  {
    "by_owner_repo": {
      "Aider-AI/aider": { "pm": "pip", "package": "aider-chat", "binary": "aider", "note": "..." }
    }
  }
  ```

- Hints whose `owner_repo` collides with a `registry.yaml` entry → registry wins (committed scorecards take precedence);
  build warning emitted so the redundant hint can be pruned.
- Hints with unknown `pm` (not in U4's parse-install table) → build error (typo guard).

**Seed hints (from gate F1 false-negatives):**

- `Aider-AI/aider` → `{pm: pip, package: aider-chat, binary: aider}` (brew homepage routes to aider.chat, not github)
- `OpenHands/OpenHands` → `{pm: pip, package: openhands-ai, binary: openhands}` (pypi `home_page` is null)
- `sherlock-project/sherlock` → `{pm: brew, package: sherlock, binary: sherlock}` (brew homepage doesn't reference the
  repo)
- Headroom for 2-3 more as production telemetry surfaces them.

**Patterns to follow:**

- `src/build/skill.mjs` — single-source data → emits canonical JSON + HTML + MD twin. Same shape (we only emit JSON
  here; the form HTML is U8).

**Test scenarios:**

- Happy path: registry with N tools → `registry-index.json` has N entries in both maps, keyed correctly.
- Edge case: tool with `url:` only (no `repo:`) → entry keyed by parsed `owner/repo` from URL in both maps.
- Edge case: tool with neither `repo:` nor `url:` → entry skipped, build warning, no crash.
- Edge case: two tools with same `owner/repo` → build warning, second wins.
- Edge case: `audit_profile` field round-trips into the index.
- Happy path (hints): `discovery-hints.yaml` with M entries → `discovery-hints-index.json` has M entries by
  `owner_repo`.
- Edge case (hints): hint whose `owner_repo` is also in `registry.yaml` → build warning, hint dropped, registry wins.
- Edge case (hints): hint with `pm: yum` (not in parse-install table) → build error.
- Integration: `dist/registry-index.json` AND `dist/discovery-hints-index.json` exist after `bun run build`; regression
  test asserts `by_slug` + `by_owner_repo` keys on registry index with ≥50 entries, and `by_owner_repo` on hints index
  with ≥3 entries.

**Verification:** `bun run build` produces both index files with the documented shapes; regression test passes; no
warnings on the current registry + hints; collision case caught by warning, not crash.

---

- [x] U2. **v3 sandbox image (Alpine + musl, no toolchains, anc bottle baked in)** — shipped 2026-05-04
  ([#79](https://github.com/brettdavies/agentnative-site/pull/79), `bf14daf`). Pinned to
  `cloudflare/sandbox:0.9.2-musl@sha256:b4cb1d69…` (the `0.8.x` reference below is plan-time placeholder; the actual
  digest is in `docker/sandbox/Dockerfile`). **Note (2026-05-14):** image source is ready; the image-publication path
  now requires migration to the Cloudflare managed registry per U3-followup (Docker Hub deprecated post-shipment).

**Goal:** Build `docker/sandbox/Dockerfile` as a strict-minimal Alpine + musl image carrying CF Sandbox 0.9.x-musl,
package managers (apk, cargo-binstall, pip, npm, go), and a pre-built musl `anc` binary downloaded from the
agentnative-cli release. NO compilers other than what apk's go package transitively ships (see `go install` K-decision).
Brew is intentionally omitted (Linuxbrew requires glibc, non-viable on Alpine). Image budget: ≤350 MB compressed;
**measured 221 MB compressed at v3-rc1 (2026-05-05)**.

**Requirements:** R4, R8, R12 (image must fit `basic` instance type and stay under cost ceiling).

**Dependencies:** Cross-repo prerequisite (musl `anc` release published — see Dependencies & Prerequisites).

**Files:**

- Create: `docker/sandbox/Dockerfile`
- Create: `docker/sandbox/README.md`
- Test: `tests/dockerfile-sandbox.test.ts` — plan-time intent was "asserts image-size assertion via `docker image
  inspect` ≤350 MB; optional in CI behind a docker-available guard." Shipped reality: only static-text assertions on
  Dockerfile shape (no docker daemon usage, no size check). Captured as a Risk-row gap; fold into RELEASES.md or a CI
  guard before re-litigating.

**Approach:**

- Multi-stage:

1. `FROM docker.io/cloudflare/sandbox:0.8.x-musl AS sandbox-base` (SHA-pinned digest, comment names the version).
2. `FROM alpine:3.21 AS final` — copy `/container-server/sandbox` and `/usr/lib/libstdc++.so.6` from sandbox-base
   (verify libstdc++ still required on 0.8.x; drop if not).
3. `RUN apk add --no-cache git curl jq bash ca-certificates python3 py3-pip nodejs npm go` — package managers, no
   compilers (no `build-base`, no `gcc`, no `rust`).
4. Install `cargo-binstall` standalone binary (musl) via `curl | sh` from upstream (pinned URL/SHA).
5. Install `homebrew` ONLY if there's a working musl-compatible install path; otherwise skip and document the limitation
   (brew-required tools fall through to bounce-out CTA).
6. Download `anc` musl bottle: `curl -fsSL
   https://github.com/brettdavies/agentnative-cli/releases/download/vX.Y.Z/agentnative-x86_64-unknown-linux-musl.tar.gz
   | tar xz -C /usr/local/bin/ anc`. Verify SHA256 against `sha256sum.txt`.
7. `ENV PATH="/usr/local/bin:/usr/local/cargo/bin:/usr/local/go/bin:/root/.local/bin:$PATH"`.
8. `ENTRYPOINT ["/sandbox"]`.

- Image size assertion in test: ≤350 MB compressed; warn ≤500 MB; fail >800 MB.
- Pin Cloudflare sandbox tag exactly to the npm SDK version; SDK warns on mismatch.

**Patterns to follow:**

-

[docs/solutions/architecture-patterns/cf-sandbox-secure-cli-execution-2026-04-17.md](../solutions/architecture-patterns/cf-sandbox-secure-cli-execution-2026-04-17.md)
— overall structure (Alpine+musl base, copy sandbox binary + libstdc++).

**Test scenarios:**

- Happy path: `docker build -f docker/sandbox/Dockerfile .` succeeds.
- Happy path: built image runs and `/sandbox` responds to health check.
- Happy path: `docker run --rm <image> anc --version` returns `anc X.Y.Z`.
- Happy path: `docker run --rm <image> sh -c "cargo binstall --no-confirm ripgrep && rg --version"` succeeds in ≤30 s.
- Edge case: image size ≤350 MB compressed (regression assertion).
- Edge case: `cargo-binstall`, `pip`, `npm`, `go` all on PATH with `--version` working.
- Integration: image runs in `wrangler dev --local` mode; `sandbox.exec("anc --version")` returns the baked-in version.

**Verification:** Image builds, fits `basic` instance type (1 GiB RAM / 4 GB disk), runs `anc --version` via the Sandbox
SDK. README documents the local-build workflow and the Dockerfile SHA-pin recipe (production push moves to `wrangler
deploy` per U3).

---

- [~] U3. **wrangler.jsonc — DO + Containers + R2 + ratelimits bindings** — [partial] shipped 2026-05-09
  ([#81](https://github.com/brettdavies/agentnative-site/pull/81), `09fe91f`). Bindings (`containers`, DO `SCORE`, R2
  `SCORE_CACHE`, ratelimit `SCORE_LIMITER`) live on the **staging** Worker; the named-production Worker
  (`agentnative-site`) has NOT yet deployed the bindings (last prod deploy was 2026-05-03, predates this PR). Routing
  drift discovered 2026-05-14 means `anc.dev` is currently served by the staging Worker. The DO at
  `src/worker/score/do.ts` is a stub returning `{error: 'sandbox_stub_until_u6'}` (real DO lands in U6). The container
  `image:` field migrated off Docker Hub via U3-followup (PR
  [#84](https://github.com/brettdavies/agentnative-site/pull/84)) and now pins
  `registry.cloudflare.com/<acct>/anc-sandbox:30f61f1` on the staging block. See the dedicated U3-followup subsection
  below for the local-build-once + staging-leads-prod workflow and the (now-shipped) experimental verifications. The
  named-production Worker's full U3 + U3-followup deploy shipped 2026-05-15 via release PR
  [#85](https://github.com/brettdavies/agentnative-site/pull/85) (merge SHA `e79b7ce`); DO migration v1 applied to the
  named-prod side on that deploy.

**Goal:** Add the first DO + Containers + R2 + ratelimits bindings the Worker has ever shipped. Pre-push wrangler
dry-run gate must pass before push.

**Requirements:** R4, R5, R6. Foundational for U5-U7.

**Dependencies:** U2 (Dockerfile must exist for `containers[].image` to reference; `wrangler deploy` builds it inline on
each deploy).

**Files:**

- Modify: `wrangler.jsonc` (top-level + `env.staging` parallel bindings)
- Modify: `src/worker-configuration.d.ts` (regenerated via `bun run types`)
- Modify: `package.json` (verify `bun run types` runs `wrangler types`)
- Modify: `.github/workflows/deploy.yml` (cache backend for the inline image build TBD per the caching-measurement
  sub-task below; do NOT pre-commit to `docker/setup-buildx-action` + `actions/cache@v4` until measurements show that
  pattern actually pays off given `cloudflare/wrangler-action`'s docker invocation)
- Modify: `docker/sandbox/README.md` (mark the explicit `docker push` recipe as "optional, for local image testing";
  production ships via `wrangler deploy` against the CF managed registry)
- Test: regression check that `wrangler deploy --dry-run` succeeds (already covered by pre-push hook)

**Approach:**

- Add to top-level `wrangler.jsonc`:
- `containers: [{ class_name: "Sandbox", image: "./docker/sandbox/Dockerfile", instance_type: "basic", max_instances: 3
  }]` — `image:` is a Dockerfile path, NOT a registry URI. `wrangler deploy` builds the image and pushes to the
  Cloudflare managed registry (R2-backed, account-scoped) as part of deploy, authenticated via `CF_API_TOKEN`. Avoids
  putting the account ID in `wrangler.jsonc` (per `account-id-out-of-public-repo-2026-04-14`); avoids Docker Hub
  credentials and Docker Hub pull-rate-limit exposure at sandbox cold-start.
- `durable_objects: { bindings: [{ class_name: "Sandbox", name: "SCORE" }] }`
- `migrations: [{ tag: "v1", new_sqlite_classes: ["Sandbox"] }]` — must be `new_sqlite_classes`, not legacy
  `new_classes`. This is the ONE-WAY gate.
- `r2_buckets: [{ binding: "SCORE_CACHE", bucket_name: "anc-score-cache" }]`
- `ratelimits: [{ name: "SCORE_LIMITER", namespace_id: "1001", simple: { limit: 10, period: 60 } }]`
- Mirror all bindings in `env.staging` with staging-suffixed names: `anc-score-cache-staging`, distinct DO namespace,
  distinct ratelimit namespace. The staging `image:` value is the SAME Dockerfile path; the staging Worker name
  (`agentnative-site-staging`) is what namespaces the resulting CF-registry image distinct from prod. Verify at
  implementation time that prod and staging produce distinct image tags by inspecting `wrangler containers images list`
  after the first staging+prod deploys.
- Stub the `Sandbox` DO class export in `src/worker/score/do.ts` BEFORE this unit so the dry-run passes; full
  implementation is U6.
- `.github/workflows/deploy.yml` adjustments (mirror in both the `staging` and `production` jobs):
- The existing `paths-ignore: ['docs/**', '*.md']` filter already keeps doc-only changes from triggering deploys. Do NOT
  add a `paths:` allowlist that would gate the deploy job by source area — image-source changes (`docker/sandbox/**`)
  and Worker-source changes both must trigger the same deploy job, since either kind of change produces a new Worker
  version.
- Do NOT add `docker login` / `docker push` / Docker Hub credential steps. Wrangler authenticates to the CF managed
  registry using the existing `CF_API_TOKEN`; there is no separate registry to log into and no separate push step.
- **Caching-measurement sub-task (gates any caching-specific wiring).** Before adding `docker/setup-buildx-action`,
  `actions/cache@v4`, `cache-from/to: type=gha`, or any other cache backend to `deploy.yml`, run two no-op deploys
  back-to-back (a) with no caching configured, then (b) with a candidate caching strategy added. Capture wall-clock per
  step (specifically the `wrangler deploy` step that does the image build + push) from the GH Actions run logs. Pick the
  strategy if it materially shortens the second deploy; skip it if it doesn't (the alternative is "every deploy pays the
  full image-build cost," which is acceptable for the current low deploy frequency). The `cloudflare/wrangler-action`
  action wraps `wrangler deploy`'s image-build invocation in a way that isn't publicly documented; the measurement is
  the only reliable signal. Record the chosen approach in `RELEASES.md` Operational Notes so the rationale survives.

**Patterns to follow:**

-

[docs/solutions/best-practices/account-id-out-of-public-repo-2026-04-14.md](../solutions/best-practices/account-id-out-of-public-repo-2026-04-14.md)
— `account_id` stays out of the file.

- [docs/research/2026-04-28-cloudflare-live-scoring-v2.md](../research/2026-04-28-cloudflare-live-scoring-v2.md) §2 —
  verified Wrangler syntax for Containers bindings.

**Test scenarios:**

- Happy path: `bun x wrangler deploy --dry-run` exits 0 with the new bindings (validated by pre-push hook).
- Happy path: `bun run types` regenerates `src/worker-configuration.d.ts` to expose `SCORE`, `SCORE_CACHE`,
  `SCORE_LIMITER` on `Env`.
- Edge case: staging deploy succeeds; staging Worker's bindings are distinct from prod (different DO namespace ID,
  different R2 bucket name).
- Integration: rollback path documented in `RELEASES.md` — note that `wrangler rollback` only works among
  post-migration-v1 versions; cross-migration rollback requires a follow-up migration with `deleted_classes`.
- Measurement: capture wall-clock for two consecutive `wrangler deploy` runs against staging (no source change between
  them) to establish baseline image-build cost. Record in the U3 PR body so the caching-measurement sub-task has a
  concrete number to optimize against.

**Verification:** Pre-push wrangler dry-run passes locally; staging deploy succeeds; type generation includes all new
bindings; first prod deploy is its own milestone PR with the migration explicitly reviewed; baseline deploy wall-clock
recorded.

---

- U3-followup. **Docker Hub to CF managed registry migration (local-build-once + staging-leads-prod)** — staging side
  shipped 2026-05-14 via PR [#84](https://github.com/brettdavies/agentnative-site/pull/84); production side shipped
  2026-05-15 via release PR [#85](https://github.com/brettdavies/agentnative-site/pull/85) (merge SHA `e79b7ce`).

> **Post-implementation note (2026-05-14).** Original spec said "shared-tag-pin" (both env blocks always equal). The
> rationale ("avoids the multi-env double-build") came from the inline-Dockerfile-path pattern; with registry URIs,
> deploys never rebuild, and the double-build penalty does not exist. The implementation reframed the default
> workflow to **staging-leads-prod**: feat PRs to dev bump `env.staging` only, soak on the staging Worker, then a
> release PR to main promotes the top-level pin to match. Lockstep remains available as a shortcut for low-risk
> bumps. CI guard in `.github/workflows/ci.yml` enforces this per-PR-target (registry-existence always; equality
> only on main-targeting PRs). See RELEASES.md § "Sandbox image releases (live-scoring)" for the canonical workflow
> spec.

**Goal:** Replace the deprecated Docker Hub digest pin (`docker.io/brettdavies/anc-sandbox@sha256:...`) with a
Cloudflare-managed-registry tag pin produced by a single local build, then deploy each env block against its own pinned
tag with no rebuild on deploy. Decouples build from deploy and preserves the SHA-pinning ergonomic Docker Hub gave us.
The two env blocks' pins can advance independently; staging leads during development, prod advances at release time.

**Requirements:** R4 (image must be pullable by CF runtime), R12 (no per-deploy build cost on the typical site-only PR).

**Dependencies:** U2 (`docker/sandbox/Dockerfile` exists and builds), U3 (env blocks exist for both prod + staging).

**Files:**

- Modify: `wrangler.jsonc` — top-level `containers[].image` AND `env.staging.containers[].image` both point at the same
  fully-qualified registry tag (`registry.cloudflare.com/<acct>/anc-sandbox:<git-sha>`).
- Modify: `docker/sandbox/README.md` — document the local-build-once recipe; the prior "ships via `wrangler deploy`"
  copy is wrong post-migration.
- Modify: `RELEASES.md` — release procedure now includes the build + tag-pin commit + deploy steps as separate
  operations (build is no longer implicit in deploy).
- Optional: `.dockerignore` at the build-context root (`docker/sandbox/.dockerignore` for the default context, or repo
  root if `image_build_context: "."` is later adopted) — verify experimentally on first staging deploy whether the layer
  payload includes any unexpected files (per spike 01, `.dockerignore` semantics for Wrangler's docker shell-out are not
  explicitly documented; standard Docker context rules should apply).
- No `.github/workflows/deploy.yml` change is required for the primary path — `wrangler deploy` against a
  fully-qualified registry URI does NOT trigger a rebuild (per spike 01); the GHA fallback path continues to work for
  the rare offline-Brett case via `cloudflare/wrangler-action@v3.14.1` (the version currently in `deploy.yml`).

**Approach:**

Primary path (local build, recommended):

1. From a clean working tree, capture the git SHA: `GIT_SHA=$(git rev-parse --short HEAD)`.
2. Build + push in one command (Wrangler shells out to local `docker build`, then pushes to `registry.cloudflare.com`):

   ```bash
   wrangler containers build -p -t "$GIT_SHA" docker/sandbox/
   ```

   `-p` is push; `-t <tag>` sets the tag. Build context defaults to the Dockerfile's parent directory
   (`docker/sandbox/`); override with `image_build_context: "."` only if the Dockerfile needs files from elsewhere in
   the repo. Wrangler builds locally via `docker build` (not on the CF side); Docker / Colima must be running. Per
   spike 01, the registry destination is `registry.cloudflare.com/<ACCOUNT_ID>/anc-sandbox:<GIT_SHA>`; auth uses the
   existing `CF_API_TOKEN`. Account ID does NOT land in `wrangler.jsonc` because Wrangler resolves it from auth at
   push time.
3. Pin both env blocks in `wrangler.jsonc` to the new tag:

   ```jsonc
   {
     "containers": [{
       "class_name": "Sandbox",
       "image": "registry.cloudflare.com/<acct>/anc-sandbox:<git-sha>",
       "instance_type": "basic",
       "max_instances": 3
     }],
     "env": {
       "staging": {
         "containers": [{
           "class_name": "Sandbox",
           "image": "registry.cloudflare.com/<acct>/anc-sandbox:<git-sha>",
           "instance_type": "basic",
           "max_instances": 3
         }]
       }
     }
   }
   ```

   `containers` is non-inheritable per
   [wrangler environments](https://developers.cloudflare.com/workers/wrangler/environments/), so each env block needs
   its own copy. Pointing both at the same tag avoids the multi-env double-build that arises when both env blocks point
   at the same Dockerfile path.
4. Deploy to staging first, then production; neither deploy rebuilds because `image:` is a fully-qualified URI:

   ```bash
   wrangler deploy --env staging
   wrangler deploy --env production
   ```

5. Smoke staging via the U9 contract test before promoting to prod.

GHA fallback path (offline-Brett case): set `image: ./docker/sandbox/Dockerfile` temporarily in `wrangler.jsonc` and let
`cloudflare/wrangler-action@v3.14.1` build inline on `ubuntu-latest`. Per spike 02, expect a ~60-130s cold build
dominated by the `apk add` line and the base-image pull, with no native GHA-side layer cache (wrangler shells out to
plain `docker build` without `--cache-from/--cache-to`; layering `docker/setup-buildx-action` + `actions/cache` does NOT
help because wrangler doesn't consume that cache). The push step IS deduplicated automatically by registry-side manifest
inspect (`"Image already exists remotely, skipping push"` log line is the canary). "Measure before optimizing" applies:
cold-build is acceptable for the rare fallback.

Experimental verification list (run during the first staging deploy, capture results in the PR body):

- **`.dockerignore` semantics.** Add a sentinel file `docker/sandbox/.ignored-sentinel.txt` with `RUN ls -la
  /tmp/ctx-check 2>/dev/null || true` in the Dockerfile, build, confirm the sentinel is excluded by `.dockerignore` AND
  not present in the resulting layer (`docker history` or `RUN ls`). Per spike 01, this rule is not Wrangler-documented;
  the standard Docker BuildKit contract should hold but verify on first run.
- **Multi-env image-share verification.** After both staging + prod deploys against the same tag, run `wrangler
  containers images list --json` and confirm one image record is shared by both Worker apps (or accept whatever
  per-env-app namespacing CF imposes; document the actual shape). Per spike 01, container apps default to per-env names
  but the underlying image bytes should dedup at the registry layer.
- **Recorded image reference shape per Worker version.** After the first deploy, run `wrangler deployments list --json`
  and inspect the version metadata to confirm the bound image reference is `name:tag` form (mutable) rather than
  content-addressable `@sha256:` form. Per spike 01 + spike 03 this is undocumented; the rollback-fragility risk in the
  Risk Analysis section assumes name-tag binding (deletion of an image breaks rollback per the Containers Limits
  footnote).
- **No-op deploy fast path.** Per spike 02: a redeploy of the same tag should hit `"Image already exists remotely,
  skipping push"`. If it doesn't, the build is leaking nondeterminism and should be fixed before relying on registry
  dedup.

Image-retention discipline (per spike 03): never delete images from the CF managed registry that backed shipped
versions. The 50 GB account-wide cap will eventually force a prune; that prune is a quarterly manual exercise paired
with explicit "what versions become unrollback-able" review. Pair every git release tag with the registry image URI in
RELEASES.md so the inventory survives.

**Patterns to follow:**

- Spike 01 findings (resolved Q1.1-Q1.6) — single source of truth for build mechanics.
- Spike 02 findings (resolved Q2.1-Q2.6) — wrangler-action invocation shape, no-op deploy fast path.
-

[docs/solutions/best-practices/account-id-out-of-public-repo-2026-04-14.md](../solutions/best-practices/account-id-out-of-public-repo-2026-04-14.md)
— account ID stays out of `wrangler.jsonc`; Wrangler resolves it from auth at push time, so the literal in `image:` is
acceptable because it is generated at push time, not committed alongside config.

**Test scenarios:**

- Happy path (primary): `wrangler containers build -p -t <git-sha> docker/sandbox/` succeeds against a working CF API
  token; the resulting tag is visible via `wrangler containers images list`.
- Happy path (deploy): `wrangler deploy --env staging` against the new tag completes without a rebuild step in the log
  output; same for `--env production`.
- Edge case (fallback): with `image: ./docker/sandbox/Dockerfile`, GHA `cloudflare/wrangler-action@v3.14.1` deploy
  succeeds within the ~60-130s cold-build envelope; `"Image already exists remotely, skipping push"` appears on the
  second consecutive run if no source changed.
- Edge case (multi-env identity): after first deploy of both envs, `wrangler containers images list --json` shows
  exactly the expected image footprint (do not silently consume 2x the 50 GB cap).
- Regression: pre-push `wrangler deploy --dry-run` continues to pass for both env blocks.

**Verification:** Both staging + production deploys complete without rebuild against the same git-SHA tag; the
no-op-deploy fast path fires on a redeploy; the four experimental-verification items above are answered and recorded in
the PR body and (where load-bearing) in RELEASES.md.

---

- [x] U4. **Input parser + GitHub URL discovery chain** — shipped 2026-05-04
  ([#80](https://github.com/brettdavies/agentnative-site/pull/80), `5ac59ca`). 91 new tests; F1 tightening landed as a
  hard requirement on every step-3 predicate.

**Goal:** Classify the user's input into one of four kinds (registry-slug, install-command, github-url, unknown), parse
each into a structured `{package_manager, package_name, binary_name, repo?}` shape, and run the GitHub URL discovery
chain (R3) for URL inputs.

**Requirements:** R1, R3.

**Dependencies:** U1 (registry-index AND discovery-hints-index for slug + owner/repo lookup).

**Files:**

- Create: `src/worker/score/validate.ts` — shape: `validateInput(raw: string): ValidatedInput | InputError`
- Create: `src/worker/score/parse-install.ts` — install-command parser table
- Create: `src/worker/score/discover-binary.ts` — GitHub URL 4-step discovery
- Create: `src/worker/score/registry-lookup.ts` — registry-index + discovery-hints hit-test
- Test: `tests/score-validate.test.ts`
- Test: `tests/score-parse-install.test.ts`
- Test: `tests/score-discover-binary.test.ts`
- Test: `tests/score-registry-lookup.test.ts`

**Execution note:** Test-first for the parser tables — these are pure functions with deterministic table-driven
behavior; tests are the spec.

**Approach:**

- `validate.ts` classifies input by inspection:
- If matches `/^[a-z0-9-]+$/` AND in registry-index `by_slug` → `{kind: "slug", slug}`.
- If contains a known package-manager prefix (`brew`, `cargo`, `bun`, `uv`, `pip`, `pip3`, `pipx`, `npm`, `yarn`,
  `pnpm`, `go`) → delegate to `parse-install.ts`.
- If matches `https://github.com/<owner>/<repo>(\\.git)?$` → delegate to `discover-binary.ts`.
- Else: `{kind: "unknown", error: "unrecognized_input"}` → 400.
- `parse-install.ts` table:
- `brew install <pkg>` / `brew <pkg>` (shorthand) → `{pm: "brew", pkg, binary: <pkg>}`.
- `cargo install <pkg>` / `cargo binstall <pkg>` → `{pm: "cargo-binstall", pkg, binary: <pkg>}` (cargo-binstall is the
  runner; falls back to `cargo install` only if no binstall asset — but we won't compile, so cargo install without a
  binstall asset is a bounce-out).
- `bun add -g <pkg>` / `bun install -g <pkg>` / `bun i -g <pkg>` → `{pm: "bun", pkg, binary: resolveBunBinary(pkg)}`.
- `uv tool install <pkg>` / `pip install <pkg>` / `pip3 install <pkg>` / `pipx install <pkg>` → `{pm: "pip", pkg,
  binary: <pkg>}` (pip wheels only — refuse sdist-only).
- `npm install -g <pkg>` / `npm i -g <pkg>` → `{pm: "npm", pkg, binary: resolveNpmBinary(pkg)}`.
- `yarn global add <pkg>` / `pnpm add -g <pkg>` → normalize to `npm` shape.
- `go install <module>@latest` → `{pm: "go", module, binary: deriveBinaryName(module)}`.
- Anything else → `{error: "unparseable_install_command"}`.
- `discover-binary.ts` chain (each step bounded ≤2 s, total ≤8 s):

1. **Direct binary URL.** If pasted URL ends in `.tar.gz`/`.tar.xz`/`.zip`/`.exe` OR HEAD returns a binary Content-Type
   → `{pm: "direct", url, binary: deriveFromUrl}`.

   **Step 0.5 — discovery-hints lookup (NEW per gate F1).** Before step 2, check `dist/discovery-hints-index.json` for
   an `owner/repo` match. Hit → return the hint's `{pm, package, binary}` directly; the install command is well-known
   (we curated it) and short-circuits the live-discovery chain. Miss → fall through to step 2. This absorbs known
   false-negatives (Aider, OpenHands, Sherlock) where ecosystem metadata is incomplete or non-canonical.

2. **GitHub Releases API.** `GET https://api.github.com/repos/<owner>/<repo>/releases/latest`. Find an asset matching
   `<repo>` ± platform suffix (`-x86_64-unknown-linux-musl`, `-linux-x86_64`, `-amd64-linux`, etc.). If found → `{pm:
   "direct", url: asset.browser_download_url, binary: <repo>}`.
3. **Common distribution lookup.** Parallel-fetch (each predicate REQUIRES repository-field match against
   `https://github.com/<owner>/<repo>` — case-insensitive substring — to prevent cross-registry name collisions per gate
   F1; without this U4 produces *wrong-answer* failures, not just *missed-opportunity* bounces, and violates R9):

- `https://formulae.brew.sh/api/formula/<repo>.json` — 200 AND `formula.homepage` or `formula.urls.stable.url`
  references the GitHub repo → brew install path.
- `https://crates.io/api/v1/crates/<repo>` — 200 AND `crate.repository` references the GitHub repo AND
  `crates.io/api/v1/crates/<repo>/<max_stable_version>` returns non-empty `version.bin_names` → cargo binstall path.
- `https://registry.npmjs.org/<repo>/latest` — 200 AND `package.bin` is non-empty AND `package.repository.url`
  references the GitHub repo → npm path.
- `https://pypi.org/pypi/<repo>/json` — 200 AND `info.urls` includes a `bdist_wheel` entry AND `info.home_page` or any
  value in `info.project_urls` references the GitHub repo → pip path.
- `https://proxy.golang.org/<owner>/<repo>/@latest` — 200 → go install path. (Path is `<owner>/<repo>`-keyed by
  construction; no extra match needed.)

  First hit wins (by registry priority: brew → cargo → npm → pip → go).

1. **README parse.** `GET https://raw.githubusercontent.com/<owner>/<repo>/HEAD/README.md` (try `main`, then `master`,
   then default-branch via API). Find first fenced code block whose first non-comment line matches one of the
   install-command shapes above AND whose package name matches `<repo>` (case-insensitive, hyphen/underscore
   normalized). If found → delegate to `parse-install.ts`.
2. None of 0.5-4 → `{error: "chain_no_resolve"}` → 404 with R9's CTA. (Renamed from `no_installable_binary` per gate F4
   — distinguishes chain-time exhaustion from install-time failures emitted by U6.)

- `registry-lookup.ts`: takes a `ValidatedInput` and checks `registry-index.by_slug`, `registry-index.by_owner_repo`,
  AND `discovery-hints-index.by_owner_repo`. Returns the registry entry if hit (triggers R2 fast-path), the hint if hit
  (triggers U6 sandbox path with the hint's `{pm, package, binary}` pre-resolved); else null (proceeds to U4 live
  discovery). Order matters: registry-fast-path > hint > live discovery. Committed scorecards always win over hints
  (avoids drift); hints always win over live discovery (we curated them because live discovery was wrong).

**Patterns to follow:**

-

[docs/solutions/best-practices/rust-url-validation-https-only-with-localhost-exception-2026-04-20.md](../solutions/best-practices/rust-url-validation-https-only-with-localhost-exception-2026-04-20.md)
— URL validation rules. ASCII-only host check. RFC1918 + link-local + cloud-metadata + IPv6 ULA reject.

**Test scenarios:**

- **Happy path (slug):** input `"ripgrep"` → `{kind: "slug", slug: "ripgrep"}`; registry hit → triggers theater path.
- **Happy path (install command):** input `"brew install ripgrep"` → `{pm: "brew", pkg: "ripgrep", binary: "ripgrep"}`.
- **Happy path (GitHub URL, registry hit):** input `"https://github.com/BurntSushi/ripgrep"` → registry hit by
  `owner/repo` → triggers theater path.
- **Happy path (GitHub URL, releases hit):** input is a non-registry repo with releases → step 2 finds an asset → `{pm:
  "direct", url: ...}`.
- **Happy path (GitHub URL, brew hit):** non-registry repo with a brew formula matching the repo name → step 3 brew hit.
- **Happy path (GitHub URL, README parse):** non-registry repo with README install block → step 4 hit.
- **Edge case (install command shorthand):** `"brew ripgrep"` → same as `"brew install ripgrep"`.
- **Edge case (GitHub URL with `.git`):** stripped, normalized.
- **Edge case (GitHub URL with branch path `/tree/main`):** rejected as `invalid_url` — only repo root URLs.
- **Error path (non-HTTPS URL):** rejected.
- **Error path (non-github.com URL):** rejected.
- **Error path (RFC1918 / localhost / cloud-metadata):** rejected.
- **Error path (homoglyph host `gіthub.com` Cyrillic 'і'):** rejected by ASCII-only host check.
- **Error path (unparseable install command):** `"yum install foo"` → `{error: "unparseable_install_command"}`.
- **Error path (GitHub URL, all discovery steps miss):** `{error: "chain_no_resolve"}` with R9 CTA.
- **Happy path (hint hit):** input `https://github.com/Aider-AI/aider` → step 0.5 finds hint → returns `{pm: "pip",
  package: "aider-chat", binary: "aider"}` without firing steps 2-4.
- **Edge case (hint miss + chain hit):** input `https://github.com/<unknown-but-cargo-binstallable>` → step 0.5 miss →
  step 3 fires.
- **Edge case (hint with cross-registry name collision target):** hint for `spf13/cobra` → returns the hint's payload,
  never queries crates.io. Validates that hints fully short-circuit step 3 (proves hints fix F1's wrong-answer class).
- **Integration:** `discover-binary.ts` mocked via `vi.mock(globalThis.fetch)` returning canned responses for each step;
  assert the correct step fires and the chain short-circuits on the first hit.
- **Integration (F1 tightening — repository-field match):** mock crates.io `<repo>` returning a 200 whose
  `crate.repository` does NOT include the input GitHub repo (the `cobra` collision case) → step-3-crates rejects, chain
  continues to step 4.
- **Integration (F1 tightening — bin-target check):** mock crates.io `<repo>/<version>` returning empty `bin_names` (the
  library-only `ratatui` case) → step-3-crates rejects, chain continues.

**Verification:** All test scenarios pass. Validation matrix is exhaustive (every input shape from R1 has a test).
Discovery chain short-circuits correctly. Bounce-out errors carry R9's CTA shape.

---

- U5. **Worker `/api/score` route + rate limit + content negotiation + response shape**

**Goal:** Wire `/api/score` into `src/worker/index.ts`. Coordinate the input classifier (U4) → registry lookup (U4) →
rate limiter → R2 cache (U7) → DO route (U6). Apply content negotiation. Shape the response with the SoT triad.

**Requirements:** R6, R7, R10, R11.

**Dependencies:** U1 (registry index), U3 (bindings), U4 (input parser).

**Files:**

- Modify: `src/worker/index.ts`
- Create: `src/worker/score/handler.ts`
- Create: `src/worker/score/content-negotiation.ts`
- Create: `src/worker/score/response-shape.ts` (also owns `ScoreError` discriminated union; see Approach)
- Create: `src/worker/score/turnstile.ts` (siteverify wrapper; reads `env.TURNSTILE_SECRET`)
- Create: `src/worker/score/session.ts` (signed `__Host-anc-session` cookie issue/parse; HMAC via
  `env.SESSION_HMAC_SECRET`)
- Create: `src/worker/score/kill-switch.ts` (KV lookup of `scoring_disabled`; cached in-memory per Worker invocation)
- Create: `src/worker/spec-version.gen.ts` (build-emitted; placeholder file lands in U5, build wiring lands in U8)
- Modify: `wrangler.jsonc` — add `kv_namespaces: [{ binding: "SCORE_KV", id: "<id>" }]` (prod + staging) for the
  `scoring_disabled` flag. Add ratelimit namespace for the per-IP coarse fallback. Add `TURNSTILE_SECRET` and
  `SESSION_HMAC_SECRET` as `wrangler secret put` entries (NOT in the committed config) — both are operator-managed via
  1Password per the secrets policy.
- Modify: `src/worker/score/registry-lookup.ts`, `src/worker/score/validate.ts`, `src/worker/score/parse-install.ts`,
  `src/worker/score/discover-binary.ts` (U4 shipped code) — migrate hand-rolled error returns to import + return
  `ScoreError` from `response-shape.ts`. Mechanical change; tests should keep passing because the on-the-wire shape
  stays compatible (codes unchanged, just typed).
- Modify: `src/worker/headers.ts` (extend JSON branch to match `/api/` paths if needed)
- Modify: `src/worker/accept.ts` (extend preference list to `['text/html', 'application/json', 'text/markdown']`; use
  the existing `accepts` package or a proper q-value parser per `accept-header-q-value` learning, NOT substring
  matching)
- Test: `tests/worker.test.ts` (extend with `/api/score` describe block; MUST include q-value test: `Accept:
  text/markdown;q=0.1, application/json;q=0.9` resolves to JSON, not markdown — guards against substring matching
  regression per `accept-header-q-value` learning)
- Test: `tests/score-handler.test.ts`
- Test: `tests/score-response-shape.test.ts` (MUST exercise every variant of `ScoreError` discriminated union;
  TypeScript exhaustiveness check via `assertNever` on the union ensures no code path can return an unknown error shape)

**Approach:**

- In `src/worker/index.ts.fetch`, add path-prefix branch above the asset call:

  ```ts
  if (pathname.startsWith('/api/score')) return handleScore(request, env);
  ```

  Asset-first invariant for everything else preserved.
- `handler.ts` orchestrates:

1. Validate input (U4).
2. Registry-lookup (U4). Hit → fetch committed scorecard via `env.ASSETS`, shape response, return (theater handled
   client-side; no server-side delay).
3. **In-Worker KV `scoring_disabled` kill-switch check.** Read `env.SCORE_KV.get("scoring_disabled")`. If truthy, return
   503 with `Retry-After: 3600`. Cheap, fast, operator-flippable in seconds via `wrangler kv:key put`. Per the Cost
   ceiling and abuse mitigation section.
4. **Turnstile siteverify** (per Q4.1 follow-up + spike 04). The U8 form sends a `turnstile_token` in the request body.
   POST it to `https://challenges.cloudflare.com/turnstile/v0/siteverify` with the secret key from
   `env.TURNSTILE_SECRET`; 400 with `{error: "turnstile_failed"}` on failure. On success, set a signed session cookie
   (`__Host-anc-session`, HttpOnly, Secure, SameSite=Lax, ~1h TTL) bound to the verified Turnstile result.
5. **Rate-limit check (rekeyed per Q4.2 follow-up + spike 04).** Compute the limiter key as
   `<session-cookie>:<sha256(input)>` (NOT raw IP). Call `env.SCORE_LIMITER.limit({key})`. Miss → 429 with
   `Retry-After`, `X-Max-Assessments`, `X-Current-Assessments`. Effect: same-tool requests inside one session don't burn
   budget (cache-friendly); new sessions require a Turnstile solve. Keep a coarse per-IP fallback ratelimit (e.g.
   30/60s) in a separate ratelimit namespace as a safety net for sessions that swap cookies.
6. R2 cache lookup (U7). Hit → shape response, return.
7. R2 miss → DO route (U6).
8. Always: `?fromCache=false` query param skips R2 read but does not skip R2 write.

- `content-negotiation.ts` extends `accept.ts`. New helper: `detectScorePreference(request)` returns `'json' |
  'markdown'`. JSON is default; markdown when `Accept: text/markdown` OR `.md` suffix.
- `response-shape.ts`: `shapeScoreResponse(scorecard, env): Response` — adds `spec_version` (from `SPEC_VERSION` build
  constant for live; from cached scorecard for cache hits), `anc_version` (from cache or live exec), `checker_url`
  (constant `https://anc.dev/score`). Asserts all three present; throws (→ 500) if any missing.
- `response-shape.ts` also owns the **`ScoreError` discriminated union** — single source of truth for every error code
  the `/api/score` endpoint can return. U4, U5, U6 import this type; nobody hand-rolls error response shapes. The U9
  contract test enforces runtime conformance. Decided 2026-05-07.

  ```ts
  export type ScoreError =
    | { code: "invalid_url"; details: string; cta_text: string }
    | { code: "unparseable_install_command"; details: string; cta_text: string }
    | { code: "chain_no_resolve"; cta_text: string }
    | { code: "discovery_redirect_loop"; cta_text: string }
    | { code: "rate_limited"; retry_after: number; cta_text: string }
    | { code: "install_unsupported"; pm: "brew" | "go-compile-only"; cta_text: string }
    | { code: "chain_resolved_install_failed"; details: string; cta_text: string }
    | { code: "chain_resolved_no_binary_produced"; details: string; cta_text: string }
    | { code: "timeout"; phase: "install" | "score"; cta_text: string };

  export type ScoreErrorResponse = { error: ScoreError; spec_version: string; checker_url: string };
  ```

  HTTP status mapping is handled in `handler.ts`: 400 for input errors, 404 for chain_no_resolve, 429 for
  rate_limited, 502 for install/binary failures, 504 for timeout, 500 for triad-missing.
- Headers inline:
- Live JSON response: `Cache-Control: no-store`, `application/json; charset=utf-8`, `Access-Control-Allow-Origin: *`,
  `X-Robots-Tag: noindex`.
- Cache-hit JSON response: `Cache-Control: public, max-age=300`, same other headers.

**Patterns to follow:**

- `src/worker/index.ts` branch shape (asset-first invariant).
- `src/worker/headers.ts` JSON branch (already covers `*.json` paths; extend `isJson()` to match `/api/score` and
  `/api/score.json`).
-

[docs/solutions/best-practices/triple-emit-content-negotiation-rename-safe-2026-04-29.md](../solutions/best-practices/triple-emit-content-negotiation-rename-safe-2026-04-29.md)
— `.json` paths bypass MD rewrite. `/api/score` ALSO bypasses MD rewrite (returns JSON unconditionally even for `Accept:
text/markdown`); `/api/score.md` is the explicit markdown twin.

**Test scenarios:**

- **Happy path (registry hit):** `POST /api/score {input: "ripgrep"}` → 200, scorecard matches
  `dist/scorecards/ripgrep-v<v>.json`, response includes `spec_version` + `anc_version` + `checker_url`.
- **Happy path (R2 hit):** registry-miss but cache-hit → 200, sub-100 ms in test.
- **Happy path (R2 miss):** registry-miss + cache-miss → DO route stub asserts called.
- **Happy path (markdown):** `GET /api/score.md` or `Accept: text/markdown` → markdown response with same triad.
- **Happy path (JSON):** `GET /api/score.json` → JSON, even with `Accept: text/markdown`.
- **Edge case (`?fromCache=false`):** bypasses R2 read.
- **Error path (rate-limited):** 11th request in 60 s → 429 with `Retry-After: 60`.
- **Error path (validation fail from U4):** 400 with details.
- **Error path (response missing triad):** 500 with `{error: "incomplete_response_contract"}` — never silently emit a
  partial response.
- **Integration:** response headers include CORS `*`, `noindex`, correct `Cache-Control` for live vs cached.
- **Integration:** existing 27 CN tests still pass after preference list extension.

**Verification:** All test scenarios pass. Asset-first invariant preserved (existing `tests/worker.test.ts` cases
unmodified). Triad enforcement is a hard gate, not a code-review check.

---

- U6. **Sandbox-side: install + score (two-phase egress, anc check)**

**Goal:** Implement the Sandbox DO class and the install + score flow. Two-phase egress is mandatory (R7). Pool of
short-lived containers (per design Premise #6, evolved from singleton to 10-instance pool to absorb Show HN spike).

**Requirements:** R4, R7, R11 (anc_version captured at exec time).

**Dependencies:** U2 (image), U3 (bindings), U4 (input → install spec), U5 (Worker routes to DO).

**Files:**

- Create: `src/worker/score/do.ts` (Sandbox DO class extending the SDK base + brew/go discovery-fallback helpers)
- Create: `src/worker/score/sandbox-exec.ts` (orchestration + per-PM install table)
- Modify: `docker/sandbox/Dockerfile` — `EXPOSE 8080` required for any container binding (wrangler 4.x `dev --local`
  rejects bindings whose Dockerfile declares zero EXPOSE directives, otherwise `deep-check.yml` errors with `The
  container "Sandbox" does not expose any ports`). Port 3000 is reserved for the SDK's internal Bun server; do not
  reuse.
- Test: `tests/score-do.test.ts` (unit tests with stubbed `Container` + `getSandbox`). MUST include: (a) static
  `Sandbox.outboundHandlers` map has both `allowedInstall` and `noHttp` keys before any `setOutboundHandler` call —
  catches misnamed-key regressions silently degrading egress policy; (b) order assertion via stubbed handler call log —
  `setOutboundHandler("allowedInstall", {...})` fires BEFORE `exec(installCmd)` AND `setOutboundHandler("noHttp")` fires
  BEFORE `exec("anc check ...")`; (c) per-request log lines emitted by handlers match expected `{phase, host,
  allowed|blocked}` shape (the per-request observability that justified Pattern Y).
- Test: `tests/score-do-brew-fallback.test.ts` (brew formula → discoverBinary redirect path).
- Test: `tests/score-do-go-fallback.test.ts` (go module → discoverBinary redirect path).
- Modify: `tests/score-handler.test.ts` — DO mock typed via `Sandbox['fetch']` so any future Sandbox class that loses or
  renames `fetch` is a TypeScript error here, not a first-deploy 5xx. Driven by PR #94 (the U5-era stub returned JSON
  directly from a `.fetch()` mock that bypassed the binding-boundary check, masking the fact that the real DO at
  `src/worker/score/do.ts` had no `fetch()` method — production threw `Handler does not export a fetch() function` (CF
  error 1101) on first POST).

**Image (debian-trixie-slim + glibc):**

- Base: `cloudflare/sandbox:0.9.2` (bare/glibc; same major version as the prior Alpine staging) on `debian:trixie-slim`.
  Both pinned by sha256 digest.
- Package managers: `cargo-binstall` (gnu variant) and `anc` (gnu variant from agentnative-cli releases) installed via
  pinned tarballs. `python3-pip`, `npm`, plus archive tools (`bzip2`, `unzip`, `xz-utils`) installed via `apt-get`.
- Native `bun` (`bun-linux-x64.zip`) and `uv` (`uv-x86_64-unknown-linux-gnu.tar.gz`) installed via pinned tarballs.
- Upstream Go from `go.dev/dl` (pinned by sha256). Debian's `golang-go` package ships `CGO_ENABLED=0`, which silently
  disables `GODEBUG=netdns=cgo` and forces Go onto its pure-Go resolver (which bypasses `/etc/gai.conf`); upstream Go
  has cgo enabled by default.
- Container network fixes: uncomment IPv4-mapped precedence in `/etc/gai.conf` (CF Containers' outbound IPv6 is
  unreliable; Rust HTTP clients, libcurl, and Go's cgo resolver otherwise hang on the AAAA-first attempt). `ENV
  GODEBUG=netdns=cgo` so Go honors the precedence.
- Install-destination consistency: `ENV BUN_INSTALL=/usr/local` and `ENV UV_TOOL_BIN_DIR=/usr/local/bin` send every PM's
  binaries to `/usr/local/bin`, matching the per-command `cargo-binstall --install-path` and `GOBIN` flags. The
  post-install `which <binary>` gate finds binaries in one canonical place regardless of which PM installed them.
- Brew is OMITTED. Linuxbrew on Linux takes 20-60 s per install for typical formulae; complex formulae exceed the 60 s
  install + score budget. `brew install <pkg>` user input is translated to an alternative PM via the discovery-fallback
  in `do.ts:resolveSpec()` (see Approach below).
- NO COMPILERS. No `build-essential`, no `gcc`, no Rust toolchain. Install paths are: cargo binstall (precompiled), pip
  (wheels only via `--only-binary=:all:`), uv (uses its own resolver, binary-preferring), npm + bun
  (`--ignore-scripts`), direct (binary tarball or zip from a URL), go (redirected to a GitHub release binary by the go
  discovery-fallback, never a source compile).
- Image budget: ≤350 MB compressed.

**Approach:**

- `do.ts`: Sandbox DO class extends the Sandbox base class. Pool selection: `getRandom(env.SCORE, 10)` in `handler.ts`
  (10-instance pool sized for Show HN absorbance; same `basic` instance per pool entry). Declares two inline async
  handlers as a static `outboundHandlers` map (Pattern Y; see K-decision for the X/Y/Z comparison):

- `allowedInstall(req, env, ctx)` — checks `ctx.params.allowedHostnames`, passes through via `fetch(req)` or returns
    403; logs every request with `{phase, host, allowed}` for security observability.
- `noHttp(req)` — returns 403 for every request; logs `{phase: "noHttp", host, blocked: true}`. These are inline
    functions in the same Worker bundle, not separate Workers and not service bindings; no `wrangler.jsonc` change
    needed beyond the existing DO + Container + R2 + ratelimits.

- `do.ts:resolveSpec()` translates user input to an `InstallSpec` before `score()` runs. Three input kinds:

1. `install-command` with `pm: 'brew'` — call `resolveBrewFallback(pkg)`: fetch the formula metadata from
     `formulae.brew.sh`, parse the homepage as a GitHub URL, run the existing `discoverBinary` chain. If discovery
     returns a non-brew spec, install that. If discovery misses OR the formula's homepage isn't on github.com OR the
     formula 404s, bounce as `install_unsupported pm=brew_only`.
2. `install-command` with `pm: 'go'` — call `resolveGoFallback(modulePath)`: parse `github.com/<owner>/<repo>` from the
     module path (subpath segments stripped), run `discoverBinary`. If the resolution is non-go (typically `direct` from
     a GitHub release asset, e.g. glow → `glow_*_Linux_x86_64.tar.gz`), install that. Modules outside `github.com`
     (rsc.io/quote, golang.org/x/…) OR github repos without release binaries bounce as `install_unsupported
     pm=go_no_binary`. Fast-fail UX; no source compile ever runs.
3. All other `install-command` inputs and `github-url` inputs flow through the install table directly.

- `sandbox-exec.ts:score()` orchestrates per request:

1. Determine `installHosts` from `installSpec.pm` (e.g., `cargo-binstall` → `["crates.io", "static.crates.io",
     "index.crates.io", "github.com", "*.githubusercontent.com", …]`; `direct` → host of the URL, expanded to
     `GITHUB_RELEASE_HOSTS` when the URL points at github.com so curl can follow the 302 redirect chain).
2. Phase 1 egress: `sandbox.setOutboundHandler<{ allowedHostnames }>('allowedInstall', { allowedHostnames })`.
3. Run install command, captured by `installSpec.pm`:

- `cargo binstall --no-confirm --no-symlinks --install-path /usr/local/bin <pkg>` (cargo-binstall standalone; no `cargo`
       CLI in image)
- `pip install --only-binary=:all: --no-cache-dir --break-system-packages <pkg>` (wheels only — refuses sdist arbitrary
       code; `--break-system-packages` overrides Debian's PEP 668 refusal)
- `uv tool install <pkg>` (native uv; uses its own resolver, sidesteps pip's PEP 658 metadata fast-path)
- `npm install -g --ignore-scripts <pkg>` (skips pre/install/post lifecycle scripts; keeps Phase 1 egress from being
       abused before the Phase 2 lockdown fires)
- `bun add -g --ignore-scripts <pkg>` (same lifecycle-script discipline as npm)
- `direct`: extension-dispatched download + extract. The shell pipeline downloads to a per-invocation `mktemp -d` tmp
       dir, extracts (`tar xzf` for `.tar.gz`/`.tgz`, `tar xJf` for `.tar.xz`, `tar xjf` for `.tar.bz2`, `unzip -q` for
       `.zip`), then `find -type f -name <binary> -perm /111 -print -quit` locates the binary inside the (possibly
       nested) archive layout. `install -m 0755 "$found" /usr/local/bin/<binary>` deposits the binary in the canonical
       location. The whole pipeline runs in a `( set -e; … )` subshell so a failure exits the subshell, not the
       persistent container shell (the latter would produce `SessionTerminatedError` 1101 for every subsequent request
       routed to the affected DO instance).
- `brew` and `go` return `null` from `installCommandFor()`; the discovery-fallbacks in `resolveSpec` translate upstream
       of this layer. Hitting either case here is a contract violation and bounces as `install_unsupported
       pm=<brew|go>`.

1. Verify binary on `PATH`: `which <binary>` returns 0; otherwise fail with `chain_resolved_no_binary_produced` (gate F4
     distinguishes "install succeeded but produced no runnable binary" from "install command itself failed"). Common
     trigger: chain resolved to a library-only pypi package (e.g. Click ships wheels but no `console_scripts` entry).
2. Phase 2 egress: `sandbox.setOutboundHandler('noHttp')` — routes all subsequent requests to the user-defined `noHttp`
     handler (returns 403 for any HTTP egress).
3. `sandbox.exec("anc --version")` → capture `anc_version` (parsed from stdout).
4. Look up registry entry by tool name to get `audit_profile` if known; else omit.
5. `sandbox.exec("anc check --command <binary> --output json [--audit-profile <p>]")` → parse JSON.
6. Return `{scorecard, anc_version}` to the Worker. DO writes-through to R2 via U7.

- Total budget: 60 s timeout on `sandbox.exec()` (install + score combined). Hard fail beyond returns 504 to user.
- Per-instance container is short-lived; the SDK serializes `exec()` calls within an instance. The 10-instance pool
  absorbs concurrent load by spreading requests across distinct containers via `getRandom`.

**Patterns to follow:**

-
  [docs/solutions/architecture-patterns/cf-sandbox-secure-cli-execution-2026-04-17.md](../solutions/architecture-patterns/cf-sandbox-secure-cli-execution-2026-04-17.md)
  — two-phase egress design.
-
  [docs/solutions/architecture-patterns/anc-cli-output-envelope-pattern-2026-04-29.md](../solutions/architecture-patterns/anc-cli-output-envelope-pattern-2026-04-29.md)
  — anc JSON envelope shape; pass-through verbatim.

**Test scenarios:**

- **Happy path (cargo binstall):** install spec `{pm: "cargo-binstall", pkg: "ripgrep"}` → install succeeds → score
  succeeds → JSON returned with `anc_version` populated.
- **Happy path (uv tool install):** `{pm: "uv", pkg: "black"}` → wheel install via uv → scored.
- **Happy path (bun add -g):** `{pm: "bun", pkg: "prettier"}` → npm-registry install → scored.
- **Happy path (direct binary download, flat archive):** `{pm: "direct", url:
  "https://github.com/.../tool-x86_64-unknown-linux-musl.tar.gz", binary: "tool"}` → tarball downloaded, extracted,
  scored.
- **Happy path (direct binary download, nested archive):** csvlens-style `csvlens-x86_64-unknown-linux-musl/csvlens`
  layout extracts via `find -name csvlens` and installs to `/usr/local/bin/csvlens`.
- **Happy path (brew via fallback):** `brew install bat` → discoverBinary picks a non-brew spec → installed and scored.
- **Happy path (go via fallback):** `go install github.com/charmbracelet/glow@latest` → discoverBinary picks the GitHub
  release asset → installed via `direct` → scored. No source compile runs.
- **Edge case (`audit_profile` from registry):** known tool → `anc check --audit-profile <profile> ...` invoked.
- **Bounce (brew formula has no peer PM):** `brew install <fake>` → `install_unsupported pm=brew_only`.
- **Bounce (go module without GitHub release binary):** `go install rsc.io/quote/v3@latest` → `install_unsupported
  pm=go_no_binary`.
- **Bounce (install command fails):** sandbox returns non-zero from install; DO returns `chain_resolved_install_failed`
  with details; Worker returns 502.
- **Bounce (binary not on PATH after install):** `which` check misses; DO returns `chain_resolved_no_binary_produced`;
  Worker returns 502. (The `pallets/click` failure mode — wheel installs cleanly but no `console_scripts` entry.)
- **Error path (anc check exits non-zero):** preserve and forward the parsed error JSON if available.
- **Error path (60 s timeout):** DO returns `{error: "timeout"}`; Worker returns 504.
- **Error path (`setOutboundHandler` call fails):** DO returns 500; user-visible error message scrubs internals.
- **Integration:** assert egress ordering: `setOutboundHandler('allowedInstall', ...)` fires BEFORE install exec, AND
  `setOutboundHandler('noHttp')` fires BEFORE `anc check` exec. Safety invariant.
- **Integration:** stdout/stderr captured by `sandbox.exec` does not contain any host name from outside `installHosts ∪
  {"localhost"}` after Phase 2 (defense in depth).
- **Integration:** response includes `anc_version` populated from the running binary (not from a constant).
- **Integration (CI):** `.github/workflows/deep-check.yml` runs to green. Both jobs (`e2e` and `lhci`) start `wrangler
  dev --local` as the test webServer; the Dockerfile's `EXPOSE 8080` lets `wrangler dev` accept the container binding.

**Verification:** Two-phase egress is provably enforced (test asserts the second handler call is `noHttp` BEFORE `anc
check` is exec'd). Timeout is honored. `anc_version` is captured live, never hard-coded. `deep-check.yml` is green on
the U6 merge SHA. Staging end-to-end matrix passes 11/11 across all PMs (npm, cargo, pip, uv, bun, go-fallback,
brew-fallback, direct in flat + nested archive layouts, and the two intentional bounces).

---

- U7. **R2 cache (read on hit, write on miss)**

**Goal:** R2 read on every cache-fast-path; R2 write on every successful sandbox round-trip. Key shape includes
`anc_version` for auto-invalidation.

**Requirements:** R5, R12 (repeat runs ~free).

**Dependencies:** U3 (R2 binding), U6 (DO produces scorecard).

**Files:**

- Create: `src/worker/score/cache.ts`
- Modify: `src/worker/score/sandbox-exec.ts` (write-through after success — one-line addition)
- Test: `tests/score-cache.test.ts`

**Approach:**

- `get(key)`: `await env.SCORE_CACHE.get(key, "json")`. Null → miss. Validate that the cached payload includes
  `spec_version`, `anc_version`, `tool_version`; if any missing, treat as miss + log (corrupted cache entry, best-effort
  delete).
- `put(key, scorecard, ancVersion, toolVersion)`: refuse if `ancVersion` or `toolVersion` is missing (fail-fast — never
  cache half-state). Store as JSON with `httpMetadata.contentType: application/json`, `cacheControl: "public,
  max-age=86400, s-maxage=86400"`. Write is best-effort: failure logs but does not fail the user response.
- Key: `scores/{tool-slug}/{anc-version}/{tool-version}.json` where `tool-version` is the version reported by the binary
  after install (or a 7-char SHA for direct-binary downloads where there's no semver).
- `?fromCache=false` query bypasses read but still writes (so the next request benefits).
- Smart Tiered Cache enables sub-50 ms cache hits at the edge for R2 origins (auto-enabled since 2024-11-20); no
  explicit configuration needed.

**Patterns to follow:**

-

[docs/solutions/best-practices/versioned-scorecard-filenames-and-non-github-registry-2026-04-20.md](../solutions/best-practices/versioned-scorecard-filenames-and-non-github-registry-2026-04-20.md)
— anc-version in key for auto-invalidation; refuse to cache if version missing.

- [docs/research/2026-04-28-cloudflare-live-scoring-v2.md](../research/2026-04-28-cloudflare-live-scoring-v2.md) §7 — R2
  caching strategy.

**Test scenarios:**

- **Happy path:** write then read → matches.
- **Happy path:** read on miss → null.
- **Edge case:** `anc-version` change → cache miss for old key (assert via stubbed env).
- **Edge case:** corrupted cache entry (missing `anc_version` in payload) → treated as miss + log + best-effort delete.
- **Error path:** R2 write fails (network) → DO logs but does not fail the request — user still gets a result.
- **Error path:** `put` called with missing `ancVersion` → throws (caller bug).
- **Integration:** full round-trip — first request misses cache, sandbox runs, writes; second identical request hits
  cache, no sandbox spawn, sub-100 ms total.

**Verification:** Cache hits eliminate sandbox spawns for repeat queries. R2 write failures do not block user responses.
Key shape includes `anc-version`. Refusal-to-cache-half-state is enforced.

---

- U8. **Homepage live-scoring form + Turnstile + summary+top-3 render + install-anc CTA**

**Goal:** A live-scoring paste-input form embedded on the homepage (`/`, NOT a dedicated `/score` subpage) with
invisible Turnstile gate, theater spinner, summary + top-3 issues result render, and prominent install-anc-locally CTA.
Build also emits `src/worker/spec-version.gen.ts` constants. No markdown twin: live-scoring is HTML-only because agents
already have `anc check` locally and don't need a Worker round-trip; `/index.md` stays silent on the feature.

**Scope change (2026-05-14, per Q4.1 follow-up):** the form lives on the homepage rather than a dedicated `/score` page.
This pulls the live demo into the highest-traffic surface and removes one layer of navigation from the share loop. Two
consequences ripple: (1) Turnstile must use invisible mode + lazy-load on form interaction so visitors who never engage
the form don't pay a script-load cost; (2) result presentation is an open design question (see below).

**Requirements:** R1 (input), R9 (CTA primary). R10 (markdown twin) is no longer in scope for this feature surface.

**Dependencies:** U5 (`/api/score` exists and returns scorecards), U4 (validation surfaces error shapes for inline
errors).

**Files:**

- Modify: `src/build/build.mjs` (homepage now renders the form section in addition to the existing hero + 8 principle
  cards; add spec-version-gen.mjs call)
- Create: `src/build/spec-version-gen.mjs` (emits `src/worker/spec-version.gen.ts`)
- Create: `src/client/live-score.ts` (form submit + fetch + theater + render; lazy-loads the Turnstile script on first
  form interaction — focus / click / paste on the input)
- Create: `src/worker/score/summary-render.ts` (server-side `buildScoreSummaryBody`; reused by client via shared module)
- Modify: `src/build/shell.mjs` (or wherever the CSP `<meta http-equiv="Content-Security-Policy">` / response-header CSP
  is set) — extend `script-src`, `frame-src`, and `connect-src` to allow `challenges.cloudflare.com`
- Modify: homepage source (e.g., `content/index.md` or whatever drives `/`) — add the form section markup; placement on
  the page is a design decision deferred to implementation (likely between hero lede and the 8 principle cards, or below
  the cards)
- Test: `tests/e2e/homepage-score.e2e.ts` (Playwright, chromium project; supersedes the prior `tests/e2e/score.e2e.ts`)
- Test: `tests/e2e/homepage-score-live.e2e.ts` (opt-in live sandbox project, excluded from default suite)

**Execution note:** Defer wireframe-level layout decisions to `/design-review` after the basic form renders. Initial
implementation reuses the existing per-tool scorecard page header/score/issues blocks for the result.

**Approach:**

- **Form placement on `/`.** Single text input + submit, embedded as a new section on the homepage. Two candidate
  positions (decision deferred to implementation + design review): (a) between the hero lede and the 8 principle cards —
  pulls the demo above the fold; or (b) below the cards — preserves the principle-first reading order. Either way, the
  form is content-page-embedded, not a standalone subpage. Examples shown below the input as clickable chips: `ripgrep`,
  `brew install bat`, `https://github.com/cli/cli`. Below input: hidden progress timeline (4 steps: validate → resolve →
  install → score) that fills in for live runs. Below: result area (see "Result presentation" below).
- **CTA framing.** Adjacent to (or above) the form, render the install-anc CTA: "Install `anc` and run it in your
  project for source + project depth: `brew install agentnative` or `cargo install agentnative`. The web demo shows
  binary/behavioral checks only." R9 framing. Exact placement is a design decision; the install-anc-locally framing must
  remain primary, not buried below the form.
- **Turnstile integration (invisible mode + lazy-load, per spike 04 + Q4.1 follow-up).** Use Cloudflare Turnstile in
  Invisible mode (no visible widget; JS API only) — appropriate for an embedded form on a content page. Do NOT load the
  Turnstile script (`https://challenges.cloudflare.com/turnstile/v0/api.js`) on every homepage visit. Lazy-load on first
  form interaction (focus / click / paste on the input). Visitors who scroll past the form never load Turnstile at all.
  On submit, render the invisible widget, await its token, send the token in the `/api/score` request body (Worker-side
  `siteverify` happens in U5). Free tier covers 1M challenges/month per <https://developers.cloudflare.com/turnstile/>.
- **CSP update (REQUIRED).** Wherever CSP is set (`src/build/shell.mjs` or Worker response headers — verify during
  implementation), extend it to allow Turnstile:

  ```text
  script-src 'self' challenges.cloudflare.com;
  frame-src challenges.cloudflare.com;
  connect-src 'self' challenges.cloudflare.com;
  ```

  Without these, the lazy-loaded script + the widget iframe + the siteverify XHR all break. Add a Playwright
  regression that asserts the homepage CSP header / meta contains `challenges.cloudflare.com` in all three directives.
- **Client JS.** On submit, `Promise.all([fetch('/api/score', {method:'POST', body:{input, turnstile_token}}), new
  Promise(r => setTimeout(r, 2000))])`. Minimum 2s spinner per the cached-theater pattern.
- **For live runs: progress polling.** DO writes session state to R2 under `sessions/{sessionId}.json`. Client polls
  `/api/score?session=<id>` every 2s. Initial implementation: client-side fake-progress timer is acceptable while real
  polling is wired up.
- **Result presentation (OPEN U8 question).** Three candidate shapes; decision deferred to implementation + design
  review. Each has a different trade-off for share-ability vs. embedded-form simplicity:

1. **Inline replacement of the form area.** Result renders in place of the form; user clicks "Score another" to reset.
   Simplest; preserves homepage scrolling; result is not directly URL-shareable.
2. **Modal overlay.** Result opens as a modal on top of the homepage; closing returns to the form. Slightly more
   theatrical; result still not URL-shareable; introduces modal accessibility surface (focus trap, ESC dismiss).
3. **Redirect to `/score/<session-id>` for shareable result URLs.** Reintroduces a subpage (only for results, NOT the
   form). Result is URL-shareable, which directly serves the viral-share goal of v3. Trade-off: extra route to build +
   cache-bust strategy + open question of how long results live. Pick during U8 implementation; the answer determines
   whether `summary-render.ts` is invoked from a Worker route (option 3) or from the client only (options 1, 2).

- **`summary-render.ts`:** new function `buildScoreSummaryBody(scorecard, topIssues)` reuses `buildScorecardHeader`,
  `buildScoreBadge`, the existing top-issues block — and SKIPS `<section class="scorecard-checks">` and `<section
  class="scorecard-meta">`. Below the top-3 issues block, append a CTA card: "Run `anc check .` locally for source +
  project checks (`brew install agentnative` or `cargo install agentnative`)."
- **Bounce-state CTA copy (gate F4 — three classes, distinct messaging).** When `/api/score` returns a 4xx with one of
  the three bounce error tags, render a class-specific CTA panel instead of the score body. Each class deserves
  different framing because the user's correctness model is different in each case:

| Error tag                           | Headline                                        | Sub-copy                                                                                                                                                               |
| ----------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chain_no_resolve`                  | "We couldn't find a pre-built binary for that." | "anc only scores tools with a published binary release. Run `anc check .` locally for source + project depth: `brew install agentnative`."                             |
| `chain_resolved_install_failed`     | "Found an install path, but it didn't run."     | Show the install command we tried and its non-zero exit excerpt (truncated). "Try `anc check .` locally — it has more flexible install options."                       |
| `chain_resolved_no_binary_produced` | "That looks like a library, not a CLI."         | "We installed it, but no command-line entry point appeared on PATH. anc only scores binaries. If this is wrong, paste the actual binary name as `<command>` to retry." |

  All three keep the install-anc-locally CTA as a secondary surface; they differ in headline + diagnostic copy.

- **Markdown twin policy.** `/index.md` (the homepage's markdown twin) carries no form, no JS, no Turnstile reference,
  and no API documentation for `/api/score`. Live-scoring is HTML-only by design. Agents pasting `/api/score` URLs is a
  non-goal; agents are expected to run `anc check` locally. The markdown homepage stays silent on the feature.
- **`spec-version-gen.mjs`** emits:

  ```ts
  // GENERATED — do not edit. Regenerated by src/build/spec-version-gen.mjs.
  export const SPEC_VERSION = "0.3.0";        // from src/data/spec/VERSION
  export const SITE_SPEC_VERSION = "0.3.0";   // from content/principles/VERSION
  ```

  Imported by `src/worker/score/response-shape.ts`.

**Patterns to follow:**

- `src/build/skill.mjs` + `src/data/skill.json` — single-source data → HTML + JSON precedent (no markdown twin parallel
  here, by design).
- `src/build/build.mjs:280` — `extraScripts: ['/js/live-score.js']` pattern for client JS injection.
-

[docs/solutions/architecture-patterns/cached-theater-live-fallback-2026-04-17.md](../solutions/architecture-patterns/cached-theater-live-fallback-2026-04-17.md)
— 2s minimum theater.

- `src/build/scorecards-render.mjs:buildScorecardBody` for the header/score/issues blocks (extract shared helpers if
  needed; do not duplicate).
- Spike 04 (Q4.1, Q4.4) for the Turnstile invisible-mode + lazy-load rationale and the CSP allowlist shape.

**Test scenarios:**

- **Happy path (Playwright chromium):** load `/`, focus the form input → Turnstile script lazy-loads (asserted via
  network log) → paste a registry slug, submit → form spinner shows for ≥2s → summary renders with top-3 issues →
  install-anc CTA visible.
- **Happy path (no form interaction):** load `/`, scroll past the form without focusing it → assert the Turnstile script
  was NOT loaded (network log confirms zero requests to `challenges.cloudflare.com`).
- **Happy path:** paste a parseable install command → same flow.
- **Happy path:** paste a GitHub URL for a registry-known tool → registry hit → cached scorecard.
- **Edge case:** paste an invalid input → form shows inline error from `/api/score` 400 response.
- **Edge case:** paste a non-GitHub URL → inline error.
- **Edge case:** 429 response → form shows "Try again in 60s" message with countdown.
- **Edge case (Turnstile):** Turnstile token verification fails server-side → form shows "Verification failed, please
  try again" without leaking siteverify internals.
- **Edge case (CSP regression):** assert the homepage response includes `challenges.cloudflare.com` in `script-src`,
  `frame-src`, AND `connect-src`. Missing any of the three breaks Turnstile silently (script blocks, iframe blocks, or
  XHR blocks); regression test catches drift.
- **Edge case (bounce: `chain_no_resolve`):** mocked 404 with that error tag → form renders the "couldn't find a
  pre-built binary" headline + R9 CTA, not a generic error.
- **Edge case (bounce: `chain_resolved_install_failed`):** mocked 502 with that error tag → form renders the "install
  path didn't run" headline AND the install command + truncated stderr excerpt from the response details.
- **Edge case (bounce: `chain_resolved_no_binary_produced`):** mocked 502 with that error tag → form renders the "looks
  like a library, not a CLI" headline + retry-with-explicit-command affordance.
- **Integration:** `/index.md` markdown twin contains no form / Turnstile / `/api/score` references (regression — guards
  against accidental introduction).
- **Integration (live sandbox project, opt-in):** paste a real unknown tool with installable binary → progress timeline
  animates → summary renders within 60s.

**Verification:** Default Playwright suite (chromium) covers form happy path + error paths with mocked `/api/score`,
plus the lazy-load + CSP + markdown-twin-silence regressions. The opt-in `homepage-score-live` project covers a real
sandbox round-trip (excluded from default suite, runs manually + nightly).

---

- U9. **Tests + smoke + monitoring runbook + release procedure**

**Goal:** Cross-cutting tests (regression, contract), CI smoke step, monitoring runbook, RELEASES.md update, README
mention. Operational readiness for the v3 deploy.

**Requirements:** All R1-R12 verifiable; operational readiness.

**Dependencies:** U1-U8 land first.

**Files:**

- Modify: `tests/regression.test.ts` (add `/api/score` triad assertion, registry-index shape, scorecard
  cross-validation)
- Modify: `tests/build.test.ts` (assert `dist/registry-index.json` and `src/worker/spec-version.gen.ts` exist after
  build)
- Create: `tests/score-contract.test.ts` (cross-validates `/api/score` JSON ↔ committed `scorecards/*.json` ↔
  `dist/registry-index.json`)
- Modify: `.github/workflows/deploy.yml` (add post-deploy smoke step against staging; image build + push happens inside
  `wrangler deploy` per U3, so no separate registry step here)
- Modify: `RELEASES.md` (v3 release procedure: image rebuild via `wrangler deploy` against CF managed registry, deploy
  migration, smoke, rollback)
- Create: `docs/runbooks/live-scoring-monitoring.md` (cost-watch checklist, alert thresholds, common failures)
- Modify: `README.md` (mention `/score` in user-facing surface map)
- Modify: `docs/brainstorms/live-scoring-spike.md` (Status block — supersession note pointing back here)

**Approach:**

- **Regression:** `/api/score` response shape = `{ schema_version, spec_version, anc_version, checker_url, ...scorecard
  }`. All four mandatory.
- **Regression:** `dist/registry-index.json` `by_slug` contains every `tools[].name` from `registry.yaml`.
- **Cross-validation:** every `dist/scorecards/<name>-v<v>.json` is reachable via `/api/score` registry-fast-path
  (stubbed Worker, no real sandbox).
- **CI smoke:** post-deploy step in `.github/workflows/deploy.yml` hits staging `/api/score` for a pinned known-tool
  slug; fails the deploy if 200 + valid triad doesn't return.
- **RELEASES.md additions:**
- Image rebuild step (CF managed registry; happens inside `wrangler deploy` against `image:
  "./docker/sandbox/Dockerfile"`; immutability is per-Worker-version via `wrangler rollback`, not via a `@sha256:`
  literal in `wrangler.jsonc`).
- Migration v1 (one-way gate). Document rollback (follow-up migration with `deleted_classes`).
- **Cross-migration rollback rehearsal (REQUIRED before first prod cut).** On staging only, before the first prod deploy
  of v3: (1) deploy migration v1 (`new_sqlite_classes: ["Sandbox"]`); (2) verify `/api/score` works; (3) apply a
  follow-up migration with `deleted_classes: ["Sandbox"]` and deploy a Worker version that doesn't reference the Sandbox
  DO; (4) verify the Worker still serves non-sandbox routes (`/`, `/scorecards`, `/principles/*`); (5) re-deploy with
  the Sandbox DO restored (new migration `new_sqlite_classes` with a different tag, e.g. `v2`); (6) verify `/api/score`
  works again. Capture the staging deploy IDs + DO instance counts at each step in `RELEASES.md` as evidence. Without
  this rehearsal we are flying blind on cross-migration recovery — see Risk Analysis row "DO migration v1 blocks
  cross-migration `wrangler rollback`."
- Smoke test post-deploy.
- Triple-diff already in the runbook (per PR #69).
- **Runbook contents:**
- Cost-watch for first 30 days: daily R2 storage, DO requests, Container vCPU-seconds. Thresholds: R2 >$1/mo, Container
  >$15/mo trigger a review.
- Common failures: install timeout (network), `anc check` exit non-zero (real fail vs runner bug), R2 write fail
  (best-effort, alert if sustained), discovery chain false-negative (README parse missed an obvious install — capture
  for v3.1 LLM upgrade evidence).
- Alert: 5xx rate >1% over 10 min → page (whatever paging we wire up).
- Manual rollback (intra-migration): `wrangler rollback` to a previous Worker version on the SAME side of the DO
  migration boundary as the current version. Each version references its own prior image push in the CF managed
  registry, so the rollback also reverts the image binding. Constraint: per CF docs, `wrangler rollback` cannot cross a
  DO migration. Once `migrations[v1]` (`new_sqlite_classes: ["Sandbox"]`) ships, rollback only works among post-v1
  versions.
- Manual rollback (cross-migration / undo of v3 itself): apply a follow-up migration with `deleted_classes: ["Sandbox"]`
  and deploy a new Worker version that no longer references the Sandbox DO. This is the documented recipe and the ONLY
  way to revert past migration v1. Rehearse on staging before the first prod cut. DO durable storage attached to deleted
  classes is destroyed; capture cost-of-loss in the runbook (R2 cache survives because it's a separate binding).
- **CHANGELOG:** filled via PR template's `## Changelog` section per global CLAUDE.md. Include user-facing bullet: "Live
  scoring at `/score` — paste a tool name, install command, or GitHub URL; get a summary scorecard. Run `anc` locally
  for source + project depth."

**Patterns to follow:**

- `tests/regression.test.ts` (282 LOC) — hash-based contracts, structural assertions.
- `tests/worker.test.ts:26 makeEnv` — stub-env pattern.
- Existing `RELEASES.md` structure.

**Test scenarios:**

- **Contract:** `/api/score` response is valid against the documented schema.
- **Contract:** `dist/registry-index.json` is in sync with `registry.yaml`.
- **Contract:** `src/worker/spec-version.gen.ts` constants match `src/data/spec/VERSION` and
  `content/principles/VERSION`.
- **Smoke (CI, post-deploy):** staging `/api/score` for `BurntSushi/ripgrep` returns 200 + valid scorecard + triad.

**Verification:** Full `bun test` + `playwright test` (chromium project) passes locally and in CI. Smoke runs on every
staging deploy. Runbook committed; RELEASES.md rev'd; README mentions `/score`.

---

## System-Wide Impact

- **Interaction graph.** New entry point: `/api/score` (Worker) → `SCORE_LIMITER` (binding) → `ASSETS` (registry-index
  JSON) → `SCORE_CACHE` (R2) → `SCORE` (DO singleton) → `Sandbox` (Container, Alpine+musl) → package registries
  (`formulae.brew.sh`, `crates.io`, `registry.npmjs.org`, `pypi.org`, `github.com` releases). Static surface unchanged:
  `/`, `/scorecards`, `/install`, `/check`, `/about`, `/changelog`, `/methodology`, `/score/<name>` (per-tool pages,
  distinct from the new `/score` form), `/skill`, `/badge` continue to be served from `dist/`.
- **Error propagation.** Worker → user: 400 (validation), 404 (no installable binary OR `anc check` says `not_a_cli`),
  429 (rate-limit), 502 (install failed / binary not on PATH after install), 504 (timeout), 500 (response triad missing
  — fail-fast). Sandbox failures are caught in DO, returned as JSON; never raw exceptions.
- **State lifecycle risks.** Container disk resets on sleep — installed binaries do NOT survive sleep. DO state (SQLite)
  DOES survive. Singleton container with 5 min `sleepAfter`. R2 cache is content-addressed by `(slug, anc-version,
  tool-version)` so partial-write risk is contained: a half-written cache entry is no worse than a miss (the write is
  best-effort and refused if `anc_version` is missing).
- **API surface parity.** `/api/score` follows the `/skill` pattern: `.json` (default), `.md` (markdown), HTML form at
  `/score`. Headers (CORS, noindex, short cache for hits / no-store for live) inherited from existing `applyHeaders`
  JSON branch where possible; explicit otherwise.
- **Integration coverage.** Three integration scenarios mocks alone cannot prove: (a) two-phase egress sequence
  (`allowedInstall` → `noHttp` BEFORE `anc check`); (b) `anc_version` is read from the running binary, not a constant;
  (c) the response triad (`spec_version`, `anc_version`, `checker_url`) is enforced as a fail-fast gate, not a quiet
  omission. All three have integration tests with stubbed-but-realistic Sandbox SDK behavior; the `score-live`
  Playwright project exercises the real path nightly.
- **Unchanged invariants.** Asset-first invariant of the existing Worker (every non-`/api/score` request hits
  `env.ASSETS`) is preserved — the `/api/score` branch is additive. The `applyHeaders` JSON branch behavior is unchanged
  for existing `*.json` paths; v3 either extends `isJson()` to match `/api/score` or sets headers directly. Existing
  `tests/worker.test.ts` cases all continue to pass without modification. The per-tool `/score/<name>` URL namespace is
  untouched (CF Static Assets resolves exact files first; the `/score` form page sits above the tool slugs).
- **Departure from prior posture.** Per the triple-emit-content-negotiation-rename-safe learning, this Worker was
  previously "no D1, no KV, no R2 bindings, no Durable Objects" — rename-cheap. v3 deliberately departs from that
  posture for `/api/score` only. The asset surfaces (`/skill`, `/badge`, etc.) retain the rename-cheap property; only
  the live-scoring path adds bindings.

---

## Cost ceiling and abuse mitigation

**Background (per spike 04, 2026-05-14).** Cloudflare offers no native automatic hard cap. April 2026's Billable Usage
dashboard + Budget Alerts (cite
<https://developers.cloudflare.com/changelog/post/2026-04-13-billable-usage-dashboard-and-budget-alerts/>) are
**email-only**: an alert fires when projected monthly spend crosses a configured dollar threshold, but Cloudflare does
not auto-disable, auto-throttle, or auto-cap on breach. There is no per-binding spend cap. Latency to alert is daily.
The Workers `ratelimit` binding is per-Cloudflare-location (per
<https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/>), so a distributed botnet hits the cap
separately at every POP. The current `SCORE_LIMITER` config of 10 req/60s/IP is therefore actually 10 req/60s/IP per POP
and is trivially bypassed with rotating IPs.

**Minimum viable defense for v3 launch (the bare floor).** Four layers, in order. Each is independently shippable; the
combination eliminates the rotating-IP bypass class and gives the operator a sub-minute kill switch. None require
Enterprise upgrades or custom Cloudflare contracts.

1. **Cloudflare Turnstile (Invisible mode + lazy-load).** Free CAPTCHA-alternative; 1M challenges/month on the free tier
   (cite <https://developers.cloudflare.com/turnstile/>). Lazy-load the widget script
   (`https://challenges.cloudflare.com/turnstile/v0/api.js`) on first form interaction (focus / click / paste on the
   homepage form input — see U8). Visitors who never engage the form pay zero cost. ~20 lines of code: widget on the
   form (U8), `siteverify` POST in the Worker (U5). The single highest-leverage change: eliminates headless / no-JS
   attackers entirely.
2. **Rekey `SCORE_LIMITER` from per-IP to `session-cookie + tool-arg-hash` (per Q4.2 follow-up).** After Turnstile
   passes, set a signed session cookie (`__Host-anc-session`, HttpOnly, Secure, SameSite=Lax, ~1h TTL). Compute the
   limiter key as `<session-cookie>:<sha256(input)>`. Effect: 10 distinct score requests per session per minute;
   same-tool requests in a session don't burn budget (cache-friendly); new sessions require a Turnstile solve. Keep a
   coarse per-IP fallback ratelimit (e.g. 30/60s) in a separate ratelimit namespace as a safety net for sessions that
   swap cookies. Implementation: U5 step 5.
3. **In-Worker KV `scoring_disabled` kill switch.** New `SCORE_KV` namespace (added to U5's wrangler.jsonc Files list).
   Worker reads `env.SCORE_KV.get("scoring_disabled")` first thing in `/api/score`; returns 503 with `Retry-After: 3600`
   if truthy. Operator flips via `wrangler kv:key put scoring_disabled true` (seconds to flip and reverse, vs minutes
   for a `wrangler deploy --max-instances=0` redeploy). Documented runbook: alert email arrives → engineer flips KV flag
   → investigates → flips back when safe. Implementation: U5 step 3.
4. **Cloudflare Budget Alert.** Account-level dollar threshold set via Notifications → Add → Budget Alert. Email-only
   (no auto hard-cap exists), with daily latency, but better than nothing. Operator paged → flips the kill-switch above.
   Implementation: dashboard click; document in U9 runbook.

**Bundle cost.** ~zero added monthly cost (Turnstile free, KV reads are free up to 100k/day, Budget Alerts are free).
Approximately one day of work across U5 + U8.

**What this defense does NOT add: a true hard daily cap.** The remaining attack surface is "operator manually intervenes
on alert." Document this plainly in the launch announcement: spend control is human-in-the-loop, not algorithmic. A true
hard cap (single-purpose Durable Object + alarm + cost-budget counter the Worker consults before invoking the container)
is **deferred to v3.1**, per spike 04 item #3.

**Operational visibility (per spike 04 Q4.6, partially deferred to v3.1).** Workers Analytics Engine writes (one data
point per `/api/score` with cache-hit / Turnstile-outcome / container-active-seconds / session-hash dimensions) plus a
nightly cron-Worker projecting monthly spend from the AE table together form the right early-warning signal between
alert emails. Wire as a v3.1 follow-up unit; v3 launch ships with native Workers Logs + the Billable Usage dashboard
only.

---

## Risk Analysis & Mitigation

| Risk                                                                                 | Likelihood | Impact   | Mitigation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------ | ---------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ~~Upstream musl release slips or doesn't pass review~~ — **RESOLVED 2026-05-04**     | —          | —        | `agentnative-cli` v0.3.1 ships `agentnative-x86_64-unknown-linux-musl.tar.gz` (and aarch64 musl as a bonus). Static-pie linkage verified locally; end-to-end smoke test landed in U2 image build ([#79](https://github.com/brettdavies/agentnative-site/pull/79)) where `RUN ... anc --version` would fail the build if linkage broke.                                                                                                                                                                                                                                                                                                                                                                                                          |
| First-ever DO + Containers + R2 + migrations bindings — one-way gate                 | High       | High     | Stage as a pre-launch dry-run on staging; verify rollback procedure (`deleted_classes` follow-up migration) before prod deploy. First v3 deploy is its own milestone PR; no other changes bundled.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| DO migration v1 blocks cross-migration `wrangler rollback`                           | Med        | High     | Per CF docs (workers/configuration/versions-and-deployments/rollbacks/), `wrangler rollback` only works among versions on the SAME side of a DO migration boundary. Once `new_sqlite_classes: ["Sandbox"]` ships, you can roll back to any post-v1 version but NOT to a pre-v1 version. Recovery story: a follow-up migration with `deleted_classes: ["Sandbox"]` is the documented recipe. Rehearse on staging before the first prod cut; capture the procedure verbatim in RELEASES.md.                                                                                                                                                                                                                                                       |
| `outboundHandlers` map missing or misnamed at runtime                                | Low        | High     | The `allowedInstall` and `noHttp` handlers are inline async functions on the Sandbox DO class's static `outboundHandlers` map (Pattern Y, K-decision). If the map isn't declared, or a name is misspelled, `setOutboundHandler("name")` references a non-existent handler and the egress policy degrades silently. Mitigation: U6 unit test that asserts both keys exist on the class before `score()` runs; integration test asserts handler invocation logs match expected per-phase pattern.                                                                                                                                                                                                                                                 |
| `cloudflare/sandbox:0.9.2-musl` is undocumented on CF's Sandbox Dockerfile-reference | Low        | Med      | The musl variant exists on Docker Hub but is not listed on the CF docs page; could be deprecated without notice. Mitigation: digest-pin (already done at Dockerfile line 33), watch for SDK npm updates that drop musl support, plan a glibc fallback if/when the musl tag stops shipping (Debian-trixie-slim image, ~2x size, would cost the `basic` instance disk headroom but still fit). Capture the variant pin date in `docker/sandbox/README.md` so a future maintainer can audit upstream.                                                                                                                                                                                                                                              |
| Image size creeps past 350 MB → cost premium / `basic` doesn't fit                   | Low        | Med      | Measured 221 MB compressed at v3-rc1 (2026-05-05) — 12x disk headroom on `basic`. NOTE: `tests/dockerfile-sandbox.test.ts` has NO automated size assertion despite earlier plan claim; add a manual measurement step to RELEASES.md or a docker-available CI guard before this risk re-emerges. Brew already dropped (Linuxbrew/musl incompatibility); Go toolchain retained per the corrected `go install` K-decision (re-evaluation 2026-05-18) — image stays at ~221 MB compressed. Future image bloat would have to come from new PMs added to the table or transitive apk deps from existing PMs.                                                                                                                                          |
| HN spike >10× expected → cost overrun                                                | Low        | Med      | `max_instances: 3` pool + `SCORE_LIMITER` (now keyed on `session-cookie + tool-arg-hash`, gated by Turnstile per Cost ceiling section) + in-Worker KV `scoring_disabled` kill switch. Per-IP rekey defeats the rotating-IP bypass. Surplus traffic gets queued or 429'd. Cost ceiling: 3 instances × `basic` × 4 h spike ≈ $1.50-3 raw + active-CPU bounded by limiter, well under R12. KV-flag kill-switch documented in U9 runbook is faster than `max_instances: 0` redeploy for breach scenarios. NO native auto hard-cap exists (see Cost ceiling section); operator-in-the-loop response model.                                                                                                                                           |
| Cost ceiling has no native auto-cap on Cloudflare                                    | Med        | High     | Per spike 04 (cite <https://developers.cloudflare.com/changelog/post/2026-04-13-billable-usage-dashboard-and-budget-alerts/>): April 2026 Budget Alerts + Billable Usage dashboard are email-only; no auto-disable / auto-throttle / auto-cap exists. MVP defense (Turnstile invisible mode + lazy-load + session+tool-arg-hash ratelimit + KV `scoring_disabled` kill switch + Cloudflare Budget Alert) reduces but does not eliminate exposure between alert email and operator action. v3.1 needs a true hard cap (single-purpose DO + alarm + cost-budget counter). Documented plainly in launch announcement.                                                                                                                              |
| Image deletion silently breaks rollback                                              | Med        | High     | Per spike 03 + Containers Limits footnote (<https://developers.cloudflare.com/containers/platform-details/limits/>): "Delete container images with `wrangler containers delete` to free up space. If you delete a container image and then roll back your Worker to a previous version, this version may no longer work." Account-wide image cap is 50 GB with no auto-GC. Pruning to stay under cap silently severs rollback paths. Discipline: never delete images that backed shipped versions; inventory via `wrangler containers images list` quarterly; pair every git release tag with the registry image URI in RELEASES.md. Pruning is a quarterly manual exercise paired with explicit "what versions become unrollback-able" review. |
| Multi-env image identity (containers is non-inheritable)                             | Low        | Med      | Per spike 01: default `containers` config is non-inheritable per-env (cite <https://developers.cloudflare.com/workers/wrangler/environments/>); without the prebuild-once + shared-tag-pin pattern, prod and staging produce two distinct container apps with two builds and double the registry footprint. The U3-followup primary path explicitly uses the shared-tag-pin pattern (`wrangler containers build -p -t <git-sha>` once, both env blocks pin the resulting `registry.cloudflare.com/<acct>/anc-sandbox:<git-sha>` URI). Verify on first staging+prod deploy via `wrangler containers images list` that exactly the expected image footprint exists.                                                                               |
| Cloudflare changes Sandbox SDK API mid-flight                                        | Low        | Med      | Pin `@cloudflare/sandbox` exact version (added at U6 import time); image already pins `cloudflare/sandbox:0.9.2-musl@sha256:b4cb1d69…` per `docker/sandbox/Dockerfile`. Review CF changelog before each version bump; SHA-pin discipline guards against forced re-tags upstream.                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `anc check` flag mismatch (e.g., `--command` semantics change in v0.4)               | Low        | Med      | Pin `anc` to a tagged release in the image build. Plan a v3.0.1 to consume each new `anc` after launch settles.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| GitHub anonymous API rate limit (60/hr/IP) bites discovery chain                     | Med        | Med      | Pooled CF egress IPs amortize. R6 rate-limit caps at ~14k/day at 100% miss → ~580/hr peak (well under aggregate egress IP allotment). If bites: add GitHub App token via Outbound Worker as v3.1.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| README parse heuristic misses installable tools (false-negative)                     | Med        | Low      | Failure mode is bounce-out with R9 CTA — never wrong-answer, only missed-opportunity. Capture misses for v3.1 LLM upgrade evidence (runbook).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Smart Tiered Cache + R2 + custom-domain misconfig serves stale data                  | Low        | Med      | Content-addressed keys (`anc-version` + `tool-version`); stale-by-construction is impossible. Cache TTL 24 h + version-suffixed key.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Two-phase egress race: `noHttp` not applied before `anc check` execs                 | Low        | Critical | Sequential `await` between the two `setOutboundHandler` calls. Integration test asserts the order by capturing the per-request `console.log` lines emitted by `allowedInstall` and `noHttp` handlers (the per-request observability is the reason for picking Pattern Y over Pattern X — see two-phase egress K-decision). Separate Risk row covers handler-map registration. Separate P1 backlog item covers in-flight TCP-stream kill semantics between phases.                                                                                                                                                                                                                                                                               |
| User pastes a private repo → 404 surface unhelpful                                   | Med        | Low      | Friendly 404: "anc.dev only scores public repos. Run `anc check .` locally for private code."                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Discovery chain timeouts cascade and block the whole request                         | Low        | Med      | Each step bounded ≤2 s; total ≤8 s. After 8 s: bounce out with R9 CTA. Surface this as a "took too long to find an installable binary" message, not a generic 500.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Worker bundle size growth                                                            | Low        | Low      | Pre-push `wrangler deploy --dry-run` already prints the upload size on every push. Current bundle: 237 KiB / 28 KiB gzipped (measured 2026-05-05, before U5-U8). Realistic projection after live-scoring code + Workers-side `@cloudflare/sandbox` helpers: ~487 KiB. Headroom: 2x on free tier (1 MiB), 21x on paid (10 MiB). Any 5x regression would be obvious in commit output; no CI gate needed unless trend changes. If a single unit ever pushes total over 800 KiB, treat as a refactor smell.                                                                                                                                                                                                                                         |
| `audit_profile` from registry doesn't apply when scoring an unknown tool             | High       | Low      | Unknown tools get no `--audit-profile` flag; `anc` defaults to no profile (all checks). Document in runbook; add `audit_profile` to the discovery-chain output if we can infer it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

---

## Documentation / Operational Notes

- **RELEASES.md (U9).** Add v3 release procedure: image rebuild via `wrangler deploy` (CF managed registry), migration
  apply, smoke test, rollback steps. The first v3 deploy is its own PR (no other changes bundled) so the migration is
  reviewable. Triple-diff recipe (added in PR #69) extends to cover the Dockerfile path under `containers[].image`
  rather than a `@sha256:` literal.
- **Monitoring runbook (`docs/runbooks/live-scoring-monitoring.md`).** First-30-day cost-watch:
- Daily: R2 storage (free tier 10 GB), DO requests, Container vCPU-seconds, GitHub API calls (anonymous limit headroom).
- Weekly: total spend rollup vs R12 ceiling.
- Alerts: 5xx >1% / 10 min, cost >$15/mo on day 7, GitHub API rate-limit at >50%.
- **Cost-watch checklist for first 30 days.**
- Day 1-7: every deploy, eyeball Container vCPU-seconds in CF dashboard; watch GitHub API headroom.
- Day 7-14: confirm cache hit ratio >80% on registry-known repos; capture discovery-chain false-negatives for v3.1
  LLM-parser justification.
- Day 14-30: review by total spend + R2 storage growth + GitHub API metrics.
- **Token rotation.** No GitHub App token in v3 (anonymous public-only). Quarterly rotation of CF API token per the
  existing 1Password recipe.
- **`workflow_dispatch` parity.** Verify `deploy.yml` retains `workflow_dispatch` with `ref` input after the Container
  build step is added per
  [docs/solutions/best-practices/workflow-dispatch-on-deploy-for-recovery-2026-04-14.md](../solutions/best-practices/workflow-dispatch-on-deploy-for-recovery-2026-04-14.md).
- **Compound-engineering follow-up (post-ship).** File solutions docs for the gaps the learnings researchers flagged:
  (a) CF Sandbox 0.9.x outbound-handler shape (inline async functions on the Sandbox class via `outboundHandlers` static
  map, NOT separate sub-Workers — Pattern Y from K-decisions) + TLS interception defaults + per-request egress logging
  recipe; (b) Workers Rate Limiting binding choice (Option A vs DO counter); (c) README install-block parsing heuristic
  specifics + miss-rate data; (d) GitHub Releases binary-discovery shape; (e) CF Sandbox cold-start measurements +
  `basic` vs `standard-1` sizing rationale; (f) `wrangler rollback` + DO-migration boundary recovery procedure rehearsal
  record.

---

## Sources & References

### Primary Sources

- Origin brainstorm: [docs/brainstorms/live-scoring-spike.md](../brainstorms/live-scoring-spike.md) (sections still
  load-bearing: install-registry concept, cost model, R2 cache strategy; superseded: clone phase, source-only fallback,
  toolchain-pre-baked Dockerfile)
- CEO design (outside repo): `~/.gstack/projects/brettdavies-agentnative-site/brett-dev-design-20260417-145305.md`
  Premises #1, #2, #3, #4, #6 are this plan's locked framing
- Internal research synthesis:
  [docs/research/2026-04-28-cloudflare-live-scoring-v2.md](../research/2026-04-28-cloudflare-live-scoring-v2.md)
  (load-bearing: §1-3, §5, §7-9; superseded: §4 base-image, §10 cf-CLI investigation)
- Repo research handoff: `.context/handoffs/2026-04-27-001-live-scoring-v2-research.md` (local-only by design)

### Solutions Docs Cited

Paths are repo-relative under `docs/solutions/`.

- `architecture-patterns/cf-sandbox-secure-cli-execution-2026-04-17.md`
- `architecture-patterns/cached-theater-live-fallback-2026-04-17.md`
- `architecture-patterns/anc-cli-output-envelope-pattern-2026-04-29.md`
- `architecture-patterns/aggregate-verdicts-are-informational-not-authoritative-20260420.md`
- `best-practices/cloudflare-workers-static-assets-custom-headers-2026-04-14.md`
- `best-practices/account-id-out-of-public-repo-2026-04-14.md`
- `best-practices/versioned-scorecard-filenames-and-non-github-registry-2026-04-20.md`
- `best-practices/sot-contract-for-spec-repos-with-downstream-consumers-2026-04-22.md`
- `best-practices/agentnative-version-model-2026-05-01.md`
- `best-practices/triple-emit-content-negotiation-rename-safe-2026-04-29.md`
- `best-practices/cross-repo-artifact-consumption-static-sites-2026-04-21.md`
- `best-practices/rust-url-validation-https-only-with-localhost-exception-2026-04-20.md`
- `best-practices/workflow-dispatch-on-deploy-for-recovery-2026-04-14.md`
- `developer-experience/cloudflare-api-token-headless-wrangler-1password-2026-04-13.md`
- `logic-errors/accept-header-q-value-parsing-content-negotiation-2026-04-14.md`
- `build-errors/rustup-target-add-pinned-toolchain-2026-04-16.md`

### External Docs

- [Cloudflare Sandbox SDK overview](https://developers.cloudflare.com/sandbox/)
- [Sandbox configuration (Wrangler)](https://developers.cloudflare.com/sandbox/configuration/wrangler/)
- [Sandbox Dockerfile reference](https://developers.cloudflare.com/sandbox/configuration/dockerfile/)
- [Outbound traffic guide](https://developers.cloudflare.com/sandbox/guides/outbound-traffic/)
- [Containers pricing](https://developers.cloudflare.com/containers/pricing/)
- [Container class lifecycle](https://developers.cloudflare.com/containers/container-class/)
- [R2 pricing](https://developers.cloudflare.com/r2/pricing/)
- [Workers Rate Limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
-

[2026-04-13 Sandbox GA + outbound + TLS changelog](https://developers.cloudflare.com/changelog/post/2026-04-13-sandbox-outbound-workers-tls-auth/)

- [2026-03-26 Outbound Workers changelog](https://developers.cloudflare.com/changelog/post/2026-03-26-outbound-workers/)
- [Container image management](https://developers.cloudflare.com/containers/platform-details/image-management/) — CF
  managed registry, inline build via `image: "./Dockerfile"`, `wrangler containers push` for CI workflows
- [2025-11-21 active-CPU pricing](https://developers.cloudflare.com/changelog/post/2025-11-21-new-cpu-pricing/)
- [GitHub REST API — Releases](https://docs.github.com/en/rest/releases/releases)
- [Homebrew formulae JSON API](https://formulae.brew.sh/docs/api/)
- [crates.io API](https://crates.io/data-access)
- [npm registry API](https://github.com/npm/registry)
- [PyPI JSON API](https://warehouse.pypa.io/api-reference/json.html)
- [SSL Labs Terms — assessment headers + cool-off pattern](https://www.ssllabs.com/about/terms.html)

### Cross-Tracker

- Show HN launch readiness:
  [docs/plans/2026-04-28-001-feat-show-hn-launch-readiness-plan.md](2026-04-28-001-feat-show-hn-launch-readiness-plan.md)
  (CORRECTION block names this surface as the launch blocker)
- Skill distribution v1:
  [docs/plans/2026-04-27-001-feat-skill-distribution-site-plan.md](2026-04-27-001-feat-skill-distribution-site-plan.md)
  (parallel pattern `/skill` adopted here for `/score`)
- Upstream musl release (cross-repo, blocks this plan): TBD plan in `agentnative-cli/docs/plans/`

## GSTACK REVIEW REPORT

| Review        | Trigger               | Why                             | Runs | Status      | Findings                              |
| ------------- | --------------------- | ------------------------------- | ---- | ----------- | ------------------------------------- |
| CEO Review    | `/plan-ceo-review`    | Scope & strategy                | 0    | —           | n/a                                   |
| Codex Review  | `/codex review`       | Independent 2nd opinion         | 0    | —           | n/a                                   |
| Eng Review    | `/plan-eng-review`    | Architecture & tests (required) | 1    | ISSUES OPEN | 4 issues, 1 critical gap (P1 backlog) |
| Design Review | `/plan-design-review` | UI/UX gaps                      | 0    | —           | n/a                                   |
| DX Review     | `/plan-devex-review`  | Developer experience gaps       | 0    | —           | n/a                                   |

- **UNRESOLVED:** 3 deferred decisions (go install X/Y/Z, in-flight TCP kill, CI cache backend) — each owned by the
  implementation unit that uses it; not blockers.
- **VERDICT:** ENG REVIEW LANDED with explicit deferrals. Architecture (Y handlers), code quality (ScoreError union),
  test specs (outboundHandlers shape, q-value parsing, rollback rehearsal), and performance (bundle size
  reality-grounded) all locked. Ready to implement when feature work resumes.
