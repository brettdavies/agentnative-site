# Agent Instructions

The agentnative spec site. This file is for any agent (Claude Code or otherwise) opening this repo fresh.

## Project

A site that publishes the agent-native CLI standard (the 7 principles for CLI tools operated by AI agents). The site is
the primary launch surface for agentnative. When the HN post goes live ("Show HN: agentnative — check if your CLI is
agent-native"), it links here. The standard is what launches; the tool (`brettdavies/agentnative`) is how you use it.

## Authoritative scope

The scope for v0 is decided and lives in:

- `~/.gstack/projects/brettdavies-agentnative-site/ceo-plans/2026-04-13-spec-site.md` — approved scope, gaps to close,
  deployment ordering, test plan. Read this before making scope choices.
- `TODOS.md` — deferred work for later phases (live scorecard embed, versioned spec, community PR flow, `--agent-caps`
  docs, davies.fyi cross-link).
- `~/obsidian-vault/Projects/brettdavies-agentnative/principles/` — authoritative spec for the 7 principles (one file
  per principle, MUST/SHOULD/MAY requirements, pressure-testable). The site's principle copy in `content/principles/` is
  written **manually** from these files — no build-time import, no live link. When you write or edit site copy, read the
  relevant `p<n>-*.md` spec file first. Do not edit the spec to match the site; propagate in the other direction,
  deliberately.

## Thesis

This is the first proof-of-concept for an **agent-native documentation surface**. The CLI tool eats its own dog food
at the CLI layer; the spec site eats its own dog food at the documentation layer via markdown-first authoring, implicit
`.md` URLs, `Accept: text/markdown` content negotiation, `llms.txt` + `llms-full.txt`, Schema.org JSON-LD, stable
anchors, and semantic HTML. Keep this framing in every decision.

## Structure

- `index.html` — single-page surface for the 7 principles, anchor-linked (`#p1-...` through `#p7-...`)
- `/check` — install and usage for the `anc` CLI
- `/about` — attribution, versioning, credits (subtle: the site does not lead with Brett's name)
- `content/*.md` — markdown source of truth for every page (principle files, check, about, index)
- Cloudflare Worker — routes requests: `.md` suffix OR `Accept: text/markdown` returns raw markdown source; otherwise
  returns HTML rendered from the same markdown via CommonMark
- `/llms.txt`, `/llms-full.txt` — llmstxt.org convention (summary index + full concatenated spec)
- `/sitemap.xml`, `/robots.txt` — hygiene
- `public/og-image.png` — 1200x630 designed social preview

Plain HTML + minimal CSS + small Worker script. No frontend framework, no build pipeline beyond the Worker's
CommonMark render step. Deploy via `wrangler`.

## Voice

The site speaks as a **standard**, not a person. Think RFC, not blog post.

- Good: "CLI tools that block on interactive prompts are invisible to agents. The agent hangs, the user sees nothing,
  and the operation times out silently."
- Bad: "We believe that CLI tools should be non-interactive because agents can't handle prompts."
- Good: "MUST support `--output json` for machine-readable output."
- Bad: "It's really important to have JSON output for your CLI."

Use RFC 2119 language (MUST, SHOULD, MAY) for requirements. Concrete examples, not abstractions. Show the failure
mode, then show the fix.

The brand voice anchor is the xAI cover letter in the obsidian vault. Brand doc (see cross-repo table) carries
positioning context — treat its tactical design specifics as placeholders, not settled. The strategic framing (phases,
narrative, attribution rules) is load-bearing.

## Visual design

**Not settled.** Reference-site survey is the first action before writing HTML (see "First action" below). Preferences:

- Simple and traditional, with modern web flair (user-stated)
- clig.dev > 12factor.net as a baseline feel
- Dark mode via `prefers-color-scheme` (no toggle)
- Mobile-first; a11y baseline (skip-link, semantic landmarks, `>= 4.5:1` contrast, `:focus-visible`,
  `prefers-reduced-motion`)

The design-survey step produces a `DESIGN.md` in the repo with palette, type stack, spacing scale, code-block
treatment, and dark/light tokens before any HTML is written.

Design context consumed by the `/impeccable` and `/typeset` skills (users, brand personality, aesthetic direction,
design principles): [`.impeccable.md`](.impeccable.md).

## Cross-repo context

| Repo / Location | What to read | Why |
|---|---|---|
| `~/.gstack/projects/brettdavies-agentnative-site/ceo-plans/2026-04-13-spec-site.md` | CEO plan | v0 scope, gaps, deployment ordering, test plan. Authoritative. |
| `~/.claude/skills/agent-native-cli/references/framework-idioms.md` | Rust/clap patterns | Code examples for principles. |
| `~/.claude/skills/agent-native-cli/references/framework-idioms-other-languages.md` | Python/Go/Node patterns | Code examples for other languages. |
| `~/.gstack/projects/brettdavies-obsidian-vault/brett-main-design-20260413-181410.md` | Brand system design doc | HN Launch Package strategy. Strategic framing is load-bearing; tactical visual specifics are placeholders. |
| `~/.gstack/projects/brettdavies-agentnative/brett-main-design-20260327-214808.md` | agentnative CLI design doc | The tool this site promotes. The site's `cargo install agentnative` CTA depends on v0.1 of this tool being on crates.io. |
| `~/.gstack/projects/brettdavies-agentnative/brett-main-naming-rationale-20260327.md` | Naming rationale | Why "agentnative" and "anc". |
| `~/obsidian-vault/Projects/brettdavies-Brand-System/seed-material/xAI-Cover-Letter-VOICE-ANCHOR.md` | Voice anchor | Canonical in-voice exemplar for Brett (not this site's tone, but useful for adjacent surfaces). |
| `docs/solutions/` (symlink to `~/dev/solutions-docs/`) | Cross-repo documented solutions; includes the agent-native documentation surface pattern that informs this site's architecture | Relevant when researching architecture or tooling patterns. Search before building from scratch. |
| `~/obsidian-vault/Projects/brettdavies-agentnative/research/index.md` | Shared research index for both this site and the `agentnative` CLI linter | External signal (blog posts, HN threads, competitor CLIs) extracted into curated quotes + principle mapping. Read before writing principle copy or launch framing that cites third parties. |
| `~/obsidian-vault/Projects/brettdavies-agentnative/principles/index.md` | Canonical spec for P1-P7 (one file per principle, pressure-testable) | Source of truth for principle meaning. Site copy in `content/principles/` is written **manually** from these files — no build-time import, no live link. When principle spec changes, propagate to site copy deliberately. |
| `~/.gstack/projects/brettdavies-agentnative-site/brett-main-build-plan-20260414-130000.md` | Build & distribution plan | Scaffolding decisions for /ce-plan and /ce-work: target repo tree, build pipeline, deployment. Locked decisions; Cloudflare-specifics verified. |
| `~/.gstack/projects/brettdavies-agentnative-site/brett-main-eng-review-20260414-123800.md` | Eng review | Architecture + code quality + test coverage review for M1. §12 lists all DESIGN.md edits. Decisions resolved; no blockers. |

## Related repos

- `brettdavies/agentnative` (`~/dev/agentnative`, tmux `anc`) — the Rust CLI linter. The site's core CTA links to it.
- `brettdavies/brettdavies` (`~/dev/brettdavies`) — GitHub profile. Single-commit policy (amend +
  force-push-with-lease).
- `brettdavies/davies.fyi` — does not exist yet. The site's /about page will eventually link to it.

## Repo conventions

- **Branch:** `main` only. No dev branch.
- **Commits:** Conventional Commits. Short, specific messages.
- **PRs:** Squash merge. PR title becomes commit title.
- **Ruleset:** "Protect main" is active. The `guard-docs / check-forbidden-docs` status check is the gate — see
  `.github/workflows/guard-main-docs.yml` for what it blocks.
- **CI:** Cloudflare Workers handles deployment once `wrangler.toml` is wired. No other CI yet.

## Tool-site sequencing (do not violate)

The site's "Check your CLI" CTA runs `cargo install agentnative`. That command only succeeds once the tool's v0.1
ships to crates.io. Until then:

- Local development and `workers.dev` staging deploys are fine.
- Do **not** attach the production domain or publish HN links until `agentnative` v0.1 is installable from crates.io.

## Domain ownership

The production domain (candidates: agentnative.dev / .io / .org) is **Brett's purchase**. An agent cannot buy it.
Stub `wrangler.toml` with a placeholder domain; document the one-line swap procedure for when Brett purchases the real
one.

## First action for a fresh agent session

1. Read the CEO plan (link above). This is the single source of truth for v0 scope.
2. Read `~/obsidian-vault/Projects/brettdavies-agentnative/principles/index.md` and the seven `p<n>-*.md` files — the
   authoritative spec that the site's `content/principles/` copy is written from (manually, not auto-derived).
3. Run a reference-site survey for visual design (clig.dev, 12factor.net, htmx.org, rust-lang.org book, json-schema.org,
   fly.io docs, matklad.github.io — pick 3-4 that embody "simple, traditional, modern flair" and extract tokens).
   Produce `DESIGN.md` before writing any HTML.
4. Scaffold the markdown sources in `content/` first, then the Worker + HTML renderer, then wire deploy.
5. Check in with Brett before attaching the production domain.
