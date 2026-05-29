---
date: 2026-04-17
topic: anc-100-audit
---

# ANC 100: Agent-Native CLI Audit & Leaderboard

## Problem Frame

The agentnative standard defines 7 principles for CLI tools operated by AI agents, but launches without empirical
evidence. A reader can understand the principles in the abstract but has no way to see what "agent-native" looks like
across real tools — or how their own tools compare. For Show HN, the standard needs a proof layer: automated,
reproducible scoring of ~100 real CLI tools that demonstrates the principles are grounded, the `anc` linter works, and
the gap between current tools and agent-readiness is measurable. The resulting leaderboard also becomes a durable
resource people return to and an invitation for tool authors to improve.

## Requirements

**Tool Registry**

- R1. Maintain a machine-readable registry (YAML or TOML) of ~100 CLI tools, each entry containing: canonical name,
  GitHub repo URL, install method, binary name(s), primary language, category tier, and creator/org attribution.
- R2. Tools are organized into three tiers: **Workhorse** (~60 tools agents invoke to do work — gh, ripgrep, jq, fd,
  docker, kubectl, etc.), **Agent** (~15 AI coding agents — Claude Code, Codex CLI, Aider, Gemini CLI, etc.),
  **Notable** (~25 tools from prominent builders — simonw, doodlestein, tobi, plus Brett's own tools: anc, bird, xr). No
  single creator should dominate the Notable tier — cap any individual's representation at 3-4 tools, chosen by
  community traction (stars/forks). For doodlestein: mcp_agent_mail (1.9k stars), beads_viewer (1.5k), beads_rust (828).
  For simonw: llm (11.6k), datasette (11k), sqlite-utils (2k), files-to-prompt (2.6k).
- R3. The registry is the single source of truth for which tools are audited. Adding a tool means adding a registry
  entry; removal means removing one.

**Pre-Computed Scoring (Known Tools)**

- R4. The 100 registry tools are scored locally on Brett's machine using `anc audit <binary> --output json`. Scorecard
  JSON is committed to `scorecards/` in the site repo. No CI pipeline needed at launch.
- R5. Scoring uses the behavioral + project audit layers (language-agnostic). Source checks run as a bonus for
  Rust/Python tools when source is available, displayed as a separate column — not blended into the primary score.
- R6. Re-scoring happens manually when tools release new versions. Automation (GitHub Actions cron, webhook) is a future
  enhancement, not a launch requirement.

**Live Scoring (Unknown Tools)**

- R7. When a user pastes a GitHub URL not in the registry, a CF Sandbox container scores the tool live. The Sandbox
  clones the repo, attempts binary installation from a trusted package registry, and runs `anc audit`. Results are
  cached in R2 keyed by (repo, version) with a 24-hour TTL.
- R8. Known tools (in the registry) are served from pre-computed cache with a 2-3 second cosmetic spinner. The container
  does not run for known tools.
- R9. The live scorer is the Show HN hook — the "paste a URL, get a score" SSL Labs moment. The pre-computed leaderboard
  is supporting evidence.

**Website Integration**

- R10. A `/scorecards` page renders a ranked leaderboard table from the scorecard JSON data. The table is sortable by
  overall score and filterable by tier (Workhorse / Agent / Notable) and language.
- R11. Each tool has a detail page at `/score/<tool-name>` showing: summary score (N/7 principles), top 3 issues with
  severity and links to relevant principle pages, methodology note, and CTA to install `anc` locally.
- R12. Both pages follow the existing site's content negotiation pattern: HTML by default, raw markdown via `.md` suffix
  or `Accept: text/markdown` header.
- R13. Scorecard data is included in `llms-full.txt` so agents can discover tool scores programmatically.
- R14. Shareable URLs at `/score/<tool-name>` for social sharing of individual tool scores.

**Brett's Own Tools**

- R15. `anc` (agentnative CLI linter), `bird` (X/Twitter CLI), and `xr` (xurl-rs transport layer) are included in the
  Notable tier and scored identically to every other tool — no special treatment or exemptions.

**Narrative & Framing**

- R16. The leaderboard page includes a brief methodology section explaining: what checks are run, what layers apply, how
  scoring works, and how tool authors can re-test locally (`cargo install agentnative && anc audit .`).
- R17. Each tool's scorecard page links to the specific principle page for each check, creating a natural discovery path
  from "my tool failed P2" to "what does P2 require?"
- R18. Framing is constructive: scores are presented as "current state" with actionable improvement paths, not as
  shaming. Each failing check links to its fix guidance.

**Community & Growth**

- R19. A documented process for submitting new tools to the registry (GitHub issue template or PR to the registry file).
  The leaderboard grows via community contribution.
- R20. Tool authors can request a re-score after making improvements. Re-scoring is manual at launch.

**Security & Abuse Prevention**

- R21. The CF Sandbox container runs `anc audit` as the sole entry point. `anc` spawns the target binary as a subprocess
  for behavioral audits (e.g., `<binary> --help`, `<binary> --version`). A malicious binary could ignore `--help` and
  execute arbitrary code for up to the timeout duration. The following layers limit the blast radius:
- R22. **Network lockdown.** Dynamic outbound handlers block all egress after the initial `git clone`. During clone,
  only `github.com` is allowed. During scoring, all network is disabled via `setOutboundHandler("noHttp")`. A malicious
  binary cannot exfiltrate data, contact C2 servers, participate in botnets, or submit proof-of-work for crypto mining.
- R23. **Execution timeout.** Each scoring run has a hard 30-second timeout. `sandbox.exec()` raises an error and the
  session is destroyed. Mining or abuse for 30 seconds on 1/4 vCPU is economically worthless.
- R24. **Resource constraints.** The container runs on the `basic` instance type (1/4 vCPU, 1 GiB memory, 4 GB disk).
  Insufficient for profitable mining, fork bombs are contained by OS-level process limits, and disk fills are capped at
  4 GB on an ephemeral filesystem that resets on sleep.
- R25. **No secrets, no data.** The container holds no credentials, no user data, no API keys. The filesystem contains
  only pre-installed binaries and the cloned repo. There is nothing to steal.
- R26. **Rate limiting.** The live scoring endpoint is rate-limited per IP (e.g., 10 unknown-tool scores per hour). This
  caps the economic damage from abuse at a few cents per attacker per hour.
- R27. **Ephemeral state.** The container resets to its image state on sleep (default 10-minute idle timeout). No
  malicious state persists between scoring runs.
- R28. **(Needs research) Additional hardening.** During planning, research: CF Sandbox isolation guarantees (gVisor or
  equivalent), whether `seccomp` profiles can restrict syscalls, whether the container user can be further restricted
  (non-root, read-only filesystem except `/tmp`), and whether CF provides abuse detection or alerting.

## Success Criteria

- A user can paste a GitHub URL on anc.dev and see a scorecard within 5 seconds (known tools) or 30 seconds
  (unknown tools).
- The leaderboard renders with scorecards for at least 50 tools at Show HN launch (100 is the target, 50 is the floor).
- At least one tool from each tier scores well (standard isn't unreachable) and at least one scores poorly (standard has
  teeth).
- A reader can go from the leaderboard → tool scorecard → principle page → fix guidance in under 3 clicks.
- At least one HN commenter says "I tried my tool and it scored X/7."
- Total infrastructure cost for the first month is under $10.

## Scope Boundaries

- **Not in scope:** Expanding `anc` source audits to Go/Node/other languages. Behavioral + project layer is the
  universal baseline.
- **Not in scope:** Community voting, comments, or social features on the leaderboard.
- **Not in scope:** Comparing tools against each other (e.g., "gh vs glab"). Ranks against the standard, not peers.
- **Not in scope:** Scoring non-CLI tools (libraries, SDKs, web APIs).
- **Not in scope:** Version tracking / score diffs over time. Phase 2 enhancement.
- **Not in scope:** Automated re-scoring pipeline (GitHub Actions cron). Manual re-scoring at launch.
- **Not in scope:** Tools that require compilation from source to install. Only pre-built binary install paths (apt,
  brew, cargo-binstall, pip wheel, npm, go install) are supported.

## Key Decisions

- **Live scoring is the Show HN hook.** The "paste a URL, get a score" interaction is the viral loop. The pre-computed
  leaderboard is supporting evidence, not the headline feature.
- **Cached theater for known tools.** 100 known tools are pre-scored locally by Brett. The web serves cached JSON with a
  2-3 second cosmetic spinner. The container only runs for unknown tools.
- **No toolchains in the container image.** Tools must be installable via pre-built binaries. No `cargo install`
  (compile), no `go build`. This keeps the image under 1.5 GB and fits the `basic` CF instance type.
- **Alpine base image with musl sandbox binary.** Extends `alpine:3.21` with the CF Sandbox musl binary
  (`cloudflare/sandbox:0.7.4-musl`). ~100-200MB image vs ~4GB with Ubuntu + toolchains.
- **Singleton container, scale on demand.** One sandbox ID. Sequential `exec()` calls handle 12-30 requests/minute.
  Scale to 2-3 instances via `getRandom()` if Show HN traffic demands it. Memory+disk billed while awake, CPU billed on
  active usage only.
- **Behavioral + project only for primary score.** Source checks are language-specific and would create unfair
  comparisons. Source checks appear as a bonus column for Rust/Python tools.
- **Brett's tools scored identically.** Dogfooding publicly. Credibility requires it.
- **Security via defense-in-depth.** Network lockdown + timeout + resource limits + no secrets + rate limiting +
  ephemeral state. A malicious binary can waste 30 seconds of 1/4 vCPU and nothing else.

## Dependencies / Assumptions

- `anc` v0.1 must be published to crates.io before launch (existing dependency from tool-site sequencing).
- `anc` must cross-compile to musl target (`x86_64-unknown-linux-musl`) for the Alpine container image.
- `anc audit` must support scoring arbitrary binaries via `--binary <path>` (verify during planning).
- The CF Sandbox SDK musl variant (`cloudflare/sandbox:0.7.4-musl`) works on Alpine 3.21.
- Pre-baked tools survive container sleep because they're part of the Docker image (verified in CF docs).

## Outstanding Questions

### Resolve Before Planning

(None — all product decisions are resolved.)

### Deferred to Planning

- (Affects R4) [Needs research] Can `anc audit` accept `--binary <path>` for scoring a pre-installed binary separate
  from its source repo? If not, what mode does it support?
- (Affects R7) [Needs research] Verify `anc` cross-compiles to `x86_64-unknown-linux-musl` (Alpine target). Check if
  `ast-grep-core` / tree-sitter grammars have musl compatibility issues.
- (Affects R1) [Needs research] Compile the definitive 100-tool list. Start from research already gathered (GitHub API
  searches, influencer tools, ACFS manifest, vault clips) and fill to 100.
- (Affects R28) [Needs research] CF Sandbox isolation guarantees: gVisor or equivalent? Seccomp profiles? Non-root
  container user? Read-only filesystem except `/tmp`? Abuse detection/alerting?
- (Affects R10) [Technical] How does the Worker render the leaderboard from scorecard JSON? Build-time static HTML
  generation vs. Worker-side JSON-to-HTML rendering at request time.

## Related Documents

- `docs/brainstorms/live-scoring-spike.md` — Technical architecture reference: CF Sandbox SDK details, pricing
  calculations, Dockerfile sketches, ACFS manifest analysis, concurrency model.
- `~/.gstack/projects/brettdavies-agentnative-site/brett-dev-design-20260417-145305.md` — Office-hours design doc with
  the chosen approach, architecture diagram, and next steps.

## Next Steps

-> `/ce:plan` for structured implementation planning (suggest 2-3 focused plans, see Related Documents)
