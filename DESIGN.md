# DESIGN.md — agentnative spec site

Status: PROPOSED (revision 2). Authored by `/design-consultation` on 2026-04-13, revised 2026-04-14 after first-round
feedback. Supersedes the tentative stack and visual placeholders in the CEO plan and AGENT.md where they conflict.

Companion artifacts split by role:

**Generated + hand-authored documents — `docs/design/`** (tracked, reviewer-facing):

- [`docs/design/color-analysis.md`](docs/design/color-analysis.md) — show-your-work color report: culori + apca-w3 tool
  outputs, WCAG and APCA contrast tables, gamut verification, swatch preview. No CSS embedded in the report; the
  stylesheet is the next entry.
- [`docs/design/foundation.css`](docs/design/foundation.css) — generated drop-in stylesheet. Contains palette custom
  properties (light default, dark via `prefers-color-scheme`, explicit `[data-theme]` overrides), typography tokens
  (`--font-sans`, `--font-mono`, scale), and the shipped 7b inline-keyword rules. `@font-face` declarations are
  deliberately NOT in this file (see §4.3 — they live in the site build so the stylesheet is safe to load from any
  origin without phantom 404s). Consumed directly by the HTML preview and, later, by the site build.
- [`docs/design/must-should-may-preview.html`](docs/design/must-should-may-preview.html) — renders the shipped
  typography + 7b keyword treatment (with a 7a plain-bold baseline alongside for contrast) in both color modes via a
  three-state theme toggle (system / light / dark). Loads Uncut Sans from Fontshare and Monaspace Xenon from jsdelivr so
  the fonts render without `/fonts/` self-hosting. Links `foundation.css` directly — no palette or keyword CSS inlined.
- [`docs/design/README.md`](docs/design/README.md) — explains the subsystem and reproduction steps.

**Generator — `scripts/design/`** (tooling, not shipped):

- [`scripts/design/generate-palette.mjs`](scripts/design/generate-palette.mjs) — the script that emits both the report
  and `foundation.css` in `docs/design/`. Run via `cd scripts/design && bun install && bun run generate` (or `bun run
  scripts/design/generate-palette.mjs` from the repo root).

## 1. Summary

The agentnative spec site is the first proof-of-concept for an **agent-native documentation surface**. Every decision
here ladders up to one question: does this choice make the site more agent-legible without making it less human-legible?
When they conflict we default to agent-legibility — the human case survives simple HTML, the agent case does not survive
hidden state or heavy client runtimes.

**Decision A (tech stack): static-site generation from markdown via a small custom build pipeline, served by a thin
Cloudflare Worker for content negotiation.** SSG is a hard requirement; SSR and CSR are explicitly out. Astro +
Starlight is more viable in April 2026 than it was twelve months ago because three community plugins
(`starlight-dot-md`, `starlight-llms-txt`, `starlight-copy-button`) now solve most of the agent-native concerns out of
the box. It is still the second-best choice for this specific site because Starlight is built for 50- to 5,000-page
documentation sets; at nine pages, its overhead exceeds its payoff, and `Accept: text/markdown` header negotiation still
requires a Worker regardless of framework. Astro without Starlight is the credible middle ground. Flip conditions are
concrete and documented below.

**Decision B (visual system): cool-neutral palette at hue 250, navy accent in the same family, deliberately-designed
dark mode (not inverted), Pangram Pangram's Uncut Sans (body + display) paired with GitHub Next's Monaspace Xenon (code)
— both OFL, self-hosted, chosen via the impeccable font-selection procedure to avoid the reflex-defaults (Inter, IBM
Plex, Fraunces, etc.), code as a first-class visual element, `prefers-color-scheme` *plus* a visible user toggle, sticky
mini-TOC on desktop.** Palette and contrast work is backed by a reproducible tool run — see
`docs/design/color-analysis.md` for inputs, outputs, WCAG + APCA numbers, and every clamped value; the foundation
stylesheet (palette + typography tokens + keyword rules) lives at `docs/design/foundation.css`. `@font-face`
declarations live in the site build, not the foundation — see §4.3. MUST / SHOULD / MAY keywords ship option 7b (inline
color only) — the originally-proposed 7b-plus side-stripe variant was pulled after it hit impeccable's banned-pattern
list, with block-level alternatives (leading tag, background fill) deferred to live-site iteration. Preview at
`docs/design/must-should-may-preview.html`.

**JS posture.** Pragmatic. The CEO plan's original "total shipped JS ≤25 KB" ceiling is a target, not a guardrail. User
direction: "use a library if it earns its place; total page payload up to 1–2 MB is acceptable." We still reject
shipping a framework runtime for state the site does not use, we still do syntax highlighting at build time, we still
treat every new dependency as an opt-in that needs a one-line justification in this file. But "roll our own
click-to-copy to save 600 bytes" is no longer the default posture — use the native Clipboard API directly (which needs
no library), and when a browser-quirk floor genuinely demands one, name it.

Both decisions assume the invariants restated in §3.4: markdown is the source of truth, same `.md` renders the HTML and
is served raw for content negotiation and `llms-full.txt`, stable per-principle anchors, `llms.txt` + `llms-full.txt` at
root, Schema.org `TechArticle` JSON-LD per page, mobile-first, a11y baseline, SSG hard.

## 2. Reference survey

Eight sites studied, mixed across the three groups in the session spec. One paragraph each.

### Group 1 — starred references

**developers.cloudflare.com.** Astro + Starlight; the stack-default benchmark. Borrow: tight type rhythm, generous
vertical whitespace between prose and code, distinct code-block background with unobtrusive border, a copy button on
every fenced block, tabbed language samples where they add signal, dark mode that looks intentional rather than
auto-inverted, stable anchor targets with an on-hover anchor affordance, sidebar TOC that tracks scroll position. Avoid:
the full Starlight chrome (breadcrumbs, "on this page" floating TOC, version switcher, search overlay) for a nine-page
site; the marketing-adjacent navigation. One-line vibe: "RFC written in a codebase with a styleguide." Tech: Astro 6 +
Starlight 0.38 + Cloudflare Pages/Workers; server-rendered, ≤~40 KB JS per page, Shiki via expressive-code.

**clig.dev.** Single-column, centered, ~700 px measure, geometric sans with generous leading, muted neutral palette,
understated navy accent, all content on one page with anchors. Borrow: the confidence to commit to one long page; the
restrained palette; the subtle `<h2>` separators that double as section breaks without decorative lines; the quiet
footer that reads like a colophon. Avoid: the slightly clubby author-first framing (agentnative speaks as a standard,
not a person); the code blocks under-index on density (we will be code-heavier). One-line vibe: "a well-edited zine on
how to build CLIs." Tech: Jekyll-ish static; effectively plain HTML.

**github.com/brettdavies/lmgroktfy.** Vibe-calibration only. Borrow: honest product copy, minimal chrome, the "it is
obvious what this is" feel. Avoid: the product-landing gradient and form-forward layout — this is a spec site, not a
product page. One-line vibe: "single-purpose, confident." Tech: not directly knowable from the surface.

### Group 2 — other spec and standards surfaces

**12factor.net.** Numbered-principle layout the agentnative spec structurally resembles, anchor-per-principle, RFC
voice. Borrow: the numbered-section pattern; the confidence to have no sidebar nav and rely on in-page anchors. Avoid:
the dated visual (serif body, flat blue links, '90s table-of-contents chrome); the lack of any visual treatment on code.
One-line vibe: "a standard that has aged like a standard, honestly." Tech: static HTML, likely Jekyll.

**rust-lang.org/book.** The code-heavy reference point. Borrow: generous code-block padding; mono that actually renders
as mono on every platform; syntax highlighting that prefers readability over rainbow; left sidebar `<details>`-style TOC
on desktop; the way inline `code` and block code share a visual family. Avoid: the mdBook default chrome (print button,
in-header search, theme switcher) — we do not need them; the slightly heavy dark theme. One-line vibe: "a textbook that
wants to be referenced." Tech: mdBook; static HTML with a small client-side search bundle.

**json-schema.org** and **semver.org** as a pair. Both tiny, authoritative, text-first. Borrow from semver: the
near-absurd simplicity of a single page with an anchored list of MUST/SHOULD statements, readable in a single scroll,
citable by fragment; the footer-only attribution. Borrow from json-schema: the distinction between the spec surface and
the implementation surface (we mirror this: the site is the spec, the CLI repo is the implementation). One-line vibe:
"the shortest document that could possibly replace itself." Tech: both plain HTML / static.

### Group 3 — agent-native and AI-dev surfaces

**anthropic.com/claude/docs.** Clean, dense, type-led; code blocks treated as equal citizens to prose; dark mode by
default on many paths. Borrow: the way code is centered in the reading flow rather than pushed to a sidebar; the
prompt-and-response pair as a native layout; the restraint on decoration. Avoid: the corporate nav chrome (we have no
product to sell); the soft-rounded cards (clashes with RFC voice). One-line vibe: "engineering docs that trust the
reader." Tech: Next.js; not a template we would reach for at our scale.

**llmstxt.org.** The canonical source for the `llms.txt` convention we are implementing. Borrow: the willingness to be
small; the specification-first layout; the direct example in the middle of the page rather than linked off. Avoid: the
mixed-body feel (drifts between spec, blog post, and FAQ). One-line vibe: "a proposal that is also the worked example."
Tech: static; plain HTML.

### Reference benchmark, not a candidate

**Mintlify.** Commercial platform; ships the full agent-native documentation surface natively — auto `/llms.txt`,
`/llms-full.txt`, `.md` URL suffix, `Accept: text/markdown` content negotiation, `Link` and `X-Llms-Txt` response
headers, and a `noindex` hint on the markdown variant so search engines don't double-index. If we were publishing a
product docs site for a for-profit tool we would seriously evaluate it. For a standard we own end-to-end and publish
under our own domain, it is a useful reference for what "done" looks like, not a platform to buy into.

## 3. Decision A — tech stack

### 3.1 Hard requirement: SSG

Static site generation, full stop. HTML rendered from markdown at build time, uploaded as static assets, served from
edge storage via a Worker for routing. This is non-negotiable for three reasons:

1. **Agent cacheability.** Agents fetch, reuse, and cite URLs. Static HTML is identical byte-for-byte across fetches,
   cache cleanly at every layer, and never depend on a live server.
2. **Tail-risk floor.** The site stays reachable even if the build pipeline breaks. Last good commit is always a
   deployable artifact.
3. **Thesis fit.** The `Accept: text/markdown` and `.md` suffix behavior become trivial when the markdown source **is**
   the artifact — the Worker serves bytes, it doesn't synthesize them.

SSR is out because it adds a runtime dependency (on every request) for content that does not change between
deployments. CSR is out because it puts the single most important thing on the site (the spec text) behind a client
runtime, which defeats the agent case entirely.

### 3.2 Candidates evaluated

1. **Plain HTML from markdown via a small custom build pipeline + Cloudflare Worker** (CEO plan's default)
2. **Astro + Starlight** (with `starlight-dot-md`, `starlight-llms-txt`, `starlight-copy-button`)
3. **Astro without Starlight**
4. **Hugo + Cloudflare Worker shim** for content negotiation
5. **Eleventy + Cloudflare Worker shim**
6. **Writing HTML by hand** (no markdown source) — listed to reject

Explicitly NOT a candidate: Cheng Lou's Pretext (per session spec — no image-wrapping need).

### 3.3 Scored table

Scoring 1 (bad) to 5 (great). "MD-SoT fit" = markdown-source-of-truth fit. "CN story" = content-negotiation story for
`/p1.md` **and** `Accept: text/markdown` header on the same URL. "CF deploy" = Cloudflare deploy story. "Std iter" =
maintenance cost when the standard iterates. "Thesis fit" = alignment with the agent-native documentation surface
philosophy.

| Criterion                       | Plain+Worker | Astro+Starlight | Astro alone | Hugo+Worker | Eleventy+Worker | Hand-HTML |
| ------------------------------- | -----------: | --------------: | ----------: | ----------: | --------------: | --------: |
| Simplicity                      |            5 |               3 |           4 |           3 |               3 |         5 |
| Bloat risk                      |            5 |               3 |           4 |           4 |               4 |         5 |
| MD-SoT fit                      |            5 |               5 |           5 |           5 |               5 |         1 |
| CN story (`.md` + Accept)       |            5 |               4 |           4 |           4 |               4 |         5 |
| Clickable codeblock             |            5 |               5 |           5 |           4 |               4 |         5 |
| Tabbed multi-lang code          |            5 |               5 |           4 |           3 |               3 |         4 |
| Theme-toggle + prefers-cs       |            5 |               5 |           5 |           5 |               5 |         5 |
| CF deploy                       |            5 |               5 |           5 |           4 |               4 |         5 |
| Std iter cost                   |            4 |               3 |           4 |           4 |               4 |         1 |
| Thesis fit                      |            5 |               4 |           4 |           4 |               4 |         1 |
| **Total (/50)**                 |       **49** |          **42** |      **44** |      **40** |          **40** |    **37** |

Changes from revision 1:

- **Astro + Starlight moved 35 → 42** on the strength of `starlight-dot-md` solving the `.md` suffix,
  `starlight-llms-txt` solving index generation, `starlight-copy-button` shipping a tested copy UX, and Starlight 0.38
  treating dark-mode toggle as built-in (the CEO plan's no-toggle stance is softened per user direction).
- Astro-alone moved 43 → 44 to match the revised theme-toggle criterion.
- Plain+Worker holds at 49; MD-SoT fit and thesis fit are unchanged by ecosystem movement.
- Hand-HTML unchanged; still rejected.

### 3.4 Recommendation

**Ship on plain HTML generated from markdown by a ≤200-line build script, routed by a ≤80-line Cloudflare Worker.**
This is still the right call, and the argument has tightened since revision 1.

What the build step does, in order: read `content/*.md`, parse with `unified` (`remark-parse` + `remark-gfm`), extract
headings for anchor generation (`rehype-slug`), syntax-highlight with `shiki` at build (emits dual-theme inline styles),
convert to HTML with `remark-rehype` + `rehype-stringify`, template into a single shared HTML shell, write
`dist/*.html`, copy source `.md` files to `dist/*.md`, generate `dist/llms.txt` and `dist/llms-full.txt` from the
content index, emit `dist/sitemap.xml` and `dist/og-image.png` (the latter via `satori`). Dependencies are all
build-time and pinned.

The Worker is ~80 lines: static assets from `env.ASSETS`, content-negotiation branch on `url.pathname.endsWith(".md")
|| accept.includes("text/markdown")`, `Link` and `X-Llms-Txt` response headers on every HTML response (copying the
Mintlify pattern), `X-Robots-Tag: noindex` on the markdown variant so search engines do not double-index. Deploy is
`wrangler deploy`. Rollback is `wrangler rollback`.

**Why this wins for this site, specifically.**

- **Nine pages.** Everything a framework gives for free (sidebar nav, search indexing, component library, multi-version
  switcher) is either unused or faintly in the way.
- **Content-negotiation semantics stay in one file we own.** Even with Starlight's plugin ecosystem, `Accept:
  text/markdown` on the same URL is not a plugin — it is a Worker concern. If the Worker exists regardless, the
  framework's incremental value for this site is reduced to "it generates the HTML shell" — which we can do in ~40 lines
  of templating.
- **Plugin supply chain.** With Astro + Starlight + three agent-native plugins, we depend on four moving parts
  maintained by different humans on different release cadences. Each Starlight major-version upgrade risks plugin lag.
  Plain+Worker depends on `unified` and `shiki`, both mature and move slowly in breaking ways.
- **Dogfooding the spec's own thesis.** The standard says "small, explicit, composable tools." The site's architecture
  is part of the spec's argument.
- **Upgrade cost over a decade.** HTML does not churn. CommonMark and Shiki are reasonable to pin and replace.

**Cost honestly stated.** We write ~200 lines of build script. We write ~80 lines of Worker. We do not get Starlight's
prebuilt components free — specifically, we hand-wire click-to-copy (native Clipboard API, ~40 lines), anchor-copy
buttons (~30 lines), and CSS-only tabbed code (radio/`:checked`, ~60 lines CSS, no JS). The theme toggle (§4.9) is ~40
lines of JS + CSS. Total hand-rolled surface ≈ 450 lines across HTML template + Worker + JS + CSS, plus the build
script. Auditable in one sitting.

### 3.5 Invariants (hold regardless of stack)

Markdown is the source of truth. Same `.md` renders the HTML and is served raw for `/p1.md`, `/p1` under `Accept:
text/markdown`, and `/llms-full.txt`. `llms.txt` + `llms-full.txt` at site root per llmstxt.org. Schema.org
`TechArticle` JSON-LD in every HTML `<head>`. Stable per-principle anchor IDs `#p1-non-interactive-by-default` through
`#p7-bounded-high-signal-responses`. Version and date in footer. Deploy on Cloudflare Workers with Static Assets. SSG
hard. Mobile-first. A11y baseline: skip-link, semantic landmarks, `prefers-reduced-motion`, `:focus-visible`, contrast
verified in `docs/design/color-analysis.md`. `Link` and `X-Llms-Txt` response headers advertising the indexes.
`X-Robots-Tag: noindex` on the markdown variant to prevent search-engine double-indexing.

### 3.6 Second-best: Astro without Starlight

Scores 44/50 and is the credible fallback. Gives us a tested markdown pipeline, zero client JS by default, first-class
Shiki integration via `@astrojs/markdown-remark`, and the Astro CLI/dev-server ergonomics a hand-rolled build lacks. It
loses to plain+Worker on thesis fit (we still ship a framework) and on CN story parity (Astro emits `/p1/index.html`; we
either adopt a slightly non-conventional URL shape, configure output to flatten to `/p1.html`, or implement the `.md`
suffix in the Worker the same way as plain-HTML — in which case we kept the Worker work and paid for Astro anyway). Good
choice if Brett wants the dev-server comfort and the community-maintained markdown pipeline.

### 3.7 Flip conditions (what would change the recommendation)

- **Scope crosses ~20 pages.** Hand-built navigation, per-page frontmatter wrangling, and a custom search solution start
  eating more time than a framework would. At ~20 pages we revisit Astro-alone; at ~40 we revisit Starlight.
- **Versioning becomes real.** Phase 2+ work (TODOS.md P2) introducing per-version spec rendering tips toward a
  framework with first-class version handling. Starlight earns its keep here.
- **Client-side search becomes a requirement.** We do not need it for nine pages, but a "search across all principles"
  add-on requires either a 20–50 KB client bundle (pagefind, flexsearch) or a server endpoint.
- **We share a docs theme across multiple properties.** If `agentnative-site`, `davies.fyi`, and a future third site
  converge on a common layout, moving all three to a shared Astro theme is cheaper than maintaining three bespoke
  pipelines.

### 3.8 Delta from the CEO plan

Clarification for `/plan-eng-review`: the AGENT.md phrase "no build pipeline beyond the Worker's CommonMark render
step" should be amended. The CommonMark + Shiki render happens at **build time** on the author's machine (and in CI),
not at request time in the Worker. The Worker only routes. This matches the Shiki-at-build guidance in the agent-native
documentation surface pattern at
`docs/solutions/architecture-patterns/agent-native-documentation-surface-2026-04-13.md`.

## 4. Decision B — visual system

One direction. The CEO plan's stated preference ("simple and traditional with modern web flair, clig.dev >
12factor.net") is specific enough to commit to a single system.

### 4.1 Palette (summary; full methodology in `docs/design/color-analysis.md`)

Cool-neutral base, hue 250, one accent in the same hue family, three semantic warm-or-cool accents for MUST / SHOULD /
MAY. The choice of cool over warm is load-bearing for spec adoption: research summarized below lands decisively on cool
neutrals for technical documentation. The full ramps, WCAG ratios, APCA Lc values, and gamut-clamping record live in
`docs/design/color-analysis.md` — all generated by `scripts/design/generate-palette.mjs` using `culori` and `apca-w3`.

**Why cool, not warm — color psychology for spec adoption.** Synthesized from 2026 industry sources (see sources
appendix at end of file). Three findings drive the call:

1. **Cool neutrals read as credible and logical in developer-facing contexts.** Blue-tinged grays and cool off-whites
   are the consistent pattern across enterprise dev tools, design systems (Material, Fluent, Carbon), and long-form
   technical documentation. Warm neutrals carry approachability and reduced-sterility, which is the right call for
   consumer or lifestyle brands but *not* for a standard expecting adoption based on authority.
2. **Trust decision happens in ~50 ms, driven by color first.** Readers decide "does this feel trustworthy" before they
   read a word. A spec site has exactly one shot at that first impression, and the spec's credibility is the asset being
   defended. Cool = "engineered." Warm = "approachable." We want engineered.
3. **Selective warm accents in semantic callouts are the consensus best practice.** Cool base + warm attention-getters
   (MUST keyword in red-orange, SHOULD in ochre) is the pattern that balances cool-credibility with necessary visual
   priority for the MUST/SHOULD/MAY triad.

This reverses revision 1's warm-neutral palette. The warm palette would have been distinctive but wrong for a
standard courting developer adoption.

**Emitted token summary** (full table with OKLCH, hex, and contrast in `docs/design/color-analysis.md`):

| Role           | Light (hex) | Dark (hex) | Notes                                     |
| -------------- | ----------- | ---------- | ----------------------------------------- |
| `--bg`         | `#fafbfd`   | `#060a0e`  | Page background.                          |
| `--bg-code`    | `#f0f4f7`   | `#0d1218`  | Inline + block code background.           |
| `--border`     | `#cfd5db`   | `#222a32`  | Hairline dividers, code-block border.     |
| `--fg-muted`   | `#525960`   | `#9199a2`  | Secondary text, footer, captions.         |
| `--fg-body`    | `#1a2026`   | `#dfded8`  | Body prose. Warm off-white in dark mode.  |
| `--fg-heading` | `#070c11`   | `#f3f2ed`  | Headings.                                 |
| `--accent`     | `#0058aa`   | `#6dbdff`  | Links, focus ring, copy-button hover.     |
| `--must`       | `#af2b25`   | `#ff9c8d`  | RFC keyword: MUST.                        |
| `--should`     | `#a16100`   | `#f6b669`  | RFC keyword: SHOULD.                      |
| `--may`        | `#007980`   | `#64d1d7`  | RFC keyword: MAY.                         |

All body pairs pass WCAG AA (≥4.5:1) **and** APCA body minimum (|Lc| ≥ 60) in both modes. Headings exceed AAA. Two
dark-mode tokens (`must`, `accent-subtle`) required a tuning pass after the first APCA run flagged them below the 60
threshold; the tuning is recorded in the script as a comment, and the second-pass contrast table in the report shows all
pairs clearing thresholds.

### 4.2 Dark mode is deliberately designed (not inverted)

Per user direction ("inverted neutrals are acceptable only if they are what would have been chosen otherwise"). The dark
palette was designed independently, not derived by flipping lightness. Four deliberate deviations from a pure inversion:

1. **Background at L=14, not L=0.** Near-black, not pitch-black. Pitch-black produces halation around body text on LCDs.
   L=14 is approximately GitHub-dark and VS Code-dark — the level the industry has converged on.
2. **Mid-range chroma slightly higher (up to 0.02) than light-mode mid-range.** Low-chroma grays on dark backgrounds
   read dead; a hint of hue keeps the UI from feeling Kindle-adjacent.
3. **Text top tones warm-shift to hue 95** (warm off-white), not hue 250 (cool near-white). Cool text on a cool dark
   background vibrates; a warm-white text tier is the standard dark-theme comfort move. Same chroma, same perceived
   lightness, different hue.
4. **L curve is smoother through the 30–60 range** than the light-mode curve, because dark UI needs more separation in
   the mid-grays for borders, muted text, and raised surfaces.

Each deviation is documented inline in `scripts/design/generate-palette.mjs` (`DARK_SCALE` comments) so a future
   reviewer
sees the *why* alongside the numbers.

### 4.3 Type stack

**Ship Pangram Pangram's [Uncut Sans](https://fontshare.com/fonts/uncut-sans) for body + display, and GitHub Next's
[Monaspace Xenon](https://monaspace.githubnext.com/) for code.** Both OFL. Chosen via the full font-selection procedure
in [impeccable's typography reference](.claude/skills/impeccable/reference/typography.md) — not from the training-data
defaults (Inter, IBM Plex, Fraunces, Space Grotesk, Instrument Serif, all of which impeccable ships a
reflex-fonts-to-reject list for). See session notes in [`.impeccable.md`](.impeccable.md) for the 3-word brand voice
("opinionated, precise, inviting") that drove the pick.

**Stacks emitted in [`docs/design/foundation.css`](docs/design/foundation.css)** — reproduced here for review; do not
hand-edit the CSS, change the generator:

```css
--font-sans:    "Uncut Sans", ui-sans-serif, system-ui, -apple-system,
                "Segoe UI", Roboto, "Helvetica Neue", sans-serif,
                "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol";
--font-mono:    "Monaspace Xenon", ui-monospace, "SF Mono", "Cascadia Code",
                Menlo, Consolas, "Liberation Mono", monospace;
--font-display: var(--font-sans);   /* single family by default */

--ff-sans:      "kern" 1, "liga" 1, "clig" 1;
--ff-mono:      "kern" 1, "liga" 0, "clig" 0, "calt" 0;
--ff-tabular:   "tnum" 1, "kern" 1;  /* version/date footer, numeric tables */
```

Ligatures and contextual alternates are OFF in mono so spec operators (`>=`, `!=`, `->`, `|>`, `->|`) render with
explicit character shapes — critical for a document whose correctness depends on the reader seeing exactly what is
written. Body ligatures stay on because common ligatures (fi, fl, ffi) improve Latin prose readability with no operator
risk.

**Production loading.** The `@font-face` declarations live in the **site build's** CSS, not in `foundation.css`. Keeping
them out of `foundation.css` means the generated stylesheet is safe to load from any origin without phantom 404s against
missing `/fonts/` paths — relevant for design previews, demos, and any consumer that loads `foundation.css` without the
site around it. At site-build time, emit the following (into the site's `site.css` or inlined in the HTML shell):

```css
@font-face {
  font-family: "Uncut Sans";
  src: url("/fonts/uncut-sans-variable.woff2") format("woff2-variations");
  font-weight: 100 900;
  font-display: swap;
  unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+2000-206F, ...;
}
@font-face {
  font-family: "Monaspace Xenon";
  src: url("/fonts/monaspace-xenon-variable.woff2") format("woff2-variations");
  font-weight: 200 800;
  font-display: swap;
  unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+2000-206F, ...;
}
```

Also emit `<link rel="preload" as="font" crossorigin>` for both files in the HTML `<head>` so the swap happens on first
paint rather than mid-render. Total shipped: ~35–50 KB gz per family (Latin subset, variable axis) — well inside the 1–2
MB page-payload ceiling.

**Metric-matched fallbacks — TO CALIBRATE AT IMPLEMENTATION.** The `@font-face` block above deliberately omits
`ascent-override` / `descent-override` / `size-adjust`. These reduce layout shift during the font-display swap but
require real metric measurement. Before ship: run [Fontaine](https://github.com/unjs/fontaine) (or read tables directly
with `fontkit`) against the shipped woff2 files, compute the overrides, and commit them into the site build's
`@font-face` block. Do not guess — wrong overrides cause visible shift, worse than the default.

**Preview behavior.** `docs/design/must-should-may-preview.html` loads Uncut Sans from Fontshare and Monaspace Xenon
from jsdelivr's Fontsource build via two `<link>` tags at the top of the HTML. Those CDN stylesheets register their own
`@font-face` rules, which in turn make `"Uncut Sans"` and `"Monaspace Xenon Variable"` available as named families; the
preview's own `<style>` block overrides `--font-mono` to add the `Variable` suffix variant so the Fontsource-registered
name wins. Production builds register the mono as `"Monaspace Xenon"` without the suffix, per the site-build
`@font-face` block above — the token in `foundation.css` uses the unsuffixed name by default, so production works
unmodified.

### 4.4 Type scale

Modular scale, 1.25 ratio (major third), fluid body via `clamp()` from 17px at 360px viewport up to 18px at ~1100px. H1
also clamps. H2–H4 stay fixed (impeccable's guidance: "Fixed `rem` scales for app UIs, fluid for marketing/content page
headings" — this site is content-page, so body + h1 flex, inner headings do not).

All values emitted as tokens in `foundation.css`:

| Token              | Value                                       | Role                                              |
| ------------------ | ------------------------------------------- | ------------------------------------------------- |
| `--text-base`      | `1.0625rem` (17px)                          | Reference unit; body floor.                       |
| `--text-body`      | `clamp(1.0625rem, 0.975rem + 0.4vw, 1.125rem)` | Body prose, fluid 17→18px.                       |
| `--text-caption`   | `0.8125rem`                                 | Footer stamp, captions, section eyebrows.         |
| `--text-secondary` | `0.9375rem`                                 | Sidebar TOC entries, mini-TOC items.              |
| `--text-h4`        | `1rem`                                      | Used sparingly; small-caps labels.                |
| `--text-h3`        | `1.22rem`                                   | MUST/SHOULD/MAY group heading.                    |
| `--text-h2`        | `1.5rem`                                    | Principle section start.                          |
| `--text-h1`        | `clamp(1.85rem, 1.6rem + 1.2vw, 2.25rem)`   | One per page; fluid display size.                 |
| `--text-code`      | `0.92rem`                                   | Inline + block code body.                         |
| `--leading-body`   | `1.6`                                       | Body line-height.                                 |
| `--leading-heading`| `1.25`                                      | Headings.                                         |
| `--leading-code`   | `1.5`                                       | Code blocks.                                      |
| `--measure`        | `68ch`                                      | Body line length; capped per Butterick 45–75 rule.|
| `--tracking-caps`  | `0.04em`                                    | Small-caps / ALL CAPS labels.                     |
| `--tracking-rfc`   | `0.02em`                                    | MUST/SHOULD/MAY inline keywords.                  |

Weights: body 400, bold-emphasis 600, headings 600. Uncut Sans ships 100–900 (variable axis); we use 400 + 600. Never
more than three weights rendered on one page.

**Ship-time calibration item.** Uncut Sans has a slightly lower x-height than `system-ui` on macOS and slightly higher
than Segoe UI on Windows. The 17→18px body range was tuned against system-ui metrics; with Uncut Sans loaded the
rendered body may read fractionally smaller (x-height-wise, not absolute size). Open
`docs/design/must-should-may-preview.html` side-by-side with a reference spec (rust-lang.org/book, clig.dev) and eyeball
whether body wants to bump to `1.125rem` base. If yes: adjust `--text-base` in the generator, re-run, re-verify APCA
(smaller text raises the contrast bar).

Measure: `max-inline-size: var(--measure)` on `<article>`. Paragraphs separated by `0.9em`, no first-line indent.

### 4.5 Spacing scale

```css
--space-1: 4px;  --space-2: 8px;  --space-3: 12px; --space-4: 16px;
--space-5: 24px; --space-6: 32px; --space-7: 48px; --space-8: 64px;
```

Section gap: `--space-7`. Code block margin-block: `--space-5`.

### 4.6 Code blocks

Most visually load-bearing element. All code authored in markdown with language tags. Highlighted at **build time** via
Shiki using a dual-theme configuration (`github-light` + `github-dark-dimmed`). One rendered `<pre>` serves both modes
via inline CSS custom properties — no client-side theme JS, no FOUC on mode switch.

Treatment:

- Background `var(--bg-code)`, hairline border, radius `6px`, padding `var(--space-4) var(--space-5)`.
- `font-family: var(--font-mono)`, `line-height: var(--leading-code)`, `font-size: var(--text-code)`,
  `font-feature-settings: var(--ff-mono)` (ligatures + contextual alternates OFF for explicit operator shapes).
- Horizontal scroll on overflow; no wrap.
- Language tag in top-right as a `<span>`, `--fg-muted`, `font-size: 0.75rem`, absolute-positioned (parent has
  `position: relative`).

**Round-trip constraint.** Shiki applies highlighting via wrapping `<span>` tags on tokens. The copy button (§4.8)
copies the `textContent` of the `<code>` element, which strips span wrappers and returns original source. The markdown
channel serves the raw `.md` file, so highlighting never contaminates `text/markdown`.

### 4.7 RFC-keyword treatment — ship 7b (inline), defer block

**Ships: option 7b (inline keyword color only).** The block-level callout variant — originally spec'd as 7b-plus with a
3px left-edge accent stripe — was pulled after impeccable's `<absolute_bans>` rule flagged `border-left > 1px` on
callouts as the #1 most-overused AI-slop pattern. The ban applies regardless of semantic color, radius, opacity, or
variable-name intent. Even a semantic MUST/SHOULD/MAY stripe is banned. The only non-controversial keyword treatment
that survives the ban is the inline color on the word itself.

The shipped CSS (three rules, emitted by `foundation.css`):

```css
.rfc-must   { color: var(--must);   font-weight: 600; letter-spacing: var(--tracking-rfc); }
.rfc-should { color: var(--should); font-weight: 600; letter-spacing: var(--tracking-rfc); }
.rfc-may    { color: var(--may);    font-weight: 600; letter-spacing: var(--tracking-rfc); }
```

Preview at [`docs/design/must-should-may-preview.html`](docs/design/must-should-may-preview.html) shows 7a (plain bold,
baseline) vs 7b (inline color) side by side in both color modes. Contrast validated against APCA body minimum (|Lc| ≥
60) in both modes — see `docs/design/color-analysis.md`.

**How the build applies the markup.** A small remark plugin runs a single inline pass at render time. It replaces
bare-word occurrences of `MUST` / `MUST NOT` / `SHOULD` / `SHOULD NOT` / `MAY` in prose text nodes with `<strong
class="rfc-must">MUST</strong>` (and tier-appropriate classes). Skips occurrences inside `<code>`, `<pre>`, and link
labels so we do not recolor shell output or URL text. Cost: ~30 lines. Raw markdown stays unchanged (uppercase keywords
in source) so the `text/markdown` channel is a pristine copy.

#### Deferred: block-level treatment (decide once the site is live)

The inline keyword color handles mid-sentence references ("Tools MUST detect invalid state early") well. The *tiered
information architecture* of the principles — `**MUST:**` / `**SHOULD:**` / `**MAY:**` section headers followed by
bullet lists — will probably want additional visual chunking so a scroll-speed reader can see which tier a given bullet
belongs to. The ban forecloses the side-stripe; two post-ban candidates remain, both to be evaluated against real
principle content after the site is rendering:

1. **Leading RFC tag.** Render each requirement-list item with a colored, bold keyword tag as a left prefix: `MUST Use
   try_parse() instead of parse().` The tag carries the color; no border, no background fill. Reads like a rendered RFC
   draft. Implementation: remark plugin's second pass inserts `<span class="rfc-tag rfc-must">MUST</span>` before the
   `<li>` text; a small CSS rule sets fixed-width inline-block. Cost: ~40 lines of plugin + ~8 lines of CSS.
2. **Full background tint.** Wrap each requirement-list paragraph with `class="callout must"` (or `should` / `may`);
   foundation.css adds `.callout.* { background: var(--must-wash); padding: ... }` — flat fill, no border. Reads as a
   tinted panel, more visual weight than the leading tag. Cost: ~20 lines of plugin + ~6 lines of CSS + three wash
   tokens (the generator knows how to produce them; currently omitted from `foundation.css`). See the generator comment
   where `light["must-wash"]` used to live.

**Why defer.** Taste calls work better against real content than against mockups. Once the site renders with
actual principle copy, a 5-minute toggle between inline-only, leading-tag, and background-tint in a live browser is more
informative than any amount of discussion in advance. The remark plugin and CSS live in the generator and the build, so
the swap is a PR, not an architecture change. Until then: inline only.

### 4.8 Interaction menu

Revised per user direction: "some JS is OK, don't go overboard; use a library if it earns its place." Cross-browser
reality accepted; where the native API is solid in April 2026 we use it directly, and where it is not we name the
library we would reach for.

| #  | Interaction                              | Approach                                                                       | Approx shipped weight |
| -- | ---------------------------------------- | ------------------------------------------------------------------------------ | --------------------: |
| 1  | Click-to-copy on every `<pre>`           | Vanilla `navigator.clipboard.writeText()` with a fallback for pre-2022 Safari (`document.execCommand('copy')` guarded by feature-detect). No library; the native API is boringly reliable. | ~1.2 KB gz JS         |
| 2  | Copy-anchor-link on each heading         | Vanilla: `location.href = url + '#' + id` + Clipboard API. Same fallback path as #1. | ~0.8 KB gz JS         |
| 3  | Tabbed multi-language code (Rust / Python / Go / Node) | CSS-only (hidden radio + `:checked ~ .panel` selectors). Progressive: first panel visible even without CSS. Keyboard-accessible via labels. No JS. | 0 JS; ~80 bytes CSS  |
| 4  | Theme toggle (system / light / dark)     | Vanilla JS reads `localStorage`, sets `[data-theme]` attribute on `<html>`, no flash on load via a tiny inline `<script>` before first paint. See §4.9. | ~1.0 KB gz JS + tiny inline |
| 5  | Syntax highlighting                      | Shiki at **build**, inline CSS variables. No client runtime.                   | 0 JS; CSS only        |
| 6  | Icons (copy, check, anchor)              | Inline SVG per-button, tree-shaken from `lucide` at build, not a client font.   | ~0.3 KB per icon      |

**Total shipped JS for v0**: approximately 3–4 KB gzipped. Well under the relaxed payload budget. No third-party
analytics, no CDN imports at runtime. Every `<script>` tag has one job.

**When we would reach for a library.** Documented up front so `/plan-eng-review` does not have to re-derive:

- **Clipboard quirks beyond Safari pre-2022:** `clipboard-polyfill` (~4 KB gz). Not shipping unless bug reports arrive.
- **Syntax highlighting hovers / diagnostics:** `shiki-twoslash` if we want type-hover tooltips in Rust code blocks.
  Defer; cost grows fast.
- **Keyboard-friendly tab implementation beyond CSS-only:** tiny `<role="tablist">` helper (~1 KB hand-rolled).
  Implement if the CSS-only pattern fails the `axe-core` audit.

**Explicitly rejected:**

- Analytics runtime. Cloudflare's edge request logs cover what we need.
- Client-side search (nine pages).
- Scroll-spy TOC highlighting (`:target` + browser hash-change suffice).
- Code-block line numbers.
- Framework runtime of any kind.

### 4.9 Theme toggle and `prefers-color-scheme` interaction

Ship both the OS-preference default **and** an explicit user toggle. Three states: `system` (follow OS), `light`,
`dark`. Pattern:

```css
/* Default: light */
:root { --bg: ...; /* light tokens */ }

/* OS-level dark preference applies when user has NOT overridden. */
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) { --bg: ...; /* dark tokens */ }
}

/* Explicit overrides take precedence over OS preference. */
:root[data-theme="dark"]  { --bg: ...; /* dark tokens */ }
:root[data-theme="light"] { --bg: ...; /* light tokens */ }
```

The `:root[data-theme="dark"]` selector beats the media query because `[data-theme]` has higher specificity than the
unqualified `:root`, and both override the base `:root` rules. The `:not([data-theme="light"])` in the media query
ensures an OS preference of dark does not override an explicit user choice of light.

**JS behavior** (sketch, ~40 lines):

1. An inline `<script>` in `<head>` (before first paint) reads `localStorage.getItem('theme')` and sets `<html
   data-theme="...">`. This avoids a light-flash on a user who prefers dark. Runs synchronously, ~15 lines minified,
   inlined in the HTML shell.
2. A deferred script attaches click handlers to three buttons (`system` / `light` / `dark`). Clicking writes
   `localStorage` and updates the attribute.
3. The `system` state removes the attribute entirely so the media query re-engages.
4. `matchMedia('(prefers-color-scheme: dark)').addEventListener('change', ...)` updates CSS when the OS changes mode,
   but only when the state is `system`.

Full CSS emitted by `scripts/design/generate-palette.mjs` already includes the three selector cases
(`:root`, `:root:not([data-theme="light"])` inside the media query, `:root[data-theme="dark"]`,
`:root[data-theme="light"]`). Dropping the block into the site's stylesheet is the implementation.

Accessibility: the toggle is a `<button>` group with `aria-pressed`, keyboard-navigable. The preview at
`docs/design/must-should-may-preview.html` demonstrates the toggle pattern at the page-footer level.

### 4.10 Links, anchors, `:target`

- Link color `var(--accent)`. Underline default (`text-decoration-thickness: 1px`, `text-underline-offset: 2px`).
- `:focus-visible` outline 2px solid accent, offset 2px, radius 2px on all interactive elements.
- `:target`: 2-line left edge accent bar via pseudo-element + `background: var(--accent-subtle)` + `--space-3` padding.
  Persists on load.
- Skip-link as first `<body>` child, visible on focus only.
- Smooth-scroll disabled; `prefers-reduced-motion` irrelevant when no motion ships.

### 4.11 Layout

- `<article>` at `max-inline-size: 68ch`, horizontally centered.
- Page padding: `--space-5` mobile, `--space-7` desktop.
- Header: site title left (`agentnative`), minimal links right. **Ships a small `llms.txt` link in the header**
  (resolving open question 5.5 — "ship it, recall if it feels cute"). Subtle wink to the agent audience; a literal
  demonstration of the thesis.
- Footer: version / date / "Created by Brett Davies (davies.fyi)" when davies.fyi is live, "Source on GitHub" otherwise.
- **Mini-TOC ships on desktop ≥ 1100px** (resolving open question 5.2 — "ship it"). Sticky right-rail `<aside>` in a
  2-column grid with the article. Lists the 7 principle anchors. Collapses to an inline `<nav>` at top of article below
  1100px. Always visible in one form or the other.
- `/check` and `/about` use the layout minus the mini-TOC.

### 4.12 Accessibility baseline

- `<main id="main">` wraps article; skip-link targets it.
- Landmarks: `<header>`, `<nav>`, `<main>`, `<aside>`, `<footer>`.
- Strict heading order.
- Native interactive elements only (`<a>`, `<button>`, `<input>`, `<label>`).
- `:focus-visible` everywhere.
- `prefers-reduced-motion` honored.
- Target size ≥ 44×44 CSS pixels on mobile for copy/anchor buttons.
- Contrast verified in `docs/design/color-analysis.md`. Both WCAG 2.1 AA and APCA body-minimum pass in both modes for
  all semantic pairs.
- CSS-only tabs: `<label for>` associations; tab panels are `<section role="tabpanel" aria-labelledby="...">`.
  `axe-core` run in CI at `/plan-eng-review` time confirms.

### 4.13 OG image direction (1200×630 brief)

Specification, not a rendered image. Produced in implementation session via `satori` at build.

- Background: dark-mode palette (`--bg` + subtle `--bg-code` rectangle bottom-right).
- Left-anchored headline, ~72pt, `ui-sans-serif` 700, color `--fg-heading`. Line 1: **"agent-native CLI standard"**.
  Line 2 at ~36pt in `--fg-muted`: **"seven principles for CLIs agents can operate"**.
- Bottom-left: small version/date mark, ~20pt, `--fg-muted`.
- Bottom-right: schematic 7-row code block, mono, ~18pt, showing principle slugs as a stylized `llms.txt` excerpt —
  literal visual proof the site is machine-readable.
- No logo, no illustration, no gradient, no photography.
- File: `og-image.png`, 1200×630, under 200 KB. `og:image:alt` = headline text verbatim.

### 4.14 Schema.org / SEO surface

Schema.org `TechArticle` JSON-LD in `<head>` per page, `isPartOf` pointing to a parent `TechArticle` for the full
spec. Per the agent-native documentation surface pattern. Twitter card `summary_large_image`. Open Graph: `og:title`,
`og:description`, `og:image`, `og:url`, `og:type="article"`, `article:published_time`, `article:modified_time`. Pre-
purchase domain: canonical + og:url use the staging `workers.dev` host until production cut-over; swap via a single
constant in the HTML shell. Documented in `wrangler.toml` per CEO plan (resolving open question 5.6 — "yes").

## 5. Open questions for Brett — status

Revision 1 open questions with current status:

1. **Webfont vs system stack** → RESOLVED as "pragmatic." Ship system-only for v0; webfont upgrade path documented in
   §4.3. Revisit at first visual polish pass.
2. **Mini-TOC on desktop** → RESOLVED: ship it (§4.11).
3. **Warm vs cool neutrals** → RESOLVED via color-psychology research: cool neutrals for spec credibility (§4.1
   narrative); full palette and contrast in `docs/design/color-analysis.md`.
4. **Colorize MUST / SHOULD / MAY** → RESOLVED: ship option 7b (inline keyword color only). The stronger 7b-plus
   side-stripe variant was rejected per impeccable's `<absolute_bans>` (border-left >1px on callouts is the #1 AI-slop
   pattern). Block-level alternatives — leading RFC tag, background-tint fill — deferred to live-site iteration (§4.7).
   Preview at `docs/design/must-should-may-preview.html`.
5. **`llms.txt` link in header** → RESOLVED: ship it, recall if it reads cute (§4.11).
6. **`og:url` pre-domain purchase** → RESOLVED: stage on `workers.dev` host, swap constant at cutover (§4.14).

### New questions emerging from revision 2

- **Theme-toggle UI shape.** §4.9 assumes a three-button group in the header (system / light / dark). Alternative: a
  single `<button>` that cycles, smaller footprint, slightly worse discoverability. Default ships the three-button
  pattern; swap is trivial.
- **MUST/SHOULD/MAY transform scope.** The remark plugin rewrites bare `MUST` / `SHOULD` / `MAY` in certain block
  contexts (§4.7). Question: should it also run inside code comments? Current answer: no — highlighted code should not
  acquire new colors from outside the syntax-highlight theme. Worth re-confirming during implementation.
- **Header `llms.txt` link label.** "llms.txt" as bare text (literal wink) vs. "for agents" (explanatory). Default ships
  bare-text; `title="Machine-readable index for AI agents"` on hover.
- **`X-Robots-Tag: noindex` on `.md` variant.** Mintlify ships this and it is probably correct — we do not want search
  engines to index the markdown (duplicate content). Proposal: ship it. Confirm in `/plan-eng-review`.

## 6. Sources

Research sources cited in this revision:

- WebSearch 2026-04-14: Astro + Starlight markdown endpoints and `.md` content negotiation — surfaced
  `starlight-dot-md`, `starlight-llms-txt`, `starlight-copy-button`, and related March 2026 releases.
- WebSearch 2026-04-14: Mintlify llms.txt / `.md` suffix / content negotiation — confirmed auto-generation, `Accept:
  text/markdown` on same URL, `Link` and `X-Llms-Txt` headers, `X-Robots-Tag: noindex` on markdown variant.
- WebSearch 2026-04-14: Color psychology developer-tool documentation, warm vs cool neutrals — landingpageflow, toptal,
  darosoft, ametra, medium (Qamarjafari 2025), sensationalcolor. Consensus: cool neutrals for developer-facing reference
  material; selective warm accents for MUST/attention callouts.
- In-repo: `docs/solutions/architecture-patterns/agent-native-documentation-surface-2026-04-13.md` — the pattern this
  site instantiates.
- Local clipped references: llmstxt.org, simonwillison.net/2024/Oct/30/jina-meta-prompt, static-web-server.net markdown
  content negotiation, practicaltypography.com (Butterick ten-minutes + summary-of-key-rules), starlight.astro.build
  getting-started.

---

End of DESIGN.md revision 2. Next per session spec: `/plan-eng-review` on AGENT.md + CEO plan + this file, then
`/ce-plan` followed by `/ce-work`.
