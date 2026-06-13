---
title: 'feat: MCP registry submissions strategy + per-registry templates'
status: active
created: 2026-06-12
plan_type: feat
depth: standard
related_repos:
  - brettdavies/streamsgrp  # source plan structure (docs/plans/2026-06-05-001-feat-mcp-registry-submissions-strategy-plan.md, dev branch)
  - brettdavies/agentnative  # BRAND.md universal voice anchor (vendored mirror on agentnative-site dev branch)
related_plan: docs/plans/2026-06-05-001-feat-mcp-endpoint-plan.md
---

# feat: MCP registry submissions strategy + per-registry templates

## Summary

Land a cross-cutting submissions strategy plus four per-registry fillable templates (Anthropic Connector Directory,
smithery.ai, pulsemcp.com, Official MCP Registry) as durable repo artifacts under `docs/research/`. The shipped MCP
server at `POST /mcp` on `anc.dev` (see `docs/plans/2026-06-05-001-feat-mcp-endpoint-plan.md`, `status: completed`) is
the asset to be submitted; the asset itself is not in scope. Voice authorship in the example fills is anchored to the
three-tier waterfall (`BRAND.md` universal → `PRODUCT.md` channel-delta → `docs/research/VOICE.md` register-split). This
plan does NOT actually submit anything, author the privacy policy, add tool annotations to the MCP server, or build a
vendored CLI mirror — those are explicitly deferred to a follow-up plan.

The plan mirrors the structure of `streamsgrp:docs/plans/2026-06-05-001-feat-mcp-registry-submissions-strategy-plan.md`
(the source) but is authored independently rather than depending on the source's strategy doc landing first.

---

## Problem Frame

`anc.dev` exposes a public, no-auth MCP server at `POST /mcp` carrying nine tools across four surfaces (CLI registry,
ten agent-native principles, vendored spec, scorecard) and five resources. The MCP wire contract, discoverability set
(`/.well-known/mcp`, `/.well-known/ai.txt`, `llms.txt` Programmatic Access, `/mcp-docs/`), and operator runbook are all
shipped. The next compounding-leverage step is getting the server discovered by MCP-consuming agents — which means
listing it in the MCP registries where those agents (and the humans configuring them) look.

The submissions surface has known structure but no consolidated artifact:

1. **Four registries cover the relevant audience.** Three commercial directories (Anthropic Connector Directory,
   smithery.ai, pulsemcp.com) plus the Official MCP Registry at `registry.modelcontextprotocol.io`. Each has a different
   submission process, review cadence, and audience profile; each needs a separately-authored submission. PulseMCP and
   the broader aggregator ecosystem ingest from the Official MCP Registry within a week of publish, making the canonical
   registry the lowest-cost-highest-leverage submission.
2. **The submission body is recurring, not one-shot.** Each registry will likely accept follow-up edits (capability
   changes, new tools, updated tagline, version bumps). A fillable template that authors can re-open and re-fill matters
   more than a single point-in-time submission write-up.
3. **Voice consistency across registries is load-bearing.** The agent-native CLI standard's voice (opinionated, precise,
   inviting; third-person; no marketing copy; numbers-not-adjectives) is what differentiates the listing from the
   seventy-other-MCP-server-of-the-week pattern. Generic factual phrasing buries the editorial signal. The voice anchor
   must be cited where the author hits the blank `{tagline}` field, not separately.
4. **Several pre-submission workstreams have to land first.** Privacy policy + legal review for the Anthropic Connector
   form; tool annotations server-side pass; CLI version research per registry; role-based support inbox provisioning;
   branding assets. These are honestly disclosed up front rather than ambushing the future author after the strategy doc
   is open.

The strategy artifact captures all four. The four template files surface the submission bodies as standalone copy-fill
documents.

---

## Requirements

### Strategy artifact landing

| ID  | Requirement                                                                                                                                                                                                                                                                                                                                         | Source                |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| R1  | A strategy doc exists at `docs/research/mcp-registry-submissions-strategy.md` carrying frontmatter (`date`, `topic`, `upstream`, `purpose`, `status: draft`) that matches the shape of existing `docs/research/*.md` entries                                                                                                                        | KTD-1                 |
| R2  | The strategy doc carries `## Summary`, `## Problem Frame`, `## Pre-submission workstreams`, `## Key Decisions` (KD-1..KD-5), `## Cross-cutting principles`, `## Per-registry deep dives` (4 subsections), `## Order of operations`, `## Sources` (internal + external)                                                                              | KTD-1; source-plan R2 |
| R3  | The Problem Frame includes a one-paragraph forcing-function description that names the signal *shape* without re-leaking confidential specifics (anc.dev's: agent-evaluation traffic patterns, no NDA pressure, but the visible signal is "MCP-consuming agents need a discoverable listing or anc.dev shows up only when explicitly cited by URL") | KTD-6                 |
| R4  | A `### CLI pinning policy` subsection of `## Cross-cutting principles` documents the default (pin at fill time per submission, not carried across reuses) and names the vendored-CLI-mirror option as a documented future workstream                                                                                                                | KTD-5                 |
| R5  | A `## Pre-submission workstreams` section names each prerequisite (privacy policy + legal review, tool annotations server-side pass, CLI version research per registry, role-based support inbox provisioning, branding assets) with its owner and gate type (binary mandatory vs. nice-to-have)                                                    | KTD-6                 |

### Per-registry templates

| ID  | Requirement                                                                                                                                                                                                                                                                                                                                                            | Source         |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| R6  | Four template files exist at `docs/research/mcp-registry-templates/{anthropic-connector,smithery,pulsemcp,official-mcp-registry}.md`, each with YAML frontmatter (`target_registry`, `template_version: v1`, `status: template`, `source_strategy:` link, `last_verified` date)                                                                                        | KTD-2          |
| R7  | Each template uses placeholder conventions: `{placeholder}` for required, `{placeholder?}` for optional, `{choice_a \| choice_b}` for enumerated, `// COMMENT` for instructional guidance to the human author (with `# COMMENT` inside YAML blocks). All `{placeholder}` instances are greppable via `grep -rE '\{[a-z_]+\??\}' docs/research/mcp-registry-templates/` | KTD-2          |
| R8  | Each template carries one `## Example fill (voice anchor)` section demonstrating anc.dev voice via a sample tagline, sample description, and two sample tool descriptions. Voice anchor phrases are quoted verbatim with line refs from `BRAND.md` (via `agentnative-spec` or the vendored mirror), `PRODUCT.md`, and `docs/research/VOICE.md`                         | KTD-4          |
| R9  | Each template includes a `## Reviewer back-and-forth — what to refuse` section, naming the registry-specific contact and the canonical refuse-list (OAuth on public catalog, write tools on read-only, marketing copy, category misclassification)                                                                                                                     | Source-plan R8 |
| R10 | The Official MCP Registry template (Template 4) covers the `server.json` schema and the `mcp-publisher` CLI publish workflow as standalone content — not as a sub-path of the pulsemcp template                                                                                                                                                                        | KTD-3          |

### Cross-references and handoff

| ID  | Requirement                                                                                                                                                                                                                                                                                 | Source                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| R11 | `AGENTS.md` gains a `### Registry listings` subsection under `## MCP server` (line 73) pointing at the strategy doc, the four template files, the canonical registry URLs, and the per-registry contact addresses                                                                           | KTD-7                      |
| R12 | The strategy doc carries a cross-reference to `streamsgrp:docs/plans/2026-06-05-001-feat-mcp-registry-submissions-strategy-plan.md` annotated as cross-repo prior art (anc.dev's plan was authored independently rather than depending on streamsgrp's, but the structural shape is shared) | KTD-1                      |
| R13 | The MCP endpoint plan `docs/plans/2026-06-05-001-feat-mcp-endpoint-plan.md` is cross-referenced from the strategy doc's `## Sources` and from each template's voice-anchor section as the canonical reference for tool inventory, surface taxonomy, and wire-contract details               | Discoverability discipline |

### Format and rigor

| ID  | Requirement                                                                                                                                                          | Source                     |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| R14 | All new markdown files pass `markdownlint-cli2` per the repo's `.markdownlint-cli2.yaml`. Templates use 4-backtick outer fences when their bodies contain inner code | Repo lint config           |
| R15 | All repo-relative paths cited in the strategy doc and templates resolve (`test -f` for each); all external URLs cited resolve at submit time (HEAD-200 or HEAD-3xx)  | Discoverability discipline |
| R16 | All existing tests stay green (`bun test`, `bunx vitest --project worker run`, `bunx playwright test`). No code-path tests are added — this is a docs-only change    | Regression discipline      |

---

## Key Technical Decisions

### KTD-1: Strategy artifact lives at `docs/research/mcp-registry-submissions-strategy.md`, a peer entry in the existing research surface

`docs/research/` is the established home for long-lived, research-grounded, non-time-bound reference docs (per existing
entries `2026-04-28-cloudflare-live-scoring-v2.md`, `2026-05-04-discovery-chain-hit-rate.md`, `VOICE.md`, `design/`).
`docs/brainstorms/` is for planning captures, not durable references. `docs/plans/` is for plans. `content/` is the
public prose-emit source — `src/build/01-prose-pages.mjs` auto-walks `content/**/*.md` and emits to `dist/`, so any
registry-submissions strategy dropped there would silently publish to production. The strategy is internal
author-facing, not external agent-facing; `docs/research/` is the right home.

Frontmatter shape follows the local `docs/research/` convention (`date`, `topic`, `upstream`, `purpose`, `status`)
rather than the source plan's heavier YAML — local conventions win over cross-repo mirroring at the frontmatter level.
The body structure (the 8 H2 sections) follows the source plan because the body is what surfaces the cross-cutting
principles each future author needs.

**Alternative considered (rejected):** Live under `content/` as a public artifact. Rejected because the strategy
includes pre-submission workstream gates, CLI pinning operations rationale, and reviewer-refuse heuristics that are
author-facing decisions rather than agent-facing capability docs. Public-emit also forces the prose register away from
"the firm's internal submission playbook" toward "the firm's public posture on MCP registries," which is a different and
unnecessary artifact.

### KTD-2: Per-registry templates ship as sibling files at `docs/research/mcp-registry-templates/{registry}.md`, not inline appendices

Sibling files match the copy-fill-submit workflow: the future author wants to open one file, scan its placeholders, and
fill them — not page through a long strategy doc to locate the relevant template. The sibling-file shape is also
consistent with the team's filename-per-instance idiom used elsewhere in the repo (one file per registered consumer,
independently revisable). The strategy doc cross-references each template by repo-relative path.

**Alternative considered (rejected):** Single strategy file with templates inlined as appendix sections. Keeps the
artifact as one document but defeats the "diff one template at a time" workflow and inflates the strategy doc to where
human reviewers stop reading. The strategy reads better when it is principles-and-deep-dives prose; the templates read
better as standalone copy-fill bodies.

### KTD-3: Official MCP Registry is a 4th first-class template (peer of the three commercial directories)

The Official MCP Registry at `registry.modelcontextprotocol.io` auto-feeds PulseMCP and the broader aggregator ecosystem
within a week. Burying its `server.json` schema and `mcp-publisher` publish workflow inside Template 3 (pulsemcp) as a
sub-path would lose the editorial signal that this is the lowest-cost-highest-leverage submission of the four. Promoting
it to Template 4 means:

- The canonical registry submission is a peer of the three commercial directories, not a sub-step of one of them
- Future authors who want the compounding-leverage path can submit only to Template 4 and let aggregator ingest cover
  the rest (a defensible posture worth naming as an explicit recommendation in the strategy's order-of-operations)
- The pulsemcp template carries its own direct-submit path plus an "alternatively, see Template 4" pointer

Cost: one template file, one section in per-registry deep dives. Benefit: the editorial signal lands at file-discovery
time, not buried in prose.

**Alternative considered (rejected):** Leave the Official MCP Registry as a sub-path inside Template 3. Smaller scope
but loses the editorial signal. Future authors would have to read the deep-dive prose carefully to notice.

### KTD-4: Voice authorship is demonstrated per template via three-tier voice-waterfall cites

anc.dev's voice waterfall has three tiers (per `PRODUCT.md` ## Inheritance):

1. **`BRAND.md` universal** — shared identity, voice anchor, audiences, universal anti-patterns. Authoritative copy in
   `agentnative-spec`; vendored mirror on the `agentnative-site` `dev` branch.
2. **`PRODUCT.md` channel-delta** — what the site channel adds, narrows, or overrides on top of `BRAND.md`. Audience
   narrowing, channel-specific bans, the tech-stack and scope decisions.
3. **`docs/research/VOICE.md` register-split** — the voice register split (1a homepage lede vs 1b principle page, 2 task
   pages, 3 markdown twins).

Each template's `## Example fill (voice anchor)` section cites specific line ranges from all three. Sample content
(tagline, description, two tool descriptions) anchors to verbatim phrases:

- From `BRAND.md` (in `agentnative-spec`): universal voice anchor phrases — register, anti-patterns
- From `PRODUCT.md`: channel-specific bans, the markdown-source-of-truth principle
- From `docs/research/VOICE.md`: opinionated/precise/inviting trio, the third-person rule, sentence-rhythm guidance

Examples are anc.dev-flavored for concreteness (the 9 tools / 5 resources surface of the existing MCP server) but
explicitly framed as illustrative — future authors override the example fills with their own values for that submission
cycle, not invent the voice from scratch.

**Alternative considered (rejected):** Single-anchor citation (PRODUCT.md only, mirroring the source plan's pattern).
Lighter authoring but loses the universal/channel-delta separation that anc.dev's voice waterfall depends on. A reader
of a single-file anchor would miss the BRAND.md universal layer and write copy that survives at the channel level but
violates the standard's posture.

### KTD-5: CLI pinning policy defaults to "pin at fill time per submission", with vendored mirror as a documented future workstream

Two registry submission flows use third-party CLIs as part of their publish path: smithery.ai uses `@smithery/cli`; the
Official MCP Registry uses `mcp-publisher`. Two defensible options for how the firm consumes those CLIs:

1. **Pin at fill time per submission.** Each fill-and-submit cycle resolves the current `@smithery/cli` and
   `mcp-publisher` versions, pins them with a release-notes verification step, and revokes the OAuth credential after
   the one-time publish. Recurring research tax per submission, no infrastructure cost. **This is the default.**
2. **Vendored CLI mirror with audited releases.** One-time setup of an internal mirror with cargo-deny-style audit
   policy; ongoing maintenance to track upstream releases. Lower per-submission research, higher infrastructure cost.

The plan ships option 1 as the strategy default and documents option 2 as a named future workstream. The
pinning-at-fill-time placeholders in the templates carry the operational discipline.

### KTD-6: Problem Frame extracts pre-submission workstreams into a named section, preserving the cadence claim

The bare framing of "fill the template once the production URL is live" doesn't survive contact with the pre-submission
surface: privacy policy authoring + legal review (Anthropic Connector form requires it for the OAuth flow), tool
annotations server-side pass, CLI version research per registry, role-based support inbox provisioning
(`support@anc.dev` or similar), branding assets (icon + screenshots in registry-specific dimensions).

This plan chooses the cleanest-separation option: a dedicated `## Pre-submission workstreams` section between the
Problem Frame and the Cross-cutting principles, naming each prereq with its owner and gate type (binary mandatory vs.
nice-to-have). The Problem Frame's cadence claim ("once the prereqs are met, submission is a fill-the-template step")
holds, and the prereq surface is honestly disclosed up front rather than ambushing the future author.

**Alternative considered (rejected):** Acknowledge prereqs inline in the Problem Frame. Loses the cadence-claim's
editorial value; the cleaner separation lets both stand.

### KTD-7: AGENTS.md gets a new `### Registry listings` subsection under `## MCP server` (line 73)

`AGENTS.md ## MCP server` is the canonical home for MCP-related disclosure on `anc.dev`. Registry listings are
author-facing planning content rather than wire-contract surface, but they belong adjacent to the wire-contract
disclosure because both are MCP-server-scoped. A sibling subsection (`### Registry listings`) at the H3 level points at
the strategy doc and the four template files, names the canonical registry URLs (Anthropic Connector Directory,
smithery.ai, pulsemcp.com, Official MCP Registry), and notes the per-registry contact addresses.

The placement matches the existing AGENTS.md pattern of using `## MCP server` as the umbrella for everything
MCP-adjacent (wire contract, client skill, runbook reference, discoverability siblings).

---

## Output Structure

```text
docs/
├── plans/
│   └── 2026-06-12-002-feat-mcp-registry-submissions-strategy-plan.md  (this file)
└── research/
    ├── 2026-04-28-cloudflare-live-scoring-v2.md                       (existing; peer)
    ├── 2026-05-04-discovery-chain-hit-rate.md                         (existing; peer)
    ├── VOICE.md                                                       (existing; peer)
    ├── mcp-registry-submissions-strategy.md                           (NEW — U1, U2, U3)
    └── mcp-registry-templates/                                        (NEW — U4)
        ├── anthropic-connector.md                                     (NEW — U4, U5)
        ├── smithery.md                                                (NEW — U4, U5)
        ├── pulsemcp.md                                                (NEW — U4, U5)
        └── official-mcp-registry.md                                   (NEW — U4, U5)

AGENTS.md                                                              (MODIFIED — U6)
```

The four template filenames intentionally do not include a date suffix or version (frontmatter `template_version`
carries that). Filenames are slug-stable so cross-references in the strategy doc and `AGENTS.md` stay valid across
template revisions.

---

## Implementation Units

### U1. Bootstrap the strategy doc skeleton at `docs/research/mcp-registry-submissions-strategy.md`

**Goal:** Create the strategy doc with frontmatter matching the local `docs/research/` convention, an outlined section
structure (placeholders for content), and the carried-forward Key Decisions section.

**Requirements:** R1, R2 (skeleton subset)

**Dependencies:** none

**Files:**

- `docs/research/mcp-registry-submissions-strategy.md` (NEW)

**Approach:**

- Frontmatter shape: `date: 2026-06-12`, `topic: mcp-registry-submissions-strategy`, `upstream:
  docs/plans/2026-06-12-002-feat-mcp-registry-submissions-strategy-plan.md`, `purpose: Cross-cutting submissions
  strategy + four per-registry fillable templates for anc.dev's MCP server`, `status: draft`
- Skeleton H2 sections in order: `## Summary`, `## Problem Frame`, `## Pre-submission workstreams`, `## Key Decisions`,
  `## Cross-cutting principles`, `## Per-registry deep dives`, `## Order of operations`, `## Sources`
- KD-1 carried as: "Each registry section in this artifact is researched against that registry's specific submission
  docs, review process, and audience. Future authors fill four different templates, not one shared one, because the
  registry-specific submission body shapes differ enough that a single template would either over-constrain or
  under-specify each."
- KD-2..KD-5 placeholders that U3 fills

**Patterns to follow:** `docs/research/2026-04-28-cloudflare-live-scoring-v2.md` for frontmatter shape and prose
register. The voice anchor for the strategy doc itself is `docs/research/VOICE.md` (opinionated, precise, inviting;
third-person where the artifact has an actor).

**Test scenarios:**

- File exists at the expected path and contains all 8 skeleton H2 sections
- Frontmatter matches the local `docs/research/` shape (`date`, `topic`, `upstream`, `purpose`, `status`)
- KD-1 explicitly names "four templates" and the canonical-aggregator rationale
- `markdownlint-cli2 docs/research/mcp-registry-submissions-strategy.md` exits 0

**Verification:** The strategy doc file is readable, the skeleton structure is in place, and a reviewer can scan the
section order to confirm the planned shape before content lands.

---

### U2. Author Problem Frame, Pre-submission workstreams, and the forcing-function paragraph

**Goal:** Land the strategy doc's Problem Frame + Pre-submission workstreams sections with anc.dev-specific framing.

**Requirements:** R3, R5

**Dependencies:** U1

**Files:**

- `docs/research/mcp-registry-submissions-strategy.md` (MODIFIED)

**Approach:**

- Problem Frame (~4 paragraphs): cites `anc.dev`'s shipped MCP surface (9 tools / 5 resources / wire contract per
  `docs/plans/2026-06-05-001-feat-mcp-endpoint-plan.md`); names the four registries; describes the
  recurring-not-one-shot nature; names the voice-consistency stake.
- Forcing-function paragraph (R3): one paragraph naming the signal *shape* (agent-evaluation traffic patterns; the
  visible signal is "MCP-consuming agents need a discoverable listing or anc.dev shows up only when explicitly cited by
  URL"). No confidential specifics.
- Pre-submission workstreams (R5): five named workstreams (privacy policy + legal review, tool annotations server-side
  pass, CLI version research per registry, role-based support inbox provisioning, branding assets), each with owner
  placeholder (`{owner}`) and gate type (`binary mandatory` vs `nice-to-have`)

**Patterns to follow:** Existing problem-framing prose in `docs/plans/2026-06-05-001-feat-mcp-endpoint-plan.md` for the
"anc.dev is a registry of CLIs; the MCP server exposes that registry over JSON-RPC" surface description style.

**Test scenarios:**

- Problem Frame names all four registries
- Forcing-function paragraph names a signal shape, not specifics
- Pre-submission workstreams lists exactly five entries, each with `owner` and `gate_type`
- No specific company names or internal-only details surface in the prose

**Verification:** A reader new to the artifact understands what's being submitted, where, why now, and what has to land
before the first template gets filled.

---

### U3. Author cross-cutting principles + per-registry deep dives + order-of-operations + sources

**Goal:** Fill the remaining strategy-doc sections with the principles and per-registry research that makes the
templates fillable.

**Requirements:** R2 (content fill), R4 (CLI pinning policy), R10 (Official MCP Registry as Template 4)

**Dependencies:** U2

**Files:**

- `docs/research/mcp-registry-submissions-strategy.md` (MODIFIED)

**Approach:**

- `## Key Decisions` (KD-2..KD-5 carry-forward; KD-1 already in U1): KD-2 four templates not three; KD-3 placeholders
  are greppable; KD-4 every submission body is markdown-shaped and reviewable; KD-5 voice is anchored to BRAND.md +
  PRODUCT.md + VOICE.md.
- `## Cross-cutting principles`: tool description voice (numbers-not-adjectives, RFC 2119 where applicable,
  third-person), OAuth posture (no OAuth on public catalog), what to refuse (write tools on read-only, marketing copy,
  category misclassification), `### CLI pinning policy` subsection (KTD-5 default + future-workstream pointer).
- `## Per-registry deep dives` (4 subsections, ~150-300 lines each): Anthropic Connector Directory (submission form,
  OAuth requirement, privacy-policy gate, review SLA), smithery.ai (CLI publish, repo-link discovery, voice match),
  pulsemcp.com (direct submit OR aggregator-ingest from Official MCP Registry), Official MCP Registry (`server.json`
  schema, `mcp-publisher` CLI, GitHub OIDC auth, namespace claim).
- `## Order of operations`: recommended sequence — Official MCP Registry first (auto-feeds aggregators within ~1 week),
  then Anthropic Connector + smithery in parallel, pulsemcp last (or skip if aggregator ingest covers it).
- `## Sources`: internal cross-refs (`docs/plans/2026-06-05-001-feat-mcp-endpoint-plan.md`, `AGENTS.md ## MCP server`,
  `PRODUCT.md`, `docs/research/VOICE.md`, BRAND.md citation by `agentnative-spec` repo URL or vendored-mirror path);
  external URLs for each registry's submission docs.

**Patterns to follow:** The streamsgrp source plan's KD authoring shape
(`streamsgrp:docs/plans/2026-06-05-001-feat-mcp-registry-submissions-strategy-plan.md ## Key Technical Decisions`) for
the level of detail and the rationale/alternative-considered pairing. anc.dev voice register from
`docs/research/VOICE.md`.

**Test scenarios:**

- KD-1..KD-5 all present in `## Key Decisions`
- `### CLI pinning policy` subsection exists inside `## Cross-cutting principles`
- `## Per-registry deep dives` has exactly 4 subsections (one per registry)
- Official MCP Registry deep dive describes `server.json` schema AND `mcp-publisher` CLI as standalone content (R10)
- `## Order of operations` recommends Official MCP Registry first
- `## Sources` contains internal repo-relative paths AND external URLs

**Verification:** A future author can read `## Cross-cutting principles` + the relevant per-registry deep dive and have
enough context to start filling the matching template without further research.

---

### U4. Place the four per-registry template files

**Goal:** Create four sibling template files with frontmatter, the placeholder-convention header, and the section
skeleton each registry's submission body requires.

**Requirements:** R6, R7, R9, R10

**Dependencies:** U3 (so per-registry deep dives are written and templates can cross-link)

**Files:**

- `docs/research/mcp-registry-templates/anthropic-connector.md` (NEW)
- `docs/research/mcp-registry-templates/smithery.md` (NEW)
- `docs/research/mcp-registry-templates/pulsemcp.md` (NEW)
- `docs/research/mcp-registry-templates/official-mcp-registry.md` (NEW)

**Approach:**

- Frontmatter for each (R6): `target_registry: <name>`, `template_version: v1`, `status: template`, `source_strategy:
  ../mcp-registry-submissions-strategy.md`, `last_verified: 2026-06-12`
- Each template carries a `# {registry name} — submission template` heading and the placeholder-convention block (R7) at
  the top so the future author has the legend before scanning the body.
- Each template body has these sections in this order:

1. `## Submission body` — the registry-specific form/manifest/YAML, populated with `{placeholders}`
2. `## Reviewer back-and-forth — what to refuse` (R9) — registry-specific contact + canonical refuse-list
3. `## Example fill (voice anchor)` — placeholder, populated by U5

- Per-registry submission body shapes (substantive, registry-specific):
- **Anthropic Connector Directory**: form-style fields (display name, tagline, description, capability list, OAuth
    metadata, privacy-policy URL, support email, icon)
- **smithery.ai**: `smithery.yaml` config + display fields + tool descriptions + repo URL
- **pulsemcp.com**: form fields OR pointer to Official MCP Registry submission (depending on which route the author
    chooses)
- **Official MCP Registry**: `server.json` schema-shaped placeholders (per `registry.modelcontextprotocol.io/docs`) +
    the `mcp-publisher` CLI publish step (R10)
- All `{placeholder}` instances must match the greppable regex `\{[a-z_]+\??\}` (R7).

**Patterns to follow:** Each registry's official submission docs (the strategy doc's `## Per-registry deep dives`
carries the authoritative cross-references). Filename slug stability — no date suffix.

**Test scenarios:**

- Four files exist at the expected paths
- Each carries the expected frontmatter (`target_registry`, `template_version`, `status`, `source_strategy`,
  `last_verified`)
- Each carries the three required sections (`## Submission body`, `## Reviewer back-and-forth — what to refuse`, `##
  Example fill (voice anchor)`)
- `grep -rE '\{[a-z_]+\??\}' docs/research/mcp-registry-templates/` returns a non-empty result for each file (every
  template has placeholders)
- Official MCP Registry template includes both `server.json` schema content AND `mcp-publisher` CLI publish workflow
  (R10)
- `markdownlint-cli2 docs/research/mcp-registry-templates/*.md` exits 0
- All `source_strategy:` frontmatter paths resolve to `docs/research/mcp-registry-submissions-strategy.md`

**Verification:** A future author can copy any of the four templates, scan the `{placeholders}`, and start filling them
with their specific submission's values. The reviewer-refuse list is on the page so they don't have to re-derive it
under review-cycle pressure.

---

### U5. Author voice-demonstrated example fills per template (`## Example fill (voice anchor)`)

**Goal:** Populate each template's `## Example fill (voice anchor)` section with a sample tagline, sample description,
and two sample tool descriptions drawn from anc.dev's actual MCP surface, anchored to verbatim phrases from `BRAND.md` +
`PRODUCT.md` + `docs/research/VOICE.md`.

**Requirements:** R8

**Dependencies:** U4 (templates exist), U3 (cross-cutting principles fixed)

**Files:**

- `docs/research/mcp-registry-templates/anthropic-connector.md` (MODIFIED)
- `docs/research/mcp-registry-templates/smithery.md` (MODIFIED)
- `docs/research/mcp-registry-templates/pulsemcp.md` (MODIFIED)
- `docs/research/mcp-registry-templates/official-mcp-registry.md` (MODIFIED)

**Approach:**

- Each template's `## Example fill (voice anchor)` carries:
- **Sample tagline** (~15 words) — third-person, opinionated, RFC 2119 where applicable, no marketing copy. Cited from
    `docs/research/VOICE.md` (opinionated/precise/inviting trio + third-person rule).
- **Sample description** (~60 words) — names the tool surface in concrete terms (9 tools / 5 resources / four surfaces —
    registry, principles, vendored spec, scorecard), cites `docs/plans/2026-06-05-001-feat-mcp-endpoint-plan.md` for
    tool inventory. Anchored to `PRODUCT.md` channel-delta phrases (audience narrowing, the markdown-source-of-truth
    principle) and to `BRAND.md` universal voice phrases.
- **Two sample tool descriptions** — `list_tools` and `get_scorecard`, written in anc.dev's voice (numbers, exit codes,
    concrete artifacts; no hedging; one-sentence-paragraphs where the sentence deserves the frame). Cited from
    `docs/research/VOICE.md` sentence-rhythm guidance.
- Voice-anchor phrases are quoted verbatim with line refs:
- From `BRAND.md` (via the `agentnative-spec` vendored mirror or repo URL): universal voice anchor phrases + the
    audience framing + the universal anti-patterns
- From `PRODUCT.md`: channel-specific bans, the markdown-source-of-truth principle, the three-tier inheritance frame
- From `docs/research/VOICE.md`: opinionated/precise/inviting trio, third-person rule, sentence-rhythm guidance
- Sample fills are framed explicitly as illustrative — future authors override the example fills with the actual values
  for their submission cycle. The voice anchor stays.

**Patterns to follow:** `docs/research/VOICE.md` for register; `PRODUCT.md` for channel-delta voice posture; `BRAND.md`
(in `agentnative-spec`) for the universal voice phrases.

**Test scenarios:**

- Each template's `## Example fill (voice anchor)` section is non-empty after this unit lands
- Each section cites at least one line range from each of `BRAND.md`, `PRODUCT.md`, and `docs/research/VOICE.md`
- The two sample tool descriptions use concrete artifacts (exit codes, tool names, surface names) — `grep -E
  '\b(exit|code|tool|surface|registry|principle|spec|scorecard)\b'` returns multiple hits
- Sample tagline is third-person (no "we", "our", "I" — `grep -wE '(we|our|us|I|my)'` returns zero hits)
- The example-fill prose passes `markdownlint-cli2`

**Verification:** A future author opening any template and scanning the example fill can see the voice posture in action
— a sample they can pattern-match against rather than infer from the three voice docs cold.

---

### U6. AGENTS.md `### Registry listings` subsection + strategy-doc cross-references + brainstorm handoff

**Goal:** Disclose the new author-facing surface in `AGENTS.md` so the team's runbook stays canonical, and add the
cross-references the strategy doc + templates need.

**Requirements:** R11, R12, R13

**Dependencies:** U5 (artifacts exist to point at)

**Files:**

- `AGENTS.md` (MODIFIED)
- `docs/research/mcp-registry-submissions-strategy.md` (MODIFIED — cross-refs + status flip)
- `docs/research/mcp-registry-templates/*.md` (MODIFIED — `last_verified` bump if content drifted)

**Approach:**

- `AGENTS.md` `## MCP server` (line 73) gets a new `### Registry listings` subsection. Contents:
- One paragraph naming the strategy doc and the four templates by path
- Bulleted list of the four registries with canonical URLs and per-registry contact addresses
- One sentence on the order-of-operations recommendation (Official MCP Registry first)
- Cross-reference to `docs/plans/2026-06-12-002-feat-mcp-registry-submissions-strategy-plan.md` (this file) for the
    planning rationale
- Strategy doc cross-references (R12, R13):
- Add inline cross-reference to `streamsgrp:docs/plans/2026-06-05-001-feat-mcp-registry-submissions-strategy-plan.md`
    annotated as cross-repo prior art (cite by `~/dev/solutions-docs/`-style relative ref or by explicit repo URL —
    agentnative-site convention)
- Cross-reference `docs/plans/2026-06-05-001-feat-mcp-endpoint-plan.md` in `## Sources` and in each template's
    example-fill anchor section
- Strategy doc `status:` flips from `draft` → `published` (decoupled from this plan's own `status: active → completed`
  lifecycle).

**Patterns to follow:** Existing AGENTS.md disclosure pattern under `## MCP server` (lines 73-140 carry the
wire-contract subsection structure to mirror).

**Test scenarios:**

- `AGENTS.md` `### Registry listings` subsection exists under `## MCP server`
- Subsection names all four registries and points at the strategy doc + four templates
- Strategy doc carries the cross-reference to the streamsgrp source plan
- All `.md` files pass `markdownlint-cli2`
- All repo-relative paths in the strategy doc and templates resolve (`test -f` for each) — R15

**Verification:** A fresh agent reading `AGENTS.md` discovers the registry-submissions surface in the same `## MCP
server` section as the wire contract, the client skill, and the operator runbook. The strategy doc and templates are
cross-referenced as a connected artifact set.

---

### U7. Test green + lint pass + path-resolution audit

**Goal:** Confirm the docs-only change introduces no regressions and that every cited path resolves.

**Requirements:** R14, R15, R16

**Dependencies:** U6

**Files:**

- (none modified; verification-only)

**Approach:**

- Run the three test suites: `bun test`, `bunx vitest --project worker run`, `bunx playwright test`. All must stay green
  (no new tests, no removed tests).
- Run `markdownlint-cli2` against the new artifacts (R14) — strategy doc + four templates + AGENTS.md.
- Audit repo-relative paths: extract every repo-relative path cited in the strategy doc and templates, run `test -f` (or
  `test -d` for directories) for each, surface any that don't resolve.
- Audit external URLs cited in the strategy doc and templates (registry submission docs, registry homepages): `curl -sI`
  each, expect HEAD-200 or HEAD-3xx. Any that fail are flagged for re-research before merge.

**Test scenarios:** None (verification-only unit).

**Verification:** All three test suites pass. `markdownlint-cli2` exits 0 across the new artifacts. The path-resolution
audit produces no failures. External URL audit produces no failures, or any failures are flagged to a follow-up issue
and the strategy doc notes the as-of date.

---

## Scope Boundaries

### Deferred to Follow-Up Work

- **Actual submission to any registry.** This plan stops at producing the strategy + templates. A downstream plan
  (`docs/plans/<date>-NNN-feat-mcp-registry-submission-<registry>-plan.md`) fills one template, runs the pre-submission
  workstreams, and submits to a specific registry. Treat the four templates as inputs to that plan, not deliverables of
  this one.
- **Privacy policy authoring + legal review.** Anthropic Connector form requires it for the OAuth flow. Owner and gate
  type surface in the strategy's `## Pre-submission workstreams` section but the policy itself is a separate workstream.
- **Server-side tool annotation pass.** The MCP server's tool descriptions currently use the in-code shape from
  `docs/plans/2026-06-05-001-feat-mcp-endpoint-plan.md`. A registry-submission-ready pass would audit each tool
  description against the voice posture and update in place. Not in scope here.
- **Vendored CLI mirror.** KTD-5 names this as a future workstream — adopted when submission cadence makes the
  per-submission pin tax non-trivial.
- **Strategy-doc reconciliation with the streamsgrp source plan once it lands.** This plan authors independently rather
  than depending on streamsgrp. If streamsgrp's strategy doc eventually lands at
  `streamsgrp:docs/research/mcp-registry-submissions-strategy.md`, a follow-up reconciliation could deduplicate
  cross-cutting principles or formally cross-link. Out of scope for U1-U7.

### Outside this product's identity

- **Public registry-comparison artifact.** A public-facing comparison of MCP registries is a different product entirely
  (audience: MCP-server authors at large, not anc.dev). Not in scope.
- **Tool-author advocacy / submission-as-a-service for third-party CLIs.** anc.dev is a registry of scored CLIs; whether
  anc.dev offers submission concierge for the CLIs it lists is a separate product decision. Not in scope.

---

## Risks & Dependencies

### Risks

- **Voice fragmentation across the three anchor files.** `BRAND.md` (universal) + `PRODUCT.md` (channel-delta) +
  `docs/research/VOICE.md` (register-split) cover overlapping ground. Citing line ranges from all three in each example
  fill carries the risk that a future author finds two cites that drift (e.g., `BRAND.md` says one thing and `VOICE.md`
  narrows or contradicts). Mitigation: each example fill explicitly names which tier the cited phrase comes from
  (universal vs channel vs register-split) so a reader knows which layer to trust on conflict. The three-tier waterfall
  in `PRODUCT.md ## Inheritance` is authoritative on the resolution order.
- **CLI version drift between strategy authoring and first submission.** `@smithery/cli` and `mcp-publisher` will move
  between this plan's `last_verified: 2026-06-12` date and the first submission. KTD-5's pin-at-fill-time discipline
  mitigates this — the templates carry `{cli_version}` placeholders rather than hardcoded versions, so the fill cycle
  does the research.
- **Cross-repo `BRAND.md` citation drift.** `BRAND.md` lives in `agentnative-spec`. Citing it by repo URL means the cite
  breaks when the upstream file moves; citing the vendored mirror in `agentnative-site/BRAND.md` means the cite breaks
  when the vendor goes stale. Mitigation: cite both — the vendored mirror by repo-relative path, the upstream by
  absolute repo URL with a commit-SHA pin. Templates note the as-of date explicitly.
- **Official MCP Registry submission process volatility.** The registry is new (v1 launch 2025), and the `server.json`
  schema + `mcp-publisher` CLI surface may move. KTD-3 elevates this to a first-class template precisely because the
  registry is the lowest-cost-highest-leverage path, but the cost of authoring against a moving target is real.
  Mitigation: the template carries `last_verified: 2026-06-12` and the strategy doc's `## Sources` cites the official
  docs URL with the date.
- **Reviewer rejections during actual submission.** Each registry has different acceptance criteria. The `## Reviewer
  back-and-forth — what to refuse` section pre-loads the canonical refuse-list, but novel rejection patterns will
  surface only at submission time. Mitigation: the per-registry deep dives note known rejection patterns from public
  registry rejection logs (where they exist).

### Dependencies

- `docs/plans/2026-06-05-001-feat-mcp-endpoint-plan.md` (`status: completed`) — the MCP server itself, its tool surface,
  and its discoverability set are the asset to be submitted.
- `PRODUCT.md`, `docs/research/VOICE.md`, and the `BRAND.md` vendored mirror — voice anchor files cited by every
  template's example fill.
- `AGENTS.md` (in particular `## MCP server` at line 73) — disclosure target for the new `### Registry listings`
  subsection.
- `markdownlint-cli2` + `.markdownlint-cli2.yaml` — lint gate for new artifacts.
- The four registries' submission docs (external) — the per-registry deep dives in U3 cite these as authoritative
  sources.

---

## Documentation / Operational Notes

- The strategy doc is internal author-facing, not external agent-facing. It lives at
  `docs/research/mcp-registry-submissions-strategy.md` and is not auto-emitted by `src/build/01-prose-pages.mjs` (which
  walks `content/**/*.md`, not `docs/`).
- The four templates carry `template_version: v1` frontmatter so future revisions can increment without breaking
  cross-references.
- Per-registry contact addresses surface in both the templates' `## Reviewer back-and-forth` section AND `AGENTS.md ###
  Registry listings` so the team has a single canonical pointer.
- A solutions-docs entry capturing the cross-repo "two independent strategy docs converging on the same template set"
  pattern may be worth authoring after streamsgrp's source plan also lands — `~/dev/solutions-docs/workflow-issues/` is
  the natural home. Not in scope for U1-U7 (would be a follow-up after both plans have shipped artifacts).

---

## Sources / Research

- `streamsgrp:docs/plans/2026-06-05-001-feat-mcp-registry-submissions-strategy-plan.md` — the source plan this plan is
  structured against. Authored independently rather than as a dependency; structural shape (Requirements, KTDs, U1-U7)
  follows the source for consistency across the two repos' submission strategies.
- `docs/plans/2026-06-05-001-feat-mcp-endpoint-plan.md` (`status: completed`) — anc.dev's shipped MCP server: 9 tools
  across four surfaces, 5 resources, wire contract, rate limits, discoverability set. The asset to be submitted.
- `PRODUCT.md` (109 lines) — channel-delta voice anchor for the site channel.
- `docs/research/VOICE.md` — register-split voice anchor (opinionated/precise/inviting; third-person; sentence-rhythm
  guidance).
- `BRAND.md` (in `agentnative-spec`, vendored mirror on `dev` branch of this repo) — universal voice anchor.
- `AGENTS.md ## MCP server` (line 73) — disclosure pattern for MCP-adjacent author-facing surfaces.
- `docs/research/2026-04-28-cloudflare-live-scoring-v2.md` and `docs/research/2026-05-04-discovery-chain-hit-rate.md` —
  existing `docs/research/` entries; pattern source for the strategy doc's frontmatter shape.
- Registry official docs (external; cited verbatim in U3):
- Anthropic Connector Directory: <https://www.anthropic.com/api/connectors> (submission form + review SLA)
- smithery.ai: <https://smithery.ai/docs/submit> (CLI publish + repo discovery)
- pulsemcp.com: <https://www.pulsemcp.com/submit> (direct submit OR aggregator-ingest)
- Official MCP Registry: <https://registry.modelcontextprotocol.io/docs> (`server.json` schema + `mcp-publisher` CLI)
