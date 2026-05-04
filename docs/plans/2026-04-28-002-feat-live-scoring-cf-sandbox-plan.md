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
  sandbox: `setOutboundByHost` to the resolved install host(s) during install → `setOutboundHandler("noHttp")` before
  `anc check` runs. TLS interception is on by default per-instance (CF Sandbox SDK 0.8.x).
- **R8. No toolchains in the sandbox image.** `anc` is downloaded as a pre-built musl binary from
  `github.com/brettdavies/agentnative-cli/releases/...` at image build time. The image carries package managers (apk,
  cargo-binstall, pip, npm, go runtime, brew if compatible) but NOT compilers. Tools that require source compilation
  MUST bounce out with R9's CTA.
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
npm — never toolchains. Two-phase egress (`allowHosts` → `noHttp`). Bump tag from `0.7.4-musl` to the chosen
`0.8.x-musl` SHA-pinned digest; verify the `libstdc++` copy is still required on 0.8.x. -
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
-

[2026-03-24 Docker Hub direct images changelog](https://developers.cloudflare.com/changelog/post/2026-03-24-docker-hub-images/)

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

- **Image base: Alpine + musl, ~100-300 MB, `basic` instance type singleton.** Restores design Premise #2 + #6. Reverses
  v2's silent re-glibc to Debian-trixie-slim. Cost ceiling holds: ~$0.25-0.75/day during HN spike, ~$22/mo absolute
  worst case (24/7 awake, which won't happen with `sleepAfter`). The 8 GB-disk `standard-1` premise that v2 carried is
  wrong for this workload.
- **`anc` binary: pre-built musl bottle, downloaded at image build time from the upstream `x86_64-unknown-linux-musl`
  release artifact.** Hard prerequisite (see Dependencies & Prerequisites). The Dockerfile's anc-install layer pins to a
  SHA-resolved release URL, never a moving tag. We do NOT compile `anc` inside our pipeline — keeps single source of
  truth at agentnative-cli.
- **Sandbox SDK pin: `@cloudflare/sandbox@0.8.x` (≥0.8.9), musl variant tag (`:0.8.x-musl`).** Runtime outbound handlers
  require 0.8.9+. Mirror the SDK npm version EXACTLY in the Dockerfile `COPY
  --from=docker.io/cloudflare/sandbox:0.8.x-musl ...` line — the SDK warns on mismatch. Verify on 0.8.x whether the
  `libstdc++.so.6` copy from the cf-sandbox-secure-cli-execution learning is still required (was true on 0.7.4-musl).
- **DO + Containers pairing: SQLite-backed DO (`new_sqlite_classes`).** Mandatory for Container DOs; key-value backend
  not supported. **Pool of 3 instances** via `getRandom(env.SCORE, 3)` (NOT a singleton). Default sized for HN-spike
  concurrency: per-instance throughput is ~1-2 req/min sustained (cold start 1-3s + install 10-30s + score 5-15s,
  sequential `exec()` per instance), so 3 instances yield ~3-6 req/min sustained. The "12-30 req/min" figure that
  earlier drafts carried was wrong (silently assumed parallelism that the singleton design didn't have). During U6
  implementation, measure actual install + score timings on `basic` and adjust the pool size if measured throughput is
  materially below estimate. Cost stays bounded: idle instances cost storage only ($0.50/mo each), active CPU is the
  dominant line item and is capped by `SCORE_LIMITER`.
- **R2 cache key: `scores/{tool-slug}/{anc-version}/{tool-version-or-sha7}.json`.** Includes `anc-version` per the
  versioned-scorecard pattern so `anc` upgrades auto-invalidate. Refuse to cache (and refuse to read from cache) if
  `anc_version` or `tool_version` is missing — fail-fast, no half-state.
- **Two-phase egress (non-negotiable per R7).** Phase 1: `setOutboundByHost(<install-host>, "allowedInstall")` — the
  install host is whichever the resolver picked (`formulae.brew.sh`, `crates.io` + `static.crates.io`,
  `registry.npmjs.org`, `pypi.org` + `files.pythonhosted.org`, `proxy.golang.org`, or `github.com` for direct binary
  downloads). Phase 2: `setOutboundHandler("noHttp")` before `anc check` runs. TLS interception is on by default; no
  explicit configuration needed.
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
- **`go install`:** downloads source and compiles. We do NOT ship a Go toolchain in the image. `go install` is therefore
  unreachable from the sandbox; if the resolver picks the `go install` path, the install fails fast with `go: command
  not found` → bounce out with R9 CTA. Document this as an explicit non-support: `go install` is recognized by the
  parser for input classification (so we know the user's intent) but always fails to install → bounce-out. Same as
  compilation-only Rust crates.
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
- **Container image registry: Docker Hub direct (since 2026-03-24).** `image: "docker.io/<ns>/<repo>:<tag>"` in
  `wrangler.jsonc` — no push-to-CF-registry round-trip. Build + push runs in `.github/workflows/deploy.yml` before
  `wrangler deploy`. Image lives at `docker.io/brettdavies/anc-sandbox:<tag>`.
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

### Resolved During Planning

- **Image base (Alpine vs Debian):** Alpine + musl per design. Reversal of v2's silent re-glibc.
- **anc binary acquisition (compile-in-place vs upstream musl release):** Upstream first, block on it (see Dependencies
  & Prerequisites). Cleanest pipeline; one canonical source.
- **GitHub authentication (App token via Outbound Worker vs unauthenticated):** Unauthenticated for v3. Public targets
  only; no clone phase; only API calls hit `api.github.com` (60 req/hr/IP anonymous). Reconsider only if anonymous
  limits bite in production.
- **Rate limit primitive (binding vs DO):** Workers Rate Limiting binding for v3. Upgrade later if needed.
- **R2 cache key shape:** `scores/{tool-slug}/{anc-version}/{tool-version-or-sha7}.json`. Includes `anc-version`.
- **Container image registry:** Docker Hub direct (post-2026-03-24 capability).
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

- **Image size budget likely 400-600 MB, not 100-300 MB** (feasibility, adversarial). Realistic Alpine + apk packages +
  cargo-binstall + pip + npm + go runtime is closer to 350-500 MB compressed. The "100-300 MB" claim in the REWRITE NOTE
  is aspirational, not measured. Build U2 first, measure, then either (a) drop heaviest contributor (Go runtime — ~150
  MB, used only for the `go install` discovery path which we now know fails fast in the sandbox per the script-execution
  audit) or (b) raise the threshold honestly.
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
- **`dist/score.md` static form twin serves no v3 goal** (scope-guardian). `/api/score.md` (the API JSON-as-markdown
  response) IS load-bearing for agent-native parity. The static page describing the form (`dist/score.md`) just says
  "this is a form, submit to /api/score" — information already conveyed by `/api/score.md`. Cut from U8; defer to v3.1
  if specific need surfaces.
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

```text
docker/
  sandbox/                          # NEW — v3 image (Alpine + musl, no toolchains)
    Dockerfile                      # FROM cf-sandbox:0.8.x-musl + apk install + anc bottle
    README.md                       # build + push instructions, registry pin, troubleshooting
src/
  build/
    registry-index.mjs              # NEW — emits dist/registry-index.json (dual-keyed)
    score-page.mjs                  # NEW — emits dist/score.html form + dist/score.md twin
  client/
    live-score.ts                   # NEW — form submit + fetch + 2s theater + progress polling
  worker/
    index.ts                        # MODIFIED — adds /api/score path-prefix branch
    spec-version.gen.ts             # NEW (build-emitted) — SPEC_VERSION + SITE_SPEC_VERSION constants
    score/                          # NEW — Worker-side score handler module
      handler.ts                    # /api/score route entry; URL validate + rate limit + cache + DO route
      validate.ts                   # Input validation (slug / install-command / GitHub URL)
      parse-install.ts              # Install-command parser (brew/cargo/bun/uv/pip/npm/go/yarn/pnpm)
      discover-binary.ts            # GitHub URL → binary discovery chain (4 steps)
      registry-lookup.ts            # registry-index.json hit-test (slug + owner/repo)
      cache.ts                      # R2 read/write keyed by scores/{slug}/{anc-v}/{tool-v}.json
      do.ts                         # Sandbox DO class (extends Sandbox); singleton session
      sandbox-exec.ts               # Two-phase egress + install + anc check + result parsing
      response-shape.ts             # Adds spec_version + anc_version + checker_url; validates triad
      content-negotiation.ts        # /api/score.md vs /api/score.json branching (extends accept.ts)
      summary-render.ts             # buildScoreSummaryBody (header + score + top-3 + CTA, no check tables)
dist/
  registry-index.json               # NEW — emitted artifact (gitignored)
  score.html                        # NEW — paste-input form page with install-anc CTA
  score.md                          # NEW — markdown twin of /score
  js/
    live-score.js                   # NEW — bundled output of src/client/live-score.ts
tests/
  worker.test.ts                    # MODIFIED — adds /api/score branch tests, extends CN preference list
  score-handler.test.ts             # NEW — unit tests for handler.ts
  score-validate.test.ts            # NEW — input validation matrix
  score-parse-install.test.ts       # NEW — install-command parser table
  score-discover-binary.test.ts     # NEW — GitHub URL discovery chain (mocked GitHub API)
  score-cache.test.ts               # NEW — R2 cache read/write
  score-response-shape.test.ts      # NEW — spec_version/anc_version/checker_url triad enforcement
  registry-index.test.ts            # NEW — build-time emission test
  score-contract.test.ts            # NEW — cross-validates /api/score JSON ↔ committed scorecards
  e2e/
    score.e2e.ts                    # NEW — Playwright form-submit happy path (chromium project, mocked API)
    score-live.e2e.ts               # NEW — opt-in live sandbox project (excluded from default suite)
docs/
  plans/
    2026-04-28-002-feat-live-scoring-cf-sandbox-plan.md  # this file (rewrite)
  runbooks/
    live-scoring-monitoring.md      # NEW — cost-watch, alert thresholds, common failures
wrangler.jsonc                      # MODIFIED — adds containers, durable_objects, migrations,
                                    #   r2_buckets, ratelimits bindings (mirror in env.staging)
.github/workflows/
  deploy.yml                        # MODIFIED — adds docker build + push step before wrangler deploy
RELEASES.md                         # MODIFIED — adds v3 release procedure (image + migration + smoke)
README.md                           # MODIFIED — mentions /score in the user-facing surface map
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
- Docker Hub repo created: `docker.io/brettdavies/anc-sandbox` with push access for the deploy workflow.

---

## Pre-Implementation Validation

**Status: PASSED 2026-05-04.** 76.0% tight hit rate against 50 trending CLI repos (≥70% threshold →
`pass-ship-as-written`). Per-language: Rust 92% / Python 50% / Go 85% / JS 75%. Two findings absorbed back into the
plan:

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

- U1. **Build-time registry-index + discovery-hints index emission**

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

- U2. **v3 sandbox image (Alpine + musl, no toolchains, anc bottle baked in)**

**Goal:** Build `docker/sandbox/Dockerfile` as a strict-minimal Alpine + musl image carrying CF Sandbox 0.8.x-musl,
package managers (apk, cargo-binstall, pip, npm, go runtime, brew if compatible), and a pre-built musl `anc` binary
downloaded from the agentnative-cli release. NO compilers, NO toolchains. Image budget: ~100-300 MB.

**Requirements:** R4, R8, R12 (image must fit `basic` instance type and stay under cost ceiling).

**Dependencies:** Cross-repo prerequisite (musl `anc` release published — see Dependencies & Prerequisites).

**Files:**

- Create: `docker/sandbox/Dockerfile`
- Create: `docker/sandbox/README.md`
- Test: `tests/dockerfile-sandbox.test.ts` (asserts image-size assertion via `docker image inspect` ≤350 MB; optional in
  CI behind a docker-available guard)

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
SDK. README documents the build-and-push workflow and the SHA-pin recipe.

---

- U3. **wrangler.jsonc — DO + Containers + R2 + ratelimits bindings**

**Goal:** Add the first DO + Containers + R2 + ratelimits bindings the Worker has ever shipped. Pre-push wrangler
dry-run gate must pass before push.

**Requirements:** R4, R5, R6. Foundational for U5-U7.

**Dependencies:** U2 (image must exist for `containers[].image` to reference).

**Files:**

- Modify: `wrangler.jsonc` (top-level + `env.staging` parallel bindings)
- Modify: `src/worker-configuration.d.ts` (regenerated via `bun run types`)
- Modify: `package.json` (verify `bun run types` runs `wrangler types`)
- Test: regression check that `wrangler deploy --dry-run` succeeds (already covered by pre-push hook)

**Approach:**

- Add to top-level `wrangler.jsonc`:
- `containers: [{ class_name: "Sandbox", image: "docker.io/brettdavies/anc-sandbox:<sha-pinned-tag>", instance_type:
  "basic", max_instances: 3 }]`
- `durable_objects: { bindings: [{ class_name: "Sandbox", name: "SCORE" }] }`
- `migrations: [{ tag: "v1", new_sqlite_classes: ["Sandbox"] }]` — must be `new_sqlite_classes`, not legacy
  `new_classes`. This is the ONE-WAY gate.
- `r2_buckets: [{ binding: "SCORE_CACHE", bucket_name: "anc-score-cache" }]`
- `ratelimits: [{ name: "SCORE_LIMITER", namespace_id: "1001", simple: { limit: 10, period: 60 } }]`
- Mirror all bindings in `env.staging` with staging-suffixed names: `anc-score-cache-staging`, distinct DO namespace,
  distinct ratelimit namespace.
- Stub the `Sandbox` DO class export in `src/worker/score/do.ts` BEFORE this unit so the dry-run passes; full
  implementation is U6.
- `image:` accepts `docker.io/...` directly (post-2026-03-24 capability).

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
- Integration: rolling back the migration is documented in `RELEASES.md` (follow-up migration with `deleted_classes`).

**Verification:** Pre-push wrangler dry-run passes locally; staging deploy succeeds; type generation includes all new
bindings; first prod deploy is its own milestone PR with the migration explicitly reviewed.

---

- U4. **Input parser + GitHub URL discovery chain**

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
- Create: `src/worker/score/response-shape.ts`
- Create: `src/worker/spec-version.gen.ts` (build-emitted; placeholder file lands in U5, build wiring lands in U8)
- Modify: `src/worker/headers.ts` (extend JSON branch to match `/api/` paths if needed)
- Modify: `src/worker/accept.ts` (extend preference list to `['text/html', 'application/json', 'text/markdown']`)
- Test: `tests/worker.test.ts` (extend with `/api/score` describe block)
- Test: `tests/score-handler.test.ts`
- Test: `tests/score-response-shape.test.ts`

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
3. Rate-limit check via `env.SCORE_LIMITER.limit({key: ipAddress})`. Miss → 429 with `Retry-After`, `X-Max-Assessments`,
   `X-Current-Assessments`. IP from `request.headers.get("CF-Connecting-IP")` (fallback `x-forwarded-for`, sentinel if
   missing).
4. R2 cache lookup (U7). Hit → shape response, return.
5. R2 miss → DO route (U6).
6. Always: `?fromCache=false` query param skips R2 read but does not skip R2 write.

- `content-negotiation.ts` extends `accept.ts`. New helper: `detectScorePreference(request)` returns `'json' |
  'markdown'`. JSON is default; markdown when `Accept: text/markdown` OR `.md` suffix.
- `response-shape.ts`: `shapeScoreResponse(scorecard, env): Response` — adds `spec_version` (from `SPEC_VERSION` build
  constant for live; from cached scorecard for cache hits), `anc_version` (from cache or live exec), `checker_url`
  (constant `https://anc.dev/score`). Asserts all three present; throws (→ 500) if any missing.
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

**Goal:** Implement the Sandbox DO class and the install + score flow. Two-phase egress is mandatory (R7). Singleton
container per design Premise #6.

**Requirements:** R4, R7, R11 (anc_version captured at exec time).

**Dependencies:** U2 (image), U3 (bindings), U4 (input → install spec), U5 (Worker routes to DO).

**Files:**

- Create: `src/worker/score/do.ts` (Sandbox DO class extending the SDK base)
- Create: `src/worker/score/sandbox-exec.ts` (orchestration)
- Test: `tests/score-do.test.ts` (unit tests with stubbed `Container` + `getSandbox`)

**Approach:**

- `do.ts`: Sandbox DO class extends the Sandbox base class. Implements `score(installSpec)` RPC method. Singleton ID:
  `getRandom(env.SCORE, 3, { sleepAfter: "5m" })` (3-instance pool; CF Containers picks an available instance per
  request).
- `sandbox-exec.ts` orchestrates:

1. Determine `installHosts` from `installSpec.pm` (e.g., `brew` → `["formulae.brew.sh", "ghcr.io", "github.com"]`;
   `cargo-binstall` → `["crates.io", "static.crates.io", "github.com"]`; `direct` → host of the URL).
2. `sandbox.setOutboundByHost(installHosts, "allowedInstall")` — Phase 1.
3. Run install command, captured by `installSpec.pm` (table in code):

- `brew install <pkg>` (if brew is available in the image)
- `cargo binstall --no-confirm <pkg>`
- `pip install <pkg>` (wheels only — `--only-binary=:all:`; refuses sdist execution)
- `npm install -g --ignore-scripts <pkg>` (skips preinstall/install/postinstall script execution; required to keep Phase
  1 egress from being abused by lifecycle scripts before `noHttp` fires)
- `go install <module>@latest`
- `direct`: `curl -fsSL <url> | tar xz -C /usr/local/bin/` (or unzip for `.zip`)

1. Verify binary on `PATH`: `which <binary>` returns 0; if not, fail with `chain_resolved_no_binary_produced` (per gate
   F4 — distinguishes "install succeeded but produced no runnable binary" from "install command itself failed"). Common
   failure mode: the chain resolved to a library-only pypi package (e.g. Click ships wheels but no `console_scripts`
   entry).
2. `sandbox.setOutboundHandler("noHttp")` — Phase 2.
3. `sandbox.exec("anc --version")` → capture `anc_version` (parse the stdout).
4. Look up registry entry by tool name to get `audit_profile` if known; else omit.
5. `sandbox.exec("anc check --command <binary> --output json [--audit-profile <p>]")` → parse JSON.
6. Return `{scorecard, anc_version}` to the Worker. DO writes-through to R2 via U7.

- Total budget: 60 s timeout on `sandbox.exec()` (install + score combined). Hard fail beyond → return 504 to user.
- Singleton container; sequential `exec()` calls. If concurrent requests stack, queue at the DO; the SDK serializes by
  default per single instance.

**Patterns to follow:**

-

[docs/solutions/architecture-patterns/cf-sandbox-secure-cli-execution-2026-04-17.md](../solutions/architecture-patterns/cf-sandbox-secure-cli-execution-2026-04-17.md)
— two-phase egress design. -
[docs/solutions/architecture-patterns/anc-cli-output-envelope-pattern-2026-04-29.md](../solutions/architecture-patterns/anc-cli-output-envelope-pattern-2026-04-29.md)
— anc JSON envelope shape; pass-through verbatim.

**Test scenarios:**

- **Happy path (cargo binstall):** install spec `{pm: "cargo-binstall", pkg: "ripgrep"}` → install succeeds → score
  succeeds → JSON returned with `anc_version` populated.
- **Happy path (brew):** install spec `{pm: "brew", pkg: "bat"}` → same.
- **Happy path (direct binary download):** install spec `{pm: "direct", url:
  "https://github.com/.../bird-x86_64-unknown-linux-musl.tar.gz", binary: "bird"}` → tarball downloaded, extracted,
  scored.
- **Edge case (`audit_profile` from registry):** known tool → `anc check --audit-profile human-tui ...` invoked.
- **Edge case (install fails — package not found):** sandbox returns non-zero from install; DO returns `{error:
  "chain_resolved_install_failed", details}`; Worker returns 502 to user. (Renamed from `install_failed` per gate F4 for
  symmetry with `chain_resolved_no_binary_produced` and `chain_no_resolve`.)
- **Edge case (binary not on PATH after install):** detected by `which` check; DO returns `{error:
  "chain_resolved_no_binary_produced"}`; Worker returns 502. (Renamed from `install_did_not_provide_binary` per gate F4.
  The `pallets/click` failure mode — wheel installs cleanly but no `console_scripts` entry.)
- **Error path (anc check exits non-zero):** preserve and forward the parsed error JSON if available.
- **Error path (60 s timeout):** DO returns `{error: "timeout"}`; Worker returns 504.
- **Error path (`setOutboundHandler` call fails):** DO returns 500; user-visible error message scrubs internals.
- **Integration:** assert two `setOutbound*` calls in correct order: `setOutboundByHost(...)` BEFORE install,
  `setOutboundHandler("noHttp")` AFTER install but BEFORE `anc check`. This is the safety invariant.
- **Integration:** stdout/stderr captured by `sandbox.exec` does not contain any host name from outside `installHosts ∪
  {"localhost"}` after Phase 2 — defense in depth assertion.
- **Integration:** response includes `anc_version` populated from the running binary (not from a constant).

**Verification:** Two-phase egress is provably enforced (test asserts the second handler call is `noHttp` BEFORE `anc
check` is exec'd). Timeout is honored. `anc_version` is captured live, never hard-coded.

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

- U8. **Site UX: `/score` form + theater + summary+top-3 render + install-anc CTA**

**Goal:** A user-facing page at `/score` with input, theater spinner, summary + top-3 issues result render, and
prominent install-anc-locally CTA. Markdown twin at `/score.md`. Build also emits `src/worker/spec-version.gen.ts`
constants.

**Requirements:** R1 (input), R9 (CTA primary), R10 (markdown twin).

**Dependencies:** U5 (`/api/score` exists and returns scorecards), U4 (validation surfaces error shapes for inline
errors).

**Files:**

- Create: `src/build/score-page.mjs`
- Create: `src/build/spec-version-gen.mjs` (emits `src/worker/spec-version.gen.ts`)
- Create: `src/client/live-score.ts` (form submit + fetch + theater + render)
- Create: `src/worker/score/summary-render.ts` (server-side `buildScoreSummaryBody`; reused by client via shared module)
- Modify: `src/build/build.mjs` (add `/score` to sub-page emission; call spec-version-gen.mjs)
- Modify: `dist/sitemap.xml` builder (add `/score`)
- Modify: `content/score.md` (NEW — agent-friendly description for the markdown twin, points to `/api/score`)
- Test: `tests/e2e/score.e2e.ts` (Playwright, chromium project)
- Test: `tests/e2e/score-live.e2e.ts` (opt-in live sandbox project, excluded from default suite)

**Execution note:** Defer wireframe-level layout decisions to `/design-review` after the basic page renders. Initial
implementation uses the existing per-tool scorecard page header/score/issues blocks.

**Approach:**

- `/score` HTML: single text input + submit. Examples shown below the input as clickable chips: `ripgrep`, `brew install
  bat`, `https://github.com/cli/cli`. Below input: hidden progress timeline (4 steps: validate → resolve → install →
  score) that fills in for live runs. Below: result area (summary + top-3 + CTA).
- Above the input on first paint: PRIMARY CTA banner — "Install `anc` and run it in your project for source + project
  depth: `brew install agentnative` or `cargo install agentnative`. The web demo below shows binary/behavioral checks
  only." This is the headline message; the form is below it. R9 framing.
- Client JS: on submit, `Promise.all([fetch('/api/score', {method:'POST', body:{input}}), new Promise(r => setTimeout(r,
  2000))])`. Minimum 2 s spinner per the cached-theater pattern.
- For live runs: progress polling. DO writes session state to R2 under `sessions/{sessionId}.json`. Client polls
  `/api/score?session=<id>` every 2 s. Initial implementation: client-side fake-progress timer is acceptable while real
  polling is wired up.
- `summary-render.ts`: new function `buildScoreSummaryBody(scorecard, topIssues)` reuses `buildScorecardHeader`,
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

- `/score.md` is a static markdown twin describing the form (not interactive); points agents to `/api/score` as the
  actual API endpoint. Includes the JSON response schema example and `Accept` header documentation.
- `spec-version-gen.mjs` emits:

  ```ts
  // GENERATED — do not edit. Regenerated by src/build/spec-version-gen.mjs.
  export const SPEC_VERSION = "0.3.0";        // from src/data/spec/VERSION
  export const SITE_SPEC_VERSION = "0.3.0";   // from content/principles/VERSION
  ```

  Imported by `src/worker/score/response-shape.ts`.

**Patterns to follow:**

- `src/build/skill.mjs` + `src/data/skill.json` — single-source data → HTML + MD + JSON precedent.
- `src/build/build.mjs:280` — `extraScripts: ['/js/live-score.js']` pattern for client JS injection.
-

[docs/solutions/architecture-patterns/cached-theater-live-fallback-2026-04-17.md](../solutions/architecture-patterns/cached-theater-live-fallback-2026-04-17.md)
— 2 s minimum theater.

- `src/build/scorecards-render.mjs:buildScorecardBody` for the header/score/issues blocks (extract shared helpers if
  needed; do not duplicate).

**Test scenarios:**

- **Happy path (Playwright chromium):** paste a registry slug → form spinner shows for ≥2 s → summary renders with top-3
  issues → CTA banner visible.
- **Happy path:** paste a parseable install command → same flow.
- **Happy path:** paste a GitHub URL for a registry-known tool → registry hit → cached scorecard.
- **Edge case:** paste an invalid input → form shows inline error from `/api/score` 400 response.
- **Edge case:** paste a non-GitHub URL → inline error.
- **Edge case:** 429 response → form shows "Try again in 60s" message with countdown.
- **Edge case (bounce: `chain_no_resolve`):** mocked 404 with that error tag → form renders the "couldn't find a
  pre-built binary" headline + R9 CTA, not a generic error.
- **Edge case (bounce: `chain_resolved_install_failed`):** mocked 502 with that error tag → form renders the "install
  path didn't run" headline AND the install command + truncated stderr excerpt from the response details.
- **Edge case (bounce: `chain_resolved_no_binary_produced`):** mocked 502 with that error tag → form renders the "looks
  like a library, not a CLI" headline + retry-with-explicit-command affordance.
- **Integration:** `/score.md` markdown twin is in sitemap, renders agent-friendly description with API schema.
- **Integration (live sandbox project, opt-in):** paste a real unknown tool with installable binary → progress timeline
  animates → summary renders within 60 s.

**Verification:** Default Playwright suite (chromium) covers form happy path + error paths with mocked `/api/score`. The
opt-in `score-live` project covers a real sandbox round-trip (excluded from default suite, runs manually + nightly).

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
- Modify: `.github/workflows/deploy.yml` (add docker build + push step before `wrangler deploy`; add post-deploy smoke
  step against staging)
- Modify: `RELEASES.md` (v3 release procedure: image build + push, deploy migration, smoke, rollback)
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
- Image build + push step (Docker Hub, SHA-pinned in `wrangler.jsonc`).
- Migration v1 (one-way gate). Document rollback (follow-up migration with `deleted_classes`).
- Smoke test post-deploy.
- Triple-diff already in the runbook (per PR #69).
- **Runbook contents:**
- Cost-watch for first 30 days: daily R2 storage, DO requests, Container vCPU-seconds. Thresholds: R2 >$1/mo, Container
  >$15/mo trigger a review.
- Common failures: install timeout (network), `anc check` exit non-zero (real fail vs runner bug), R2 write fail
  (best-effort, alert if sustained), discovery chain false-negative (README parse missed an obvious install — capture
  for v3.1 LLM upgrade evidence).
- Alert: 5xx rate >1% over 10 min → page (whatever paging we wire up).
- Manual rollback: redeploy previous image tag in `wrangler.jsonc`; DO migrations are sticky so the DO class stays.
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

## Risk Analysis & Mitigation

| Risk                                                                                  | Likelihood | Impact             | Mitigation                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------- | ---------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Upstream musl release slips or doesn't pass review                                    | Med        | High (blocks plan) | Cross-repo plan filed first as Dependencies & Prerequisites with pre-addressed review concerns (artifact size, release-time delta, MSVC sibling matrix, runtime behavior). If rejected or stalls beyond bandwidth, **v3 PAUSES and returns to /plan-ceo-review** — compile-in-our-CI is NOT a silent fallback (reverses Premise #2). |
| First-ever DO + Containers + R2 + migrations bindings — one-way gate                  | High       | High               | Stage as a pre-launch dry-run on staging; verify rollback procedure (`deleted_classes` follow-up migration) before prod deploy. First v3 deploy is its own milestone PR; no other changes bundled.                                                                                                                                   |
| Image size creeps past 350 MB → cost premium / `basic` doesn't fit                    | Med        | Med                | Size assertion in `tests/dockerfile-sandbox.test.ts`. Per-build size delta in CI. Custom instance type as escape hatch (`{ vcpu: 1, memory_mib: 1024, disk_mb: 4096 }`). Brew if compatible adds the most weight; consider dropping if the cost/benefit is wrong.                                                                    |
| HN spike >10× expected → cost overrun                                                 | Low        | Med                | `max_instances: 3` pool + `SCORE_LIMITER` (10 req/60s/IP). Surplus traffic gets queued or 429'd. Cost ceiling: 3 instances × `basic` × 4 h spike ≈ $1.50-3 raw + active-CPU bounded by limiter, well under R12. Kill-switch (set `max_instances: 0`) documented in U9 runbook for breach scenarios.                                  |
| Cloudflare changes Sandbox SDK API mid-flight                                         | Low        | Med                | Pin `@cloudflare/sandbox@0.8.x` exact version; mirror Docker tag SHA-digest; review CF changelog before each version bump.                                                                                                                                                                                                           |
| `anc check` flag mismatch (e.g., `--command` semantics change in v0.4)                | Low        | Med                | Pin `anc` to a tagged release in the image build. Plan a v3.0.1 to consume each new `anc` after launch settles.                                                                                                                                                                                                                      |
| GitHub anonymous API rate limit (60/hr/IP) bites discovery chain                      | Med        | Med                | Pooled CF egress IPs amortize. R6 rate-limit caps at ~14k/day at 100% miss → ~580/hr peak (well under aggregate egress IP allotment). If bites: add GitHub App token via Outbound Worker as v3.1.                                                                                                                                    |
| README parse heuristic misses installable tools (false-negative)                      | Med        | Low                | Failure mode is bounce-out with R9 CTA — never wrong-answer, only missed-opportunity. Capture misses for v3.1 LLM upgrade evidence (runbook).                                                                                                                                                                                        |
| Smart Tiered Cache + R2 + custom-domain misconfig serves stale data                   | Low        | Med                | Content-addressed keys (`anc-version` + `tool-version`); stale-by-construction is impossible. Cache TTL 24 h + version-suffixed key.                                                                                                                                                                                                 |
| Two-phase egress race: `noHttp` not applied before `anc check` execs                  | Low        | Critical           | Sequential `await` between the two calls. Integration test asserts the order via stubbed handler call log.                                                                                                                                                                                                                           |
| User pastes a private repo → 404 surface unhelpful                                    | Med        | Low                | Friendly 404: "anc.dev only scores public repos. Run `anc check .` locally for private code."                                                                                                                                                                                                                                        |
| Discovery chain timeouts cascade and block the whole request                          | Low        | Med                | Each step bounded ≤2 s; total ≤8 s. After 8 s: bounce out with R9 CTA. Surface this as a "took too long to find an installable binary" message, not a generic 500.                                                                                                                                                                   |
| Worker bundle size (Sandbox SDK + handler code) breaches 1 MiB Worker free-tier limit | Low        | Med                | Measure bundle size in CI (already part of build); if >900 KiB, switch to Workers paid plan ($5/mo) which raises the limit to 10 MiB.                                                                                                                                                                                                |
| `audit_profile` from registry doesn't apply when scoring an unknown tool              | High       | Low                | Unknown tools get no `--audit-profile` flag; `anc` defaults to no profile (all checks). Document in runbook; add `audit_profile` to the discovery-chain output if we can infer it.                                                                                                                                                   |

---

## Documentation / Operational Notes

- **RELEASES.md (U9).** Add v3 release procedure: image build + push step, migration apply, smoke test, rollback steps.
  The first v3 deploy is its own PR (no other changes bundled) so the migration is reviewable. Triple-diff recipe (added
  in PR #69) extends to cover the new image-tag SHA pin in `wrangler.jsonc`.
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
  (a) CF Sandbox 0.8.x outbound-handler shape + TLS interception defaults; (b) Workers Rate Limiting binding choice
  (Option A vs DO counter); (c) README install-block parsing heuristic specifics + miss-rate data; (d) GitHub Releases
  binary-discovery shape; (e) CF Sandbox cold-start measurements + `basic` vs `standard-1` sizing rationale.

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
-

[2026-03-24 Docker Hub direct images changelog](https://developers.cloudflare.com/changelog/post/2026-03-24-docker-hub-images/)

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
