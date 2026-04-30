---
title: "OG card concept exploration — selected: D1"
type: design-shotgun
status: completed
date: 2026-04-30
plan: docs/plans/2026-04-29-001-feat-brand-og-and-block-normative-plan.md
---

# OG card concept exploration

History of `/design-shotgun` rounds for the anc.dev OG card. Two rounds ran. **D1 won** (round 2). Production
source-of-truth lives at `docs/design/og.html` + `docs/design/og.css`.

## Round 1 — A / B / C (rejected)

The first round explored three different framings:

- **A — spec fragment**: a verbatim P1 paragraph as a typeset specimen.
- **B — publication TOC**: the seven principles with one tag per row.
- **C — single statement**: `MUST · SHOULD · MAY` at display size, no applied content.

User feedback: A is right *for a per-principle OG* (`/p1` etc.) but too narrow for the site-wide card; B's 22pt rows are
hard to read at thumbnail; C displays the RFC 2119 trio as labels rather than putting the trio in service of anc.dev's
content. The trio + writing voice + seven-principle frame is what actually belongs to anc.dev — none of the parts alone
is. Round 1 trashed.

## Round 2 — manifesto trio (selected: D1)

Three normative statements drawn from the spec, each governed by a color-coded RFC 2119 keyword. The trio does work for
*our* content rather than displaying the keywords as labels. The variants explored three different ways the manifesto
could be set:

- **D1 — telegraphic** (selected). Short declarative clauses, no glosses. 60pt display weight. All elements left-aligned
  to a single typographic margin.
- **D2 — flowing** (rejected). Each clause carried an em-dash gloss ("— the agent has no hand to type"). At 56pt the
  clauses wrapped to two lines apiece, killing the manifesto's stacked rhythm and crowding the brand row + version stamp
  against the canvas edges. User noted D2 had "too many words"; trashed.
- **D3 — principle-numbered** (rejected). Same trio as D1 with `P1` / `P2` / `P1` mono prefixes in a left gutter, then
  later (after user feedback) a cleaned variant with the indent preserved but no gutter marker. The original prefix
  variant read as a typo (P1 appearing twice); the cleaned-indent variant had an unmotivated gutter — neither earned its
  asymmetry. Trashed.

### Why D1

D1's all-left-aligned composition is restraint as confidence — every element shares one typographic margin (brand at
top, manifesto in the middle, version stamp at bottom), which reads as a single typographic column rather than a layered
hierarchy. This matches the brand voice in `.impeccable.md` ("opinionated, precise, inviting") without any AI-slop
fingerprints (no side-stripe borders, no decorative indents, no pill tags, no second-favorite fonts).

The chosen content trio:

```text
MUST   run without prompting.        ← P1's foundational rule
SHOULD speak machine-first.          ← P2's worldview, one phrase
MAY    decorate when a TTY is open.  ← P1's safety valve
```

The MAY is the same principle as the MUST (P1) — that's by design. It shows the texture of the spec: agent-native does
not ban human-friendly CLIs, it scopes them. The trio is not a list of rules; it's a worldview in three lines.

### `/typeset` arbitration outcomes

`/typeset` was invoked as a typography arbiter between D1, D2, and D3. It validated D1 and recommended six refinements.
The strong + cheap ones landed before the production promotion:

- Verb-phrase weight 600 → 500 (200-weight delta against the keyword's 700 lets the keyword pop more decisively).
- Brand row tracking -0.005em → 0 (the prior value was sub-pixel optical noise at 28px).
- Manifesto `align-self: center` → `end` (manifesto sits near the footer with breathing room above; reads more confident
  than dead- center).

Two further refinements were A/B-rendered against the canonical `og.html`:

- **`anc.dev` color**: `--fg-heading` → `--accent`. Selected. The brand blue ties the OG to the site's existing
  accent-color treatment and reads as a brand mark rather than title text.
- **Brand row separator**: `1px` rule vs em-dash glyph. Rule kept; em-dash rejected. The em-dash read as AI editorial
  flourish in this position.

A/B render artifacts at `.context/screenshots/005-og-finalize/{A,B,C,D}-*.png` (local-only, gitignored).

## Files

- `D1-manifesto-aligned.html` — selected concept, kept here for history. The shipped production source is at
  `docs/design/og.html` + `docs/design/og.css` (built from D1 with the typeset refinements above, then promoted in Unit
  3).

## What ships next

Unit 4 of the plan creates `scripts/og/generate.ts` (Playwright → Sharp → PNG) consuming `docs/design/og.html`, writes
`public/og-image.png`, and wires `og:image:alt` + `twitter:image:alt` into `src/build/shell.mjs`. The Python Gemini
generator at `scripts/og/generate.py` is deleted in the same unit.
