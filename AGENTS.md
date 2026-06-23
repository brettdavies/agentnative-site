# Agent Instructions

The agentnative spec site. This file is for any agent (Claude Code or otherwise) opening this repo fresh.

## Project

A site that publishes the agent-native CLI standard (the 8 principles for CLI tools operated by AI agents). The site is
the primary launch surface for agentnative. The standard is what launches; the tool (`brettdavies/agentnative-cli`) is
how you use it.

## Authoritative scope

The scope for v0 is decided and lives in:

- `~/.gstack/projects/brettdavies-agentnative-site/ceo-plans/2026-04-13-spec-site.md`: approved scope, gaps to close,
  deployment ordering, test plan. Read this before making scope choices.
- `docs/TODOS.md`: deferred work for later phases (live scorecard embed, versioned spec, community PR flow,
  `--agent-caps` docs, davies.fyi cross-link).
- `~/obsidian-vault/Projects/brettdavies-agentnative/principles/`: authoritative spec for the 8 principles (one file per
  principle, MUST/SHOULD/MAY requirements, pressure-testable). The site's principle copy in `content/principles/` is
  written **manually** from these files. No build-time import, no live link. When you write or edit site copy, read the
  relevant `p<n>-*.md` spec file first. Do not edit the spec to match the site; propagate in the other direction,
  deliberately.
- `src/data/spec/`: vendored snapshot of `brettdavies/agentnative` (the canonical spec repo) at a pinned tag. Contains
  `VERSION` (the spec version this snapshot is at; exported as `SPEC_VERSION` from `src/build/util.mjs`, reference /
  diff target only, NOT used for any user-visible surface), `CHANGELOG.md`, and `principles/p*-*.md` (machine-readable
  frontmatter, diff target only, NOT consumed by site rendering). Refreshed via `scripts/sync-spec.sh` (remote-first;
  auto-picks the latest v* tag). The site copy in `content/principles/` and the vendored spec at
  `src/data/spec/principles/` coexist intentionally, because they serve different audiences (humans vs machines) and
  their reconciliation is a deliberate editorial act, not a derivation.
- `content/principles/VERSION`: the spec version the site's PROSE has been **reconciled to**. Exported as
  `SITE_SPEC_VERSION` from `src/build/util.mjs` and rendered in the site footer. Bumped MANUALLY by the contributor who
  reconciles `content/principles/p*-*.md` after a `sync-spec.sh` run, because bumping before reconciliation lies to
  visitors about site currency. Always ≤ `SPEC_VERSION`; lag during the manual reconciliation window is honest. The
  badge SVGs use a different source (each scorecard's own `spec_version` field), and the OG card uses anc's
  self-scorecard's `spec_version`. Three sources for three different events (vendor / score / reconcile).
- Workflow detail in [`src/data/spec/README.md`](src/data/spec/README.md); cross-repo version model at
  [`docs/solutions/best-practices/agentnative-version-model-2026-05-01.md`](docs/solutions/best-practices/agentnative-version-model-2026-05-01.md);
  governing pattern at
  [`docs/solutions/best-practices/cross-repo-artifact-consumption-static-sites-2026-04-21.md`](docs/solutions/best-practices/cross-repo-artifact-consumption-static-sites-2026-04-21.md).

## Thesis

This is the first proof-of-concept for an **agent-native documentation surface**. The CLI tool eats its own dog food at
the CLI layer; the spec site eats its own dog food at the documentation layer via markdown-first authoring, implicit
`.md` URLs, `Accept: text/markdown` content negotiation, `llms.txt` + `llms-full.txt`, Schema.org JSON-LD, stable
anchors, and semantic HTML. Keep this framing in every decision.

## Structure

- `index.html`: single-page surface for the 8 principles, anchor-linked (`#p1-...` through `#p8-...`)
- `/audit`: usage for the `anc` CLI (flags, output shapes, audit-ID conventions)
- `/install`: human-facing install page for the `agentnative` CLI itself (HTML + markdown twin only, no JSON manifest;
  `brew`, `cargo`, and platform archives, sourced from `content/install.md`)
- `/about`: attribution, versioning, credits (subtle: the site does not lead with Brett's name)
- `/skill`: human-facing install page for the `agent-native-cli` skill bundle (rendered HTML; mixed-register prose +
  per-host clone commands)
- `/skill.json`: canonical machine-primary skill manifest. Same data, agent-readable. `Content-Type: application/json`,
  `X-Robots-Tag: noindex`. Both `/skill` and `/skill.json` derive from `src/data/skill/skill.json` at build time; full
  surface contract in `DESIGN.md` §3.9
- `content/*.md`: markdown source of truth for every page (principle files, check, about, index)
- Cloudflare Worker: routes requests. `.md` suffix OR `Accept: text/markdown` returns raw markdown source; otherwise
  returns HTML rendered from the same markdown via CommonMark
- `/llms.txt`, `/llms-full.txt`: llmstxt.org convention (summary index + full concatenated spec)
- `/mcp`: streamable HTTP Model Context Protocol server. Client skill in [`content/mcp-skill.md`](content/mcp-skill.md);
  canonical server card at `/.well-known/mcp/server-card.json` (legacy alias `/.well-known/mcp`); HTML + `.md` twin at
  `/mcp-skill`
- `/sitemap.xml`, `/robots.txt`: hygiene
- `public/og-image.png`: 1200x630 designed social preview

Plain HTML + minimal CSS + small Worker script. No frontend framework, no build pipeline beyond the Worker's CommonMark
render step. Deploy via `wrangler`.

## MCP server

`POST https://anc.dev/mcp` exposes the catalog over a streamable HTTP MCP server pinned to spec revision `2025-06-18`.
The client integration guide is [`content/mcp-skill.md`](content/mcp-skill.md) (served at `/mcp-skill.md` and
`/mcp-skill/`); operator-facing material lives in [`docs/runbooks/mcp-operator.md`](docs/runbooks/mcp-operator.md) and
is not published. This section is the agent-onboarding summary: enough to know what the surface is, what it costs, and
how it fails.

**Discovery siblings.** `/.well-known/mcp/server-card.json` (SEP-1649 canonical server card; legacy aliases
`/.well-known/mcp`, `/mcp.json`), `/.well-known/ai.txt` (`Programmatic-API` declaration),
`/.well-known/security.txt` (RFC 9116 contact), `/llms.txt` (Programmatic access section). The server card's
`documentation` field is the client-skill `.md` URL; `initialize.instructions` carries the same pointer plus a
session-time summary.

**Nine tools, five resources.** Tools cover four surfaces:

- Registry: `list_tools`, `get_tool`, `search_tools`
- Principles: `list_principles`, `get_principle`
- Spec: `list_spec_sections`, `get_spec_section`
- Scorecards: `get_scorecard` (cache read), `score_cli` (cache-miss audit)

Resources: `anc://registry` (concrete) plus four templates `anc://tool/{slug}`, `anc://principle/{n}`,
`anc://spec/{section}`, `anc://scorecard/{binary}`.

**Two rate limits, two cost profiles.** `MCP_LIMITER` gates every `POST /mcp` at 60 requests per 60 seconds per IP and
falls back to a shared `anon` bucket on missing `cf-connecting-ip`. `MCP_AUDIT_LIMITER` gates `score_cli` cache-miss
audits only, at 5 fresh audits per 60 minutes per IP, with **no anon fallback**. Missing IP returns `-32099` rather than
consuming a shared bucket, because container-run cost is non-trivial. The hourly window is enforced in two layers: the
CF Rate Limiting binding only accepts `period: 10 | 60`, so the binding holds the 5-per-60-seconds burst floor and an
application-side KV-backed per-hour window in `SCORE_KV` (`mcp_audit:<ip>:<hour_bucket>`, 2-hour TTL) enforces the
hourly ceiling.

**Cost gate: `score_cli` never bypasses the cache.** No `force_refresh` flag and no path through the surface that forces
a fresh audit on an already-cached binary. `get_scorecard` is the cheap signal; `score_cli` is the metered one. The two
tools compose the same `/api/score` orchestration core, so cache semantics never drift between MCP and the human form on
`/`.

**Two kill switches, surgical and zero-deploy.** Both default `"false"` in production and `"true"` in staging. Flip via
`wrangler secret put`.

- `MCP_ENABLED`: gates the whole `/mcp` branch. Falsy returns `503 Service Unavailable` with `Retry-After: 3600` and a
  one-line plain-text body. No JSON-RPC envelope, because the surface is off, not in-error.
- `MCP_LIVE_SCORING_ENABLED`: gates only `score_cli`. Falsy returns `isError: false` with `audited: false` and a typed
  `next_tool: get_scorecard` redirect; the read tier stays alive.

**Errors carry on two layers.** Tool-level failures return `CallToolResult` with `isError: true` plus a textual message;
the JSON-RPC envelope itself is successful. Transport-level failures return JSON-RPC error envelopes at HTTP 200:
`-32700` for malformed JSON, `-32099` for rate-limit breach at either limiter. The `406 Not Acceptable` Accept-header
rejection is the one transport error that bypasses the JSON-RPC envelope (the rejection is pre-parse, so there is no
`id` to echo back). **Cache state is data, not failure**: a `get_scorecard` miss is `isError: false` with `found: false,
next_tool`, and a `score_cli` hit is `isError: false` with `audited: false, next_tool`.

**Origin posture: server-to-agent, no CORS.** `POST /mcp` returns no `Access-Control-Allow-Origin` header. MCP clients
are agent runtimes (Claude Code, Codex, Cursor, custom CLIs) that do not issue CORS preflights. Browser-origin POSTs
fail the browser's same-origin check and are blocked client-side. This is the deliberate posture, because a
browser-reachable `/mcp` would let any malicious web page trigger `score_cli` runs charged against the visitor's
`cf-connecting-ip`. A future use case needing browser access gets its own KTD revision, an explicit allow-list, and a
rate-limit policy designed for browser traffic.

**Visitor log: one structured line per call, AFTER the gate decision.** Every `POST /mcp` request emits one `[mcp-call]`
log line carrying `Origin`, `User-Agent`, Cloudflare-injected client IP and country, the chosen response format, and a
`gate_result` of `passed` or `rate_limited`. Firing after the rate-limit gate keeps Workers Logs volume bounded under
attack while still recording the denial. The log is the public posture for a no-auth catalog: the surface is open, the
inventory is published.

**Spec revision drift gate.** The handshake's `protocolVersion`, `/.well-known/mcp/server-card.json`
`protocolVersion`, `content/mcp-skill.md`'s wire-level reference block, and `src/worker/mcp/instructions.ts`'s
`SPEC_REVISION` constant all carry the same `2025-06-18` literal. `tests/worker-mcp.test.ts` and
`tests/e2e/discoverability.e2e.ts` assert each occurrence so a single-source bump breaks the build.

## Voice

The site speaks as a **standard**, not a person. Think RFC, not blog post.

- Good: "CLI tools that block on interactive prompts are invisible to agents. The agent hangs, the user sees nothing,
  and the operation times out silently."
- Bad: "We believe that CLI tools should be non-interactive because agents can't handle prompts."
- Good: "MUST support `--output json` for machine-readable output."
- Bad: "It's really important to have JSON output for your CLI."

Use RFC 2119 language (MUST, SHOULD, MAY) for requirements. Concrete examples, not abstractions. Show the failure mode,
then show the fix.

The brand voice anchor is the xAI cover letter in the obsidian vault. Brand doc (see cross-repo table) carries
positioning context. Treat its tactical design specifics as placeholders, not settled. The strategic framing (phases,
narrative, attribution rules) is load-bearing.

## Visual design

**Not settled.** Reference-site survey is the first action before writing HTML (see "First action" below). Preferences:

- Simple and traditional, with modern web flair (user-stated)
- clig.dev > 12factor.net as a baseline feel
- Dark mode via `prefers-color-scheme` (no toggle)
- Mobile-first; a11y baseline (skip-link, semantic landmarks, `>= 4.5:1` contrast, `:focus-visible`,
  `prefers-reduced-motion`)

The design-survey step produces a `DESIGN.md` in the repo with palette, type stack, spacing scale, code-block treatment,
and dark/light tokens before any HTML is written.

Design context consumed by the `/impeccable` and `/typeset` skills (users, brand personality, aesthetic direction,
design principles): [`PRODUCT.md`](PRODUCT.md).

## Visual fidelity

Two gates protect against visual regressions slipping past unit tests, which only assert HTML structure, not rendered
appearance.

### Browser-verify before declaring "done"

Any change that touches CSS, design tokens, layout, color, or component HTML must be verified in an actual browser
before the unit is reported complete. `bun test` and `bun run build` going green does not count, because neither renders
the page, neither resolves dark-mode token overrides, neither catches "near-white text on near-white background" failure
modes that surface only under a specific theme.

The verification is mechanical:

1. Open the changed page on staging (or local `bun run dev`) in a browser.
2. Toggle through both themes (light + dark) using the in-page toggle. Confirm the changed surface reads correctly under
   each: text is legible against background, borders register as edges, interactive elements stay distinguishable from
   prose.
3. Capture a screenshot for the PR description when the change is non-trivial.

This rule exists because of a launch-eve regression: `var(--bg-subtle, ...)` shipped where the canonical token is
`--bg-raised`. The fallback hex was a sensible light-mode color, so light mode looked plausible; dark mode left
near-invisible callout text. Tests passed, build was green. Browser-verification would have caught it in 30 seconds. PR
[#50](https://github.com/brettdavies/agentnative-site/pull/50) is the fix; this gate is the prevention.

The rule scales with risk. A typo in a heading: skip. Any new CSS rule, any token change, any layout-affecting HTML
edit: verify.

### Visual-regression snapshot tests

Planned, not yet shipped. Playwright will capture a baseline screenshot of each key surface (leaderboard, per-tool
scorecard pages, `/badge`, `/skill`, the seven principle pages) in both light and dark themes. CI will diff against the
baseline; non-trivial pixel deltas fail the run.

This protects against the failure mode the browser-verify rule depends on humans catching: an agent or human pushes a
"non-visual" change that nonetheless shifts the rendered page. Snapshot tests don't require a brain in the loop.

The tooling is heavier than the lint-rule alternatives (baseline images need maintenance, flake budgets need
discipline), so the rollout is deferred until the design system is stable enough for a baseline to be load-bearing.
Until then, the agent-side browser-verify rule above is the working gate.

## Local dev

`bun run dev` (which runs `bun run build && wrangler dev --env staging --local --port 8787`) on `http://localhost:8787`
is the only valid local preview. The Worker entrypoint at `src/worker/index.ts` is the source of content negotiation,
the `applyHeaders` policy (`Link: rel=alternate`, `X-Llms-Txt`, staging `X-Robots-Tag: noindex`, `Cache-Control`), the
`/mcp` transport, the `/api/score` + `/score/live/<binary>` live-scoring path, the `/check` → `/audit` redirect, the
`/_internal/*` 404 guard, and the homepage `{{TURNSTILE_SITEKEY}}` substitution. Without the Worker, none of those
contracts are visible. Static-file servers (`python -m http.server`, `serve`, `npx http-server`, etc.) bypass the Worker
entirely and produce a false preview. Never use them to verify any of those surfaces or the `.md`-twin contract.

```bash
bun run dev    # http://localhost:8787, staging bindings, local Worker
```

`--env staging` is load-bearing: it picks up the staging container image pin, `MCP_ENABLED="true"`, the always-pass
Turnstile test secret, and the staging R2 / KV / rate-limit namespaces. The top-level (production) env defaults
`MCP_ENABLED="false"` and may carry a container pin that fails to boot locally. `--local` keeps the rate-limit
namespaces, R2, and asset directory in-process; dropping it would route to the deployed staging Worker and bypass the
local build.

Production-mode preview (rare, only when verifying the production block of `wrangler.jsonc`):

```bash
bun run build
wrangler dev --local --port 8787    # top-level (production) Worker shape, no --env
```

Port `8787` is pinned in the dev script per the `[Always bind local previews to port 8787]` convention; kill anything
already bound there rather than picking a fallback.

## Cross-repo context

| Repo / Location                                                                                     | What to read                                                                                                                   | Why                                                                                                                                                                                                                                |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `~/.gstack/projects/brettdavies-agentnative-site/ceo-plans/2026-04-13-spec-site.md`                 | CEO plan                                                                                                                       | v0 scope, gaps, deployment ordering, test plan. Authoritative.                                                                                                                                                                     |
| `~/.claude/skills/agent-native-cli/references/framework-idioms.md`                                  | Rust/clap patterns                                                                                                             | Code examples for principles.                                                                                                                                                                                                      |
| `~/.claude/skills/agent-native-cli/references/framework-idioms-other-languages.md`                  | Python/Go/Node patterns                                                                                                        | Code examples for other languages.                                                                                                                                                                                                 |
| `~/.gstack/projects/brettdavies-obsidian-vault/brett-main-design-20260413-181410.md`                | Brand system design doc                                                                                                        | HN Launch Package strategy. Strategic framing is load-bearing; tactical visual specifics are placeholders.                                                                                                                         |
| `~/.gstack/projects/brettdavies-agentnative/brett-main-design-20260327-214808.md`                   | agentnative CLI design doc                                                                                                     | The tool this site promotes. The site's `cargo install agentnative` CTA depends on v0.1 of this tool being on crates.io.                                                                                                           |
| `~/.gstack/projects/brettdavies-agentnative/brett-main-naming-rationale-20260327.md`                | Naming rationale                                                                                                               | Why "agentnative" and "anc".                                                                                                                                                                                                       |
| `~/obsidian-vault/Projects/brettdavies-Brand-System/seed-material/xAI-Cover-Letter-VOICE-ANCHOR.md` | Voice anchor                                                                                                                   | Canonical in-voice exemplar for Brett (not this site's tone, but useful for adjacent surfaces).                                                                                                                                    |
| `docs/solutions/` (symlink to `~/dev/solutions-docs/`)                                              | Cross-repo documented solutions; includes the agent-native documentation surface pattern that informs this site's architecture | Organized by category with YAML frontmatter (`module`, `tags`, `problem_type`). Search with `qmd query "<topic>" --collection solutions`. Relevant when researching architecture or tooling patterns before building from scratch. |
| `~/obsidian-vault/Projects/brettdavies-agentnative/research/index.md`                               | Shared research index for both this site and the `agentnative` CLI linter                                                      | External signal (blog posts, HN threads, competitor CLIs) extracted into curated quotes + principle mapping. Read before writing principle copy or launch framing that cites third parties.                                        |
| `~/obsidian-vault/Projects/brettdavies-agentnative/principles/index.md`                             | Canonical spec for P1-P8 (one file per principle, pressure-testable)                                                           | Source of truth for principle meaning. Site copy in `content/principles/` is written **manually** from these files. No build-time import, no live link. When principle spec changes, propagate to site copy deliberately.          |
| `~/.gstack/projects/brettdavies-agentnative-site/brett-main-build-plan-20260414-130000.md`          | Build & distribution plan                                                                                                      | Scaffolding decisions for /ce-plan and /ce-work: target repo tree, build pipeline, deployment. Locked decisions; Cloudflare-specifics verified.                                                                                    |
| `~/.gstack/projects/brettdavies-agentnative-site/brett-main-eng-review-20260414-123800.md`          | Eng review                                                                                                                     | Architecture + code quality + test coverage review for M1. §12 lists all DESIGN.md edits. Decisions resolved; no blockers.                                                                                                         |
| `docs/plans/2026-04-17-001-feat-registry-leaderboard-scorecard-pages-plan.md`                       | Registry + leaderboard plan                                                                                                    | Plan 1 scope: tool registry, pre-computed scorecards, `/scorecards` leaderboard, `/score/<tool>` pages. Plan 2 (live scoring via CF Sandbox) is separate.                                                                          |

## Related repos

- `brettdavies/agentnative-cli` (`~/dev/agentnative`, tmux `anc`): the Rust CLI linter. The site's core CTA links to it.
- `brettdavies/brettdavies` (`~/dev/brettdavies`): GitHub profile. Single-commit policy (amend + force-push-with-lease).
- `brettdavies/davies.fyi`: does not exist yet. The site's /about page will eventually link to it.

## Repo conventions

- **Branches:** `main` (production) and `dev` (integration) are both forever branches. Feature work lands via `feat/*` /
  `fix/*` / `chore/*` → PR to `dev` (squash merge). Dev ships to main via a short-lived `release/*` branch cherry-picked
  from `origin/main`, PR'd to main. Direct commits to `dev` or `main` are not permitted. See
  [`RELEASES.md`](./RELEASES.md) for the full workflow.
- **Commits:** Conventional Commits. Short, specific messages.
- **PRs:** Squash merge. PR title becomes commit title; PR body becomes commit body (repo setting:
  `squashMergeCommitMessage: PR_BODY`).
- **Rulesets:** `.github/rulesets/protect-main.json` and `protect-dev.json` are the source of truth for branch
  protection; apply via `gh api` (see `RELEASES.md § Branch protection`).
- **CI:**
- `ci.yml`: fast PR gate (lint · build · test · wrangler dry-run).
- `deep-check.yml`: scheduled Playwright + Lighthouse with a preflight that only runs when ci.yml has passed since the
  last deep-check.
- `deploy.yml`: publishes to the `*.workers.dev` staging on every push to `main`.
- `guard-main-docs.yml`: blocks `docs/plans/`, `docs/solutions/`, `docs/brainstorms/` from reaching main.
- `guard-release-branch.yml`: rejects PRs to main whose head isn't `release/*`.

## Tool-site sequencing (do not violate)

The site's "Audit your CLI" CTA runs `cargo install agentnative`. That command only succeeds once the tool's v0.1 ships
to crates.io. Until then:

- Local development and `workers.dev` staging deploys are fine.
- Do **not** attach the production domain or publish HN links until `agentnative` v0.1 is installable from crates.io.

## Domain ownership

The production domain (candidates: agentnative.dev / .io / .org) is **Brett's purchase**. An agent cannot buy it. Stub
`wrangler.toml` with a placeholder domain; document the one-line swap procedure for when Brett purchases the real one.

## First action for a fresh agent session

1. Read the CEO plan (link above). This is the single source of truth for v0 scope.
2. Read `~/obsidian-vault/Projects/brettdavies-agentnative/principles/index.md` and the eight `p<n>-*.md` files: the
   authoritative spec that the site's `content/principles/` copy is written from (manually, not auto-derived).
3. Run a reference-site survey for visual design (clig.dev, 12factor.net, htmx.org, rust-lang.org book, json-schema.org,
   fly.io docs, matklad.github.io; pick 3-4 that embody "simple, traditional, modern flair" and extract tokens). Produce
   `DESIGN.md` before writing any HTML.
4. Scaffold the markdown sources in `content/` first, then the Worker + HTML renderer, then wire deploy.
5. Check in with Brett before attaching the production domain.
