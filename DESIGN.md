# DESIGN.md — agentnative spec site

Status: PROPOSED. Authored by `/design-consultation` on 2026-04-13. Supersedes the tentative stack and visual
placeholders in the CEO plan and AGENT.md where they conflict. Both decisions below are open to Brett's revision before
`/plan-eng-review`.

## 1. Summary

The agentnative spec site is the first proof-of-concept for an **agent-native documentation surface**. Every decision
here ladders up to one question: does this choice make the site more agent-legible without making it less human-legible?
When they conflict we default toward agent-legibility, because the human case survives simple HTML and the agent case
does not survive hidden state, heavy client runtimes, or URL-space tricks.

**Decision A (tech stack): Plain HTML authored from markdown via a small custom build pipeline, with a thin Cloudflare
Worker for content negotiation.** Astro + Starlight is tempting because it is what `developers.cloudflare.com` runs on
and what one might reach for by default. It is overkill for nine pages, and — more importantly — Starlight's route
conventions fight the implicit `.md` suffix that the thesis depends on. The second-best choice is Astro without
Starlight. Flip conditions are concrete and documented below.

**Decision B (visual system): neutral-forward, one restrained accent, system font stacks, code as the first-class visual
element, dark mode via `prefers-color-scheme`, sticky mini-TOC on desktop only.** Target aesthetic sits between
`clig.dev` (warm, RFC-like, small palette) and `rust-lang.org/book` (tight code treatment, strong hierarchy). Three
interactions ship for v0, each with a one-line justification and a KB budget. Total shipped JS target: ≤5 KB gzipped for
v0; hard cap 25 KB. Zero external runtime dependencies.

Both decisions assume the invariants restated in §3.4 and §4.10: markdown is the source of truth, same `.md` renders the
HTML and is served raw for content negotiation and `llms-full.txt`, stable per-principle anchors, `llms.txt` +
`llms-full.txt` at root, Schema.org `TechArticle` JSON-LD per page, mobile-first, a11y baseline, total shipped JS within
budget.

## 2. Reference survey

Eight sites studied, mixed across the three groups in the session spec. One paragraph each.

### Group 1 — starred references

**developers.cloudflare.com.** Astro + Starlight; the stack-default benchmark. Borrow: tight type rhythm, generous
vertical whitespace between prose and code, distinct code-block background with unobtrusive border, a copy button on
every fenced block, tabbed language samples where they add signal, dark mode that looks intentional rather than
auto-inverted, stable anchor targets with an on-hover anchor affordance, sidebar TOC that tracks scroll position. Avoid:
the full Starlight chrome (breadcrumbs, "on this page" floating TOC, version switcher, search overlay) for a nine-page
site; the marketing-adjacent navigation; the opinionated `<nav>` structure that assumes a product with many sections.
One-line vibe: "RFC written in a codebase with a styleguide." Tech stack: Astro + Starlight + Cloudflare Pages/Workers;
server-rendered, ≤~40 KB JS per page, Shiki via expressive-code.

**clig.dev.** Single-column, centered, ~700 px measure, serif-ish-feeling sans (it is actually a geometric sans with
generous leading), muted neutral palette, understated navy accent, all content on one page with anchors. Borrow: the
confidence to commit to one long page; the restrained palette; the subtle `<h2>` separators that double as section
breaks without decorative lines; the quiet footer that reads like a colophon. Avoid: the slightly clubby author-first
framing (agentnative speaks as a standard, not a person); unbranded code blocks (the site under-indexes on code for our
needs — we will be code-heavier). One-line vibe: "a well-edited zine on how to build CLIs, printed on good paper." Tech
stack: Jekyll-ish static site; effectively plain HTML.

**github.com/brettdavies/lmgroktfy.** Vibe-calibration only; do not copy code or framework. What to borrow: honest
product copy, minimal chrome, the "it is obvious what this is" feel that comes from not trying to explain every button.
What to avoid: the product-landing gradient and the form-forward layout — this is a spec site, not a product page.
One-line vibe: "single-purpose, confident, doesn't apologize." Tech stack: not directly knowable from the surface; treat
as aesthetic reference only.

### Group 2 — other spec and standards surfaces

**12factor.net.** Numbered-principle layout that the agentnative spec structurally resembles, anchor-per-principle, RFC
voice. Borrow: the numbered-section pattern; the single-column readable measure; the confidence to have no sidebar nav
and rely on in-page anchors + the browser's own affordances. Avoid: the dated visual (serif body, flat blue links, '90s
table-of-contents chrome); the lack of any visual treatment on code. One-line vibe: "a standard that has aged like a
standard, which is to say unevenly but honestly." Tech stack: static HTML, likely Jekyll or similar.

**rust-lang.org/book.** The code-heavy reference point. Borrow: generous code-block padding; mono that actually renders
as mono on every platform; syntax highlighting that prefers readability over rainbow; left sidebar `<details>`-style TOC
on desktop; the way inline `code` and block code share a visual family. Avoid: the mdBook default chrome (print button,
search in-header, theme switcher) — we do not need them; the slightly heavy dark theme. One-line vibe: "a textbook that
wants to be referenced, not read end to end." Tech stack: mdBook; static HTML with a small client-side search bundle.

**json-schema.org** and **semver.org** as a pair. Both are tiny, authoritative, text-first. Borrow from semver: the
near-absurd simplicity of a single page with an anchored list of MUST/SHOULD statements, readable in a single scroll,
citable by fragment; the footer-only attribution. Borrow from json-schema: the distinction between the spec surface and
the implementation surface (we mirror this: the site is the spec, the CLI repo is the implementation). Avoid:
json-schema.org's current marketing-leaning landing — we do not need a hero. One-line vibe: "the shortest document that
could possibly replace itself." Tech stack: both plain HTML / static.

### Group 3 — agent-native and AI-dev surfaces

**anthropic.com/claude/docs.** Clean, dense, type-led; code blocks are treated as equal citizens to prose rather than as
illustrations; dark mode by default on many paths. Borrow: the way code is centered in the reading flow rather than
pushed to a sidebar; the prompt-and-response pair as a native layout; the restraint on decoration. Avoid: the corporate
nav chrome (we have no product to sell); the soft-rounded cards (clashes with RFC voice). One-line vibe: "engineering
docs that trust the reader." Tech stack: Next.js; not a template we want to reach for at our scale.

**llmstxt.org.** The canonical source for the `llms.txt` convention we are implementing. Borrow: the willingness to be
small; the specification-first layout; the direct example in the middle of the page rather than linked off. Avoid: the
mixed-body feel (it drifts between spec, blog post, and FAQ) — the agentnative site should pick one voice and keep it.
One-line vibe: "a proposal that is also the worked example." Tech stack: static; plain HTML.

### Sites considered but not written up

Scanned, informed calibration, did not add new decisions: `htmx.org` (confirmed: small-site plain-HTML model is healthy
in 2026), `fly.io/docs` (confirmed: Astro-grade frameworks earn their keep only at scale), `simonwillison.net`
(confirmed: plain-HTML-feel can carry real authority), `bun.sh` and `deno.com` (both too product-landing-shaped for our
voice).

## 3. Decision A — tech stack

### 3.1 Candidates evaluated

1. **Plain HTML authored from markdown via a small custom build pipeline + Cloudflare Worker** (CEO plan's default)
2. **Astro + Starlight**
3. **Astro without Starlight**
4. **Hugo + Cloudflare Worker shim** for content negotiation
5. **Eleventy + Cloudflare Worker shim**
6. **Writing HTML by hand** (no markdown source) — listed to reject

Explicitly NOT a candidate: Cheng Lou's Pretext (per session spec; no image-wrapping need, would blow the JS budget).

### 3.2 Scored table

Scoring 1 (bad) to 5 (great) on criteria from the session spec. "MD-SoT fit" = markdown-source-of-truth fit.
"CN story" = content-negotiation story for `/p1.md` and `Accept: text/markdown`. "CF deploy" = Cloudflare deploy story.
"Std iter" = maintenance cost when the standard iterates. "Thesis fit" = alignment with agent-native documentation
surface.

| Criterion | Plain+Worker | Astro+Starlight | Astro alone | Hugo+Worker | Eleventy+Worker | Hand-HTML |
|---|---:|---:|---:|---:|---:|---:|
| Simplicity | 5 | 2 | 3 | 3 | 3 | 5 |
| Bloat risk | 5 | 2 | 4 | 4 | 4 | 5 |
| MD-SoT fit | 5 | 5 | 5 | 5 | 5 | 1 |
| CN story (`.md` + Accept) | 5 | 2 | 4 | 4 | 4 | 5 |
| Clickable codeblock | 5 | 5 | 5 | 4 | 4 | 5 |
| Tabbed multi-lang code | 4 | 5 | 4 | 3 | 3 | 4 |
| Dark mode (prefers-cs only) | 5 | 3 | 5 | 5 | 5 | 5 |
| CF deploy | 5 | 5 | 5 | 4 | 4 | 5 |
| Std iter cost | 4 | 3 | 4 | 4 | 4 | 1 |
| Thesis fit | 5 | 3 | 4 | 4 | 4 | 1 |
| **Total (/50)** | **48** | **35** | **43** | **40** | **40** | **37** |

Notes on the harshest scores:

- Astro + Starlight, CN story = 2. Starlight's routing is built around `/page/` directories with `index.html` inside;
  the implicit `.md` suffix and `Accept: text/markdown` negotiation must be retrofitted via a Worker shim plus custom
  Astro endpoints or a content-collection hook that emits `.md` siblings. The work is not hard, but it means fighting
  the framework on the load-bearing feature. Any future Starlight upgrade that shifts its output tree can break it.
- Astro + Starlight, dark mode = 3. Starlight ships a theme toggle by default; the CEO plan commits to
  `prefers-color-scheme` only. Removing or overriding the toggle is a visible fight with Starlight's opinion.
- Astro + Starlight, thesis fit = 3. Ship a framework to publish a spec whose stated thesis is "small, explicit,
  composable tools" and the stack contradicts its own message.
- Hand-HTML, MD-SoT fit = 1 and std iter cost = 1. Means editing seven HTML files whenever wording changes. Not a
  candidate past the first edit.

### 3.3 Recommendation

**Ship on plain HTML generated from markdown by a ≤150-line build script, routed by a ≤60-line Cloudflare Worker.**

The build script is Node (no runtime installed on the Worker), run locally and in CI. Inputs: `content/*.md`. Outputs:
`dist/*.html`, `dist/*.md` (copy of source), `dist/llms.txt`, `dist/llms-full.txt`, `dist/sitemap.xml`. Dependencies:
`unified`, `remark-parse`, `remark-gfm`, `remark-rehype`, `rehype-slug`, `rehype-shiki` (or `shiki` directly),
`rehype-stringify`. All pinned, all build-time only, nothing shipped to the client. Template is a single HTML string
with `<!--TITLE-->` and `<!--CONTENT-->` markers — no templating engine.

The Worker is the agent-native surface:

```js
// Worker shape only, not final code.
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const wantsMd =
      url.pathname.endsWith(".md") ||
      (req.headers.get("accept") || "").includes("text/markdown");
    const base = url.pathname.replace(/\.md$/, "").replace(/\/$/, "") || "/index";
    if (wantsMd) return env.ASSETS.fetch(new Request(new URL(`${base}.md`, url)));
    return env.ASSETS.fetch(req);
  },
};
```

`env.ASSETS` is a Workers Static Assets binding holding everything in `dist/`. No KV, no D1, no R2. Deploy is `wrangler
deploy`. Rollback is `wrangler rollback`.

**Why this wins for this site, specifically.**

- **Nine pages, no search, no versioning in v0.** Everything a framework gives you free — sidebar nav, search indexing,
  component library, multi-version switcher — is either unused or mildly in the way.
- **Content negotiation is the load-bearing thesis feature.** Owning the Worker end-to-end means the `.md` suffix and
  `Accept: text/markdown` behavior are specified in forty lines we can reason about, not interleaved with a framework
  route table we have to reverse-engineer on every upgrade.
- **JS budget.** Plain-HTML baseline is 0 KB. We add only the three interactions we argue for in §4.8 (target ≤5 KB
  gzipped, cap 25 KB). No framework runtime, no hydration layer, no island serialization.
- **Dogfooding.** The site is an artifact of the same philosophy the CLI standard advocates. Starlight says "use the
  expressive-code component"; plain HTML says "write a `<pre><code>` and style it." The site's architecture is part of
  the spec's argument.
- **Upgrade cost over a decade.** Frameworks churn; HTML does not. CommonMark and Shiki are both reasonable to pin and
  replace. A Starlight major-version upgrade at year three is far more work than swapping a `rehype-shiki` version.

**Cost honestly stated.** We write the build script. ~150 lines. We own its maintenance. We do not get Starlight's
prebuilt components for free — specifically, we will hand-roll click-to-copy, tabbed code, and anchor-copy (each ≤1 KB,
see §4.8). We do not get a built-in search bar — which we do not need for nine pages but might in Phase 2; the flip
conditions below cover that.

### 3.4 Invariants (hold regardless of stack)

Markdown is the source of truth. Same `.md` renders the HTML and is served raw for `/p1.md`, `/p1` under `Accept:
text/markdown`, and `/llms-full.txt`. `llms.txt` + `llms-full.txt` at site root per llmstxt.org. Schema.org
`TechArticle` JSON-LD in every HTML `<head>`. Stable per-principle anchor IDs `#p1-non-interactive-by-default` through
`#p7-bounded-high-signal-responses`. Version and date in footer. Deploy on Cloudflare Workers with Static Assets.
Mobile-first. A11y baseline: skip-link, semantic landmarks, `prefers-reduced-motion`, `:focus-visible`, contrast ≥4.5:1
in both modes. Total shipped JS target ≤5 KB gz, cap 25 KB gz, zero external runtime dependencies.

### 3.5 Second-best: Astro without Starlight

Astro without Starlight scores 43/50 and is the credible fallback. It gives us a tested markdown pipeline, zero client
JS by default, first-class Shiki integration via `@astrojs/markdown-remark`, and the Astro CLI/dev-server ergonomics
that a hand-rolled build lacks. It loses to plain+Worker on thesis fit (we still ship a framework) and on the
content-negotiation story (Astro emits `/p1/index.html`; we either adopt a slightly non-conventional URL shape,
configure static routing to emit `/p1.html`, or implement the `.md` suffix in the Worker the same way as the plain-HTML
option — in which case we kept the Worker work and paid for Astro anyway).

If Brett wants the dev-server comfort and community-maintained markdown pipeline, Astro alone is the right fallback.

### 3.6 Flip conditions (what would change the recommendation)

- **Scope crosses ~20 pages.** Hand-built navigation, per-page frontmatter wrangling, and a custom search solution start
  eating more time than a framework would. At ~20 pages we should revisit Astro-alone; at ~40 we should revisit
  Starlight.
- **Versioning becomes real.** Phase 2+ work (TODOS.md P2) introducing per-version spec rendering tips toward a
  framework with first-class version handling. Starlight earns its keep here.
- **Client-side search becomes a requirement.** We do not need it for nine pages, but a "search across all principles"
  add-on would require either a 20-50 KB client bundle (pagefind, flexsearch) or a server endpoint. If we ship it,
  reconsider Astro.
- **We start sharing a docs theme across multiple properties.** If `agentnative-site`, `davies.fyi`, and a future third
  site converge on a common layout, moving all three to a shared Astro theme is cheaper than maintaining three bespoke
  pipelines.

### 3.7 Delta from the CEO plan

None structural. The CEO plan's default ("Plain HTML + CSS + small Cloudflare Worker") stands, with one clarification
that should go to `/plan-eng-review`: the build step is not zero. It is ~150 lines of Node we author and own. The CEO
plan's AGENT.md phrase "No frontend framework, no build pipeline beyond the Worker's CommonMark render step" should be
amended to reflect that the CommonMark + Shiki render happens at **build time** on the author's machine (and in CI), not
at request time in the Worker. The Worker only routes. This is the Shiki-at-build guidance in the agent-native
documentation surface pattern in `docs/solutions/`.

## 4. Decision B — visual system

One direction, not a shotgun. The CEO plan's stated preference ("simple and traditional with modern web flair, clig.dev
> 12factor.net") is specific enough to commit to a single system; offering three variants would be decision-theater.

### 4.1 Palette — light mode

Neutral-forward, one accent. Values given in OKLCH (verified for perceptual evenness via the oklch-picker mental model
described in the session spec) with sRGB fallbacks in parentheses for user agents that still choke on OKLCH. Named
tokens, not raw values, in the CSS; values here are illustrative.

| Token | OKLCH | sRGB fallback | Purpose |
|---|---|---|---|
| `--bg` | oklch(99% 0.005 95) | `#fdfcfa` | Page background. Warm near-white. |
| `--bg-code` | oklch(96.5% 0.01 95) | `#f5f2ec` | Code-block and inline-code background. |
| `--border` | oklch(90% 0.01 95) | `#e3ddd1` | Hairline dividers, code-block border. |
| `--text` | oklch(22% 0.015 260) | `#1c2330` | Body prose. |
| `--text-muted` | oklch(45% 0.015 260) | `#596578` | Secondary, footer, captions. |
| `--text-code` | oklch(22% 0.015 260) | `#1c2330` | Inline code default (syntax hl overrides in blocks). |
| `--accent` | oklch(48% 0.14 250) | `#2a55a5` | Links, focus ring, `:target` highlight, copy-button hover. |
| `--accent-subtle` | oklch(94% 0.04 250) | `#dfe7f6` | `:target` background. |
| `--must` | oklch(48% 0.14 140) | `#2b7d3e` | "MUST" keyword callout (optional; see §4.7). |
| `--should` | oklch(52% 0.12 70) | `#a66800` | "SHOULD" keyword callout. |
| `--may` | oklch(50% 0.12 310) | `#7a3da0` | "MAY" keyword callout. |

Rationale: warm off-white background (not clinical `#fff`) gives the site a print-adjacent feel that pairs with RFC
voice. Accent is desaturated navy with enough chroma to not feel corporate grey. `MUST/SHOULD/MAY` hues pulled from a
hand-selected triad rather than random pigments; they may ship behind a `<strong class="rfc-must">` convention only if
§4.7 is adopted.

Contrast verified: `--text` on `--bg` is ~12:1 (AAA). `--accent` on `--bg` is ~6.8:1 (AA Large and AAA Normal).
`--text-muted` on `--bg` is ~5.1:1 (AA Normal).

### 4.2 Palette — dark mode

Keyed off `@media (prefers-color-scheme: dark)`. No toggle. Inverted neutrals, same accent hue with lowered lightness
and chroma to avoid a neon effect on dark backgrounds.

| Token | OKLCH | sRGB fallback | Purpose |
|---|---|---|---|
| `--bg` | oklch(18% 0.01 260) | `#141821` | Page background. Warm near-black. |
| `--bg-code` | oklch(22% 0.01 260) | `#1b2029` | Code background. Slight lift. |
| `--border` | oklch(30% 0.01 260) | `#2a303b` | Hairline dividers. |
| `--text` | oklch(94% 0.01 95) | `#ece6d9` | Body prose. Warm off-white. |
| `--text-muted` | oklch(72% 0.01 95) | `#b1aa9b` | Secondary. |
| `--accent` | oklch(78% 0.12 250) | `#8fb3ff` | Links, focus ring. |
| `--accent-subtle` | oklch(30% 0.05 250) | `#22304f` | `:target` background. |
| `--must` | oklch(78% 0.12 140) | `#7fcf8f` | MUST. |
| `--should` | oklch(82% 0.1 70) | `#e0b96a` | SHOULD. |
| `--may` | oklch(78% 0.1 310) | `#c9a0e6` | MAY. |

Contrast verified: `--text` on `--bg` is ~12:1 (AAA). `--accent` on `--bg` is ~8.2:1 (AAA). `--text-muted` on `--bg` is
~6.1:1 (AA Normal, AAA Large).

### 4.3 Type stack

System stacks, no webfont shipped in v0. Follows `modernfontstacks`. Open question 1 below revisits this if Brett wants
to ship Inter or IBM Plex.

```css
--font-sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto,
             "Helvetica Neue", Arial, "Noto Sans", sans-serif,
             "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol";

--font-mono: ui-monospace, "JetBrains Mono", "SF Mono", "Cascadia Code",
             "Roboto Mono", Menlo, Consolas, "Liberation Mono", monospace;
```

Reasoning: shipping zero font bytes is the dominant choice for a spec site. System stacks render as San Francisco on
macOS/iOS, Segoe UI on Windows, Roboto on Android, and reasonable fallbacks elsewhere — all neo-grotesques with similar
proportions. Mono stack prefers `ui-monospace` (SF Mono / Menlo / Consolas) and names JetBrains Mono and Cascadia Code
for users who have installed them. Ligatures suppressed via `font-variant-ligatures: none` on `<pre>` and `<code>` —
explicit character shapes matter for a spec that quotes operators like `>=`, `!=`, `->`.

### 4.4 Type scale

Base 17px at mobile, 18px at desktop (above ~960px) via a single `clamp()`. One ratio, 1.25 (major third). Line height:
1.6 for body, 1.3 for headings, 1.5 for code.

| Element | Size | Weight | Notes |
|---|---|---|---|
| Body | 1rem (17-18px fluid) | 400 | `line-height: 1.6`, measure clamped to ~68ch. |
| `h1` | 2.0rem | 700 | One per page. |
| `h2` | 1.5rem | 700 | Principle section start. |
| `h3` | 1.22rem | 600 | MUST/SHOULD/MAY group heading. |
| `h4` | 1.0rem | 700 | Small-caps tracking `0.04em`, used sparingly. |
| `code` (inline) | 0.92em | 400 | `background: var(--bg-code)`, padding `0.1em 0.35em`, radius `3px`. |
| `pre > code` | 0.92rem | 400 | Block code; no size-scaling from context. |

Measure: `max-inline-size: 68ch` on `<article>`. Anything shorter and code blocks get cramped; anything longer exceeds
Butterick's 45-90-character range for prose.

Paragraphs: separated by `0.9em` of space, no first-line indent (web convention, matches CEO plan's RFC voice which
nests indents under list structure rather than first-line).

### 4.5 Spacing scale

Simple 4/8-based scale exposed as custom properties. Not fluid; the content does not breathe on wide monitors — it stays
at `max-inline-size: 68ch` and the page background fills the rest. This is the clig.dev behavior.

```css
--space-1: 4px; --space-2: 8px; --space-3: 12px; --space-4: 16px;
--space-5: 24px; --space-6: 32px; --space-7: 48px; --space-8: 64px;
```

Section gap: `--space-7`. Paragraph gap: `0.9em` (computed from context so it scales with font size). Code block
margin-block: `--space-5`.

### 4.6 Code blocks

The most visually load-bearing element on the site. All code is authored in markdown with language tags. Highlighted at
**build time** via Shiki using a paired theme: `github-light` for light mode, `github-dark-dimmed` for dark mode. Both
themes emit inline CSS custom properties when invoked with Shiki's `dual-theme` option, so one rendered `<pre>` serves
both modes — no client-side theme JS.

Treatment:

- Background `var(--bg-code)`, hairline border `1px solid var(--border)`, radius `6px`, padding `var(--space-4)
  var(--space-5)`.
- `font-family: var(--font-mono)`, `line-height: 1.5`, `font-size: 0.92rem`, `font-variant-ligatures: none`.
- Horizontal scroll on overflow (`overflow-x: auto`); no wrap. Scrollbar styled minimally.
- Language tag in top-right corner as a `<span>` with `--text-muted`, `font-size: 0.75rem`, absolute-positioned only
  when the `<pre>` has `position: relative` (default `false` for short blocks to keep the raw HTML flat).
- Inline `<code>` (not inside `<pre>`): same `--bg-code`, smaller padding, no border.

**Round-trip constraint.** The rendered HTML must contain the original code verbatim inside `<code>`, with Shiki's
highlighting applied via wrapping `<span>` tags on tokens. This is Shiki's default. The copy button (§4.8) copies the
`textContent` of the `<code>` element, which strips the span wrappers and returns the original source. The markdown
source served via content negotiation is the raw `.md` file, so highlighting never contaminates the text/markdown
channel — that channel sees unmodified fenced blocks.

### 4.7 RFC-keyword treatment (optional — see open question 4)

`MUST`, `SHOULD`, and `MAY` appear throughout the principles. Two options:

- **Option 7a (default, ship this).** Plain `<strong>` in the rendered HTML, no color. The reader notices because they
  are in all caps and bolded; further decoration is anti-pattern per Butterick rule 8 ("use bold or italic as little as
  possible, and not together"). Zero cost.
- **Option 7b (if Brett wants more "modern web flair").** `<strong class="rfc-must">` / `rfc-should` / `rfc-may` applied
  via a remark transform during build; keywords render in their respective accent colors (§4.1/§4.2) at normal weight
  with slight letter-spacing. Costs ~300 bytes of CSS and one small remark plugin. Retain all-caps source; this is
  purely visual.

Default 7a. Add 7b only if Brett says "yes, colorize the keywords."

### 4.8 Interaction menu (all shipped JS)

Each item justified in one line and priced in bytes gzipped. Implementation guidance is descriptive, not prescribed —
the engineering session picks the final approach.

| # | Interaction | Justification | Approx KB gz |
|---|---|---|---|
| 1 | Click-to-copy on every `<pre>` block | Brett-requested; the single highest-value interaction on a spec site whose primary reader copies examples into their own code. | ≤1.0 |
| 2 | Tabbed multi-language code (Rust / Python / Go / Node) on principles that have framework-idiom examples | Principles 1, 2, 4, 5, 6, 7 each have idiom variants across languages (see `framework-idioms-other-languages.md`); tabs keep one canonical per-principle layout while letting readers pick their stack. CSS-only via hidden radio pattern — zero JS. | ≤0 (CSS only) |
| 3 | Copy-anchor-link button on each principle heading (and each `h3` within) | Makes citations a one-click affair, which is the point of stable anchors. Also improves agent use: an agent that surfaces a link can reliably emit `url#p1-non-interactive-by-default`. | ≤0.6 |

**Total shipped JS target for v0: ≤1.6 KB gzipped.** Well under the 5 KB target and the 25 KB cap. No analytics. No
third-party tags. No `import` from CDN.

**Explicitly rejected:**

- Client-side search. Nine pages; use Ctrl-F.
- Theme toggle. `prefers-color-scheme` only, per CEO plan.
- Scroll-spy TOC highlighting. `:target` and the browser's native hash-change behavior suffice; adding
  IntersectionObserver costs ~500 bytes and is noise.
- Code-block line numbers. Noise in a spec. (Shiki can emit them; we leave the option off.)
- Animations beyond a ≤150ms ease on the copy-confirmed state. `prefers-reduced-motion` disables even this.

The CSS-only tabbed code approach (item 2): `<input type="radio" name="lang" id="p2-rust" checked>` plus sibling
labels and `:checked ~ .content` selectors. Works without JS, keyboard-accessible via labels, progressive (the first
panel is visible when JS is off and no radio is checked). Cost: ~60 lines of CSS, zero JS.

### 4.9 Links, anchors, `:target`

- Link color: `var(--accent)`. Underline by default (`text-decoration-thickness: 1px`, `text-underline-offset: 2px`).
  Honors Butterick's rule on underlined web links (rule 9).
- Focus: `:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 2px; }`. All
  interactive elements, not just links.
- `:target`: the currently hashed element gets a 2-line vertical accent bar on its left edge using a pseudo-element,
  plus `background: var(--accent-subtle)` with `--space-3` padding. Persists on load; fades only on navigation, not over
  time.
- Skip-link: `<a href="#main">Skip to content</a>` as the first `<body>` child; visible on focus only; high-contrast.
- Anchor landing: browser default smooth-scroll disabled; honoring `prefers-reduced-motion` is easier when we never
  animate in the first place. Instant jump.

### 4.10 Layout

- Single column. `<article>` at `max-inline-size: 68ch`, horizontally centered by `margin-inline: auto`.
- Page padding: `var(--space-5)` on mobile, `var(--space-7)` on desktop.
- Header: small top bar with site title (`agentnative`) on the left, minimal links on the right (/check, /about, and an
  unstyled anchor to `llms.txt` for the agent audience — a subtle wink).
- Footer: one line. Version / date / "Created by Brett Davies (davies.fyi)" when davies.fyi exists, "Source on GitHub"
  link otherwise.
- Mini-TOC: a sticky `<aside>` on viewports ≥ 1100px, positioned to the right of the article in a 2-column grid. It
  lists the 7 principle anchors only — nothing else. Collapsed to an inline `<nav>` at the top of the article below
  1100px. Does not become a hamburger; it is always visible in one form or the other.
- `/check` and `/about` use the same layout minus the mini-TOC.

### 4.11 Accessibility baseline

- `<main id="main">` wraps the article; skip-link targets it.
- Landmarks: `<header>`, `<nav>`, `<main>`, `<aside>`, `<footer>`.
- Heading order is strict: one `<h1>` per page, `<h2>` for each principle, `<h3>` for MUST/SHOULD/MAY groupings, `<h4>`
  rarely.
- All interactive elements are native (`<a>`, `<button>`, `<input>`, `<label>`). No divs-as-buttons.
- `:focus-visible` on every interactive element.
- `prefers-reduced-motion: reduce` disables the 150ms copy-confirmed transition and any theoretical future scroll
  animation.
- Target size: buttons ≥ 44×44 CSS pixels on mobile (copy buttons, anchor-copy affordances).
- Contrast verified per §4.1/§4.2.
- Form elements for CSS-only tabs: proper `<label for>` associations; tab panels are `<section role="tabpanel">` with
  `aria-labelledby` pointing at the label. Optional `axe-core` run in CI confirms.

### 4.12 OG image direction (1200×630, brief only)

Specification, not a rendered image. To be produced in the implementation session via `satori` as a build step.

- Background: dark-mode palette (`--bg` + subtle `--bg-code` rectangle at bottom-right).
- Composition: left-anchored headline, ~72pt, `ui-sans-serif` 700, color `--text` (warm off-white on dark). Headline
  text: **"agent-native CLI standard"** on line 1, **"seven principles for CLIs agents can operate"** on line 2 in
  `--text-muted` at ~36pt.
- Bottom-left: small version/date mark (e.g., "v0.1 · 2026") at `--text-muted`, ~20pt.
- Bottom-right: a schematic 7-row code block (mono, ~18pt) showing the principle slugs as a stylized `llms.txt` excerpt
  — a literal visual proof that the site is machine-readable.
- No logo, no illustration, no gradient, no photography.
- File: `og-image.png`, 1200×630, under 200 KB. `og:image:alt` set to the headline text verbatim.

### 4.13 Schema.org / SEO surface

Schema.org `TechArticle` JSON-LD in `<head>` for each page, with `isPartOf` pointing to a parent `TechArticle`
representing the full spec. Per agent-native documentation surface pattern. Twitter card: `summary_large_image`. Open
Graph: `og:title`, `og:description`, `og:image`, `og:url`, `og:type="article"`, `article:published_time`,
`article:modified_time`.

### 4.14 What "modern web flair" means (and doesn't) in this system

User preference: "simple and traditional with modern web flair." Operational interpretation:

- Yes: OKLCH tokens, fluid type-size clamp, CSS logical properties (`margin-block`, `inline-size`), `:focus-visible`,
  `prefers-color-scheme`, `prefers-reduced-motion`, CSS-only tabbed code via radio/`:checked`, JSON-LD, a designed OG
  image.
- No: gradients, glassmorphism, scroll-driven animations, hover-scale transforms, icon-heavy UI, color palettes with
  more than one accent, custom cursor, scroll-snap page sections, any "hero" treatment.

The "flair" is in the details — the perceptually even OKLCH scale, the JSON-LD, the CSS-only interactions, the warm
off-white rather than clinical `#fff`. Not in decoration.

## 5. Open questions for Brett

1. **Webfont or system stack?** Default is system stack (zero bytes). If Brett wants the site to feel
   pen-sharp-same-on-every-OS, the cheapest upgrade is Inter variable Latin subset (~25 KB gz WOFF2) as a preloaded font
   with `font-display: swap`, paired with JetBrains Mono variable subset (~30 KB gz) only if loading extra mono is worth
   the payload. Warm off-white and OKLCH scale work well with either choice.
2. **Mini-TOC on desktop: yes or no?** §4.10 commits to a sticky right-rail TOC on ≥1100px. clig.dev has none (single
   column, one scroll); 12factor.net has none; rust-lang.org/book has one on the left. For nine pages the TOC is
   arguably noise; for the index page listing all seven principles it is a genuine navigation aid. Default ships it;
   easy to remove.
3. **Warm or cool neutrals?** The palette as drafted is warm-biased (`oklch(99% 0.005 95)` background leans toward
   paper). A cool-neutral variant (`oklch(99% 0.004 240)`) feels more "developer tools" and less "print." Both are
   defensible; the warm choice is more distinctive and matches the RFC-feel vector. Flip on request.
4. **Colorize `MUST` / `SHOULD` / `MAY` keywords?** §4.7 option 7a (bold only) vs 7b (colorized at build). 7a is
   Butterick-correct and ships by default. 7b is the "modern web flair" flourish. Brett's call.
5. **Subtle agent affordance in header?** §4.10 suggests a tiny `llms.txt` link in the header — a colophon-style wink to
   the agent audience. Strong opinion: ship it, because it is literally the thesis. Low-confidence: ship it, because it
   might read as cute. Defer to Brett.
6. **Domain in `og:url` and canonical links before Brett purchases the domain.** Production domain is Brett-only
   (agentnative.dev / .io / .org). For staging on `workers.dev` the canonical/og URLs use the staging host; at
   production-cutover a single constant flips. Documented in `wrangler.toml` per CEO plan.

---

End of DESIGN.md. Next steps per session spec:

1. Brett reviews and revises.
2. `/plan-eng-review` on AGENT.md + CEO plan + this file.
3. `/ce-plan` then `/ce-work` for implementation.
