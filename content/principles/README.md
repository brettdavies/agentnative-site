# `content/principles/` — website-audience editorial copy

This directory holds the prose that renders at `/p1` through `/p<N>` (and as raw markdown at `/p<n>.md`). The files here
are **hand-written for a web reader**, not the canonical contract.

## The two-tier model

There are two sets of principle markdown in this repo by design. They diverge intentionally.

### Canonical contract — `src/data/spec/principles/p*-*.md`

Vendored from the [`agentnative`](https://github.com/brettdavies/agentnative) spec repo. Audience is spec implementers
shipping CLIs against the standard, and `anc` (the validator) consuming the requirement IDs to score scorecards. Voice
is formal: explicit `MUST`/`SHOULD`/`MAY` keywords, stable per-requirement IDs (`p1-must-no-interactive` etc.),
applicability conditions, decision-record pointers, and pressure-test notes documenting adversarial review history. Each
file carries YAML frontmatter naming the principle's `id`, `title`, `last-revised` calver, `status`, and a structured
`requirements` array. The site build does **not** render these files — they are a diff target and a data-source for
build-time lookups. They are reconciled mechanically by `bash scripts/sync-spec.sh`, which overwrites the directory
verbatim from the upstream tag.

### Website editorial copy — `content/principles/p*-*.md` (this directory)

Hand-written for a web reader. Audience is visitors reading the standard on anc.dev, plus agents fetching `/p<n>.md` for
context. Voice is condensed and link-aware: site-relative links (`/coverage`), references to `anc` (the consumer-side
CLI) and "your CLI" rather than the spec-internal `agentnative` repo name, no requirement IDs in the prose, no formal
ceremony around MUST/SHOULD/MAY (the keywords still appear, but as readable English rather than RFC-keyword
annotations). No frontmatter — the build glob loads the file as-is. These files render to `/p<n>.html` (the human-facing
principle pages) and `/p<n>.md` (the agent-fetchable twin). They are reconciled manually after each `sync-spec.sh` run.

Both tiers cover the same principles. Neither is a substring of the other, and neither is generated from the other. The
split exists because the spec text optimizes for the implementer who is shipping a CLI and needs the requirement to be
unambiguous; the website text optimizes for the agent or human visitor learning the standard and needs the prose to read
well in a browser tab.

## Reconciliation workflow

After a new spec tag lands upstream (`agentnative` repo's release events fire the site's
`repository_dispatch:spec-release`), a contributor runs:

```bash
bash scripts/sync-spec.sh
```

That mechanically refreshes `src/data/spec/` to the latest tag — **only the canonical tier moves**. Then:

1. Read the spec diff: `git diff src/data/spec/principles/`. Look for new MUST/SHOULD/MAY requirements, reworded
   summaries, new evidence/anti-pattern bullets, and any new principle files (e.g., `p8-...md`).
2. For each substantive change, edit the corresponding `content/principles/p<n>-*.md` file here. Apply the substance,
   **not** the formal-spec phrasing — the editorial voice tightens the language and drops formal markers (no requirement
   IDs in the website prose, no pressure-test notes, no decision-record links unless they materially help the reader).
3. If a new principle was added, author a new `content/principles/p<n>-*.md` here, mirroring the section structure of an
   existing principle (Definition / Why Agents Need It / Requirements / Scope / Evidence / Anti-Patterns).
4. Bump [`content/principles/VERSION`](VERSION) to the new spec version.
5. Add the new slug (filename without `.md`) to `LOCKED_SLUGS` in [`src/build/build.mjs`](../../src/build/build.mjs) if
   a new principle was added — the build's locked-slug invariant fails otherwise.
6. Update outbound cross-references that hard-code the principle count:

- [`content/_intro.md`](_intro.md) — homepage lede ("`/p1` through `/p<N>`")
- [`content/install.md`](install.md) — install copy
- [`src/build/llms.mjs`](../../src/build/llms.mjs) — `/llms.txt` table of contents

Run `bash scripts/hooks/pre-push` (or push the branch) to verify the build invariants pass: locked-slug match,
twin-source equivalence between `dist/p<n>.md` and `content/principles/p<n>-*.md`, homepage links present.

## What does NOT cross over from the canonical tier

Some sections in `src/data/spec/principles/p*.md` are spec-author-internal and stay there:

- **YAML frontmatter** — `id`, `title`, `last-revised`, `status`, `requirements`. The website file is plain markdown.
- **Pressure test notes** (`## Pressure test notes` and the dated subsections under it) — internal review history.
- **Decision-record inline links** (`docs/decisions/...`) — pull these into the website copy only when the rationale
  materially helps a web reader; usually it doesn't.
- **Requirement IDs in prose** — the spec writes "the MUST `p1-must-no-interactive` requires…"; the website writes the
  substance directly without the requirement ID.
- **`agentnative` references** — the standard's repo name. The website copy talks about `anc` (the consumer-side CLI
  validator) and "your CLI" instead.

What DOES cross over: the substance of every MUST/SHOULD/MAY, the evidence list, and the anti-pattern list. If the spec
adds a MUST, the website adds the corresponding paragraph. If the spec rewords a summary materially (not just
punctuation), the website's matching paragraph is reworded too.

## Voice (delta from the homepage)

A principle page is **Register 1b** in [`docs/research/VOICE.md`](../../docs/research/VOICE.md). The reader is no longer
cold — they clicked from the homepage because they want the contract for one principle, so the page IS the contract.
That separates this surface from the homepage (`content/_intro.md`, Register 1a, where the lede earns the click via
concrete narrative).

What that means in practice for files in this directory:

- The Definition's **first sentence names the failure mode**, not the artifact. "A CLI tool that blocks on an
  interactive prompt is invisible to an agent — the agent hangs, the user sees nothing, and the operation times out
  silently." NOT "A non-interactive CLI is one that does not block on prompts."
- The Definition's **first paragraph is also the homepage card** at `/` and the bullet at `/index.md` (auto-pulled by
  `extractDefinitionParagraph` in [`src/build/content.mjs`](../../src/build/content.mjs)). Budget 2-3 sentences. P5 and
  P7 sit at the upper end (~3 sentences, ~80 words); anything longer makes the card visually dominate the index. Content
  that needs more elaboration belongs in Why, not in Definition.
- **No narrative analogies** in Definition or Requirements. Analogies belong on the homepage that brought the reader
  here.
- **RFC-keyword blocks** (`**MUST:**` / `**SHOULD:**` / `**MAY:**`) appear immediately after the Why section. No warm-up
  paragraph between Why and Requirements.
- **Code samples carry weight a paragraph cannot.** A six-line Rust block beats three sentences of prose describing the
  same pattern. The principle pages are the only site surface where code blocks are load-bearing for the argument.
- **Closes** with one short line citing the check IDs that measure the principle today and an `anc check --principle
  <n>` invocation a reader can copy. Use the spec's actual requirement IDs (`p<n>-must-...`, `p<n>-should-...`), not
  paraphrased shorthand.

## Why three version files, not one

The site's footer reads `SITE_SPEC_VERSION` from [`VERSION`](VERSION) here — that's the spec version this directory's
prose has been reconciled to. The vendored snapshot at [`src/data/spec/VERSION`](../../src/data/spec/VERSION) is
independent: it tracks the latest `sync-spec.sh` run and **never displays on any user-visible surface**. The lag during
the manual reconciliation window is honest by design — the footer correctly tells visitors that the prose hasn't caught
up yet.

Full documentation of the three-source version model lives in
[`src/data/spec/README.md`](../../src/data/spec/README.md). The split is enforced in
[`src/build/util.mjs`](../../src/build/util.mjs) (the `SPEC_VERSION` and `SITE_SPEC_VERSION` constants).

## Contributor checklist (TL;DR)

After running `sync-spec.sh`:

- [ ] Read `git diff src/data/spec/principles/` for substantive changes.
- [ ] Edit each affected `content/principles/p<n>-*.md` here to mirror the substance in editorial voice.
- [ ] Author new `content/principles/p<n>-*.md` for any new principles.
- [ ] Add new slugs to `LOCKED_SLUGS` in `src/build/build.mjs`.
- [ ] Update cross-references in `content/_intro.md`, `content/install.md`, `src/build/llms.mjs`.
- [ ] Bump `content/principles/VERSION` to the new spec version.
- [ ] Run `bash scripts/hooks/pre-push` and confirm build invariants pass.
