---
title: "feat: Emit YAML frontmatter into dist markdown twins"
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
execution: code
type: feat
created: 2026-08-03
product_contract_source: ce-plan-bootstrap
plan_depth: standard
related_plans:
  - docs/plans/2026-08-03-003-feat-web-audit-frontmatter-check-plan.md
---

# feat: Emit YAML frontmatter into dist markdown twins

## Summary

Prepend a small YAML frontmatter block (`title`, `description`, canonical `url`) to every authored content markdown twin
the build emits (`dist/index.md`, `dist/p1..p8.md`, and the `07-subpages` twins). The frontmatter is derived from each
page's existing extracted title/description plus its canonical URL. Source `content/**` files, the rendered HTML pages,
`llms.txt`, and `llms-full.txt` are all left byte-unaffected. This gives agents fetching a `.md` twin the same clean,
self-describing metadata that context.dev prepends to its agent-markdown, without disturbing any human-facing surface.

This is part (a) of Feature 2. Part (b) (a MAY web-audit check that rewards other sites for the same practice) is a
separate, independently shippable plan: `docs/plans/2026-08-03-003-feat-web-audit-frontmatter-check-plan.md`. Neither
blocks the other; landing this plan first lets anc.dev's own `/` twin pass part (b)'s check.

---

## Problem Frame

Every page on this site is served in two forms: the HTML render and a markdown twin (`Accept: text/markdown`, or the
explicit `.md` URL). The twins today carry **no** structured metadata: the homepage twin opens straight at `# The
agent-native standard` with no title/description/url header. An agent that fetches `/index.md` gets prose but no
machine-clean statement of what the page is, what it covers, or its canonical location. It must infer all three from the
body.

context.dev, whose approach the user endorsed, prepends `title` / `description` / `url` YAML frontmatter to its
agent-markdown so ingestion is clean and canonical. This site already computes exactly those values at build time for
the HTML `<head>` (`<title>`, `<meta name="description">`, `<link rel="canonical">`, and JSON-LD). The values exist;
they are simply not surfaced in the twins.

The constraint is strict: the HTML render **MUST** be unaffected (it reads from source, not the twin), and the change
must not leak the frontmatter into the concatenated `llms-full.txt` corpus, whose A5 per-section header already carries
title + source + canonical-markdown and whose inter-section `---` delimiters would collide with YAML `---` fences.

---

## Requirements

- **R1** Every authored content twin the build emits carries a leading YAML frontmatter block with, at minimum, `title`,
  `description`, and canonical `url`. Scope: `dist/index.md`, `dist/p1.md`..`dist/p8.md`, and the twelve `07-subpages`
  twins.
- **R2** Frontmatter values derive from each page's **existing** extracted metadata: `title` from `extractTitle`,
  `description` from `extractDescription`, `url` from `resolveBaseUrl() + canonicalPath`. No new authored metadata in
  `content/**`.
- **R3** The frontmatter block is valid, parseable YAML: values with colons, quotes, or the truncation ellipsis
  (`extractDescription` caps at 180 chars with a trailing `…`) serialize correctly.
- **R4** The HTML pages are byte-unaffected: no frontmatter fence or `url:` line appears in any `dist/*.html`.
- **R5** `content/**` source files are byte-unaffected (the render pipeline already asserts source is not mutated).
- **R6** `llms.txt` (the index) is unchanged. `llms-full.txt` embeds **no** per-section YAML frontmatter (it keeps using
  source bodies; the A5 header already carries the equivalent metadata).
- **R7** The homepage-twin silence invariant still holds: the frontmatter introduces none of the forbidden live-scoring
  tokens.
- **R8** The principle-twin byte-equivalence invariant is preserved in strengthened form: `dist/p<n>.md` equals
  `frontmatter(p) + absolutifyMarkdownLinks(source)` exactly, so a copy-edit that drifts the body still fails the build.
- **R9** The `url` value tracks the same base as the twin's absolutified links and the HTML canonical (both via
  `resolveBaseUrl`), so staging/local builds emit staging/local URLs, not hardcoded production ones.

---

## Key Technical Decisions

### KTD1. Frontmatter is emitted only into the standalone dist twins, never source and never HTML

The twin is the only surface that lacks page metadata and the only one an agent fetches raw. Source stays authored-bytes
(the extractors and HTML render read source; mutating it would ripple into the render). HTML already carries the
metadata in `<head>` + JSON-LD. So the frontmatter is a twin-emit-time prefix, added where the twin string is assembled,
and nowhere else. This keeps the HTML path provably unaffected (it never reads the twin) and isolates the change to
three emit sites.

### KTD2. One shared `composeTwin` helper builds every twin string; emitters and the invariant both call it

Rather than concatenating frontmatter at three call sites (and re-deriving it a fourth time in the invariant check),
introduce a single pure helper in `src/build/util.mjs`:

- `renderFrontmatter({ title, description, url })` -> the `---\n<yaml>---\n\n` block, serialized with `js-yaml`'s `dump`
  (already a build dependency; used by `13-web-audit-registry.mjs`). `dump` handles all escaping (colons, quotes, the
  `…` ellipsis) so R3 is satisfied without hand-rolled quoting.
- `composeTwin({ title, description, canonicalPath }, bodyMarkdown, baseUrl?)` -> `renderFrontmatter({ title,
  description, url })` + `absolutifyMarkdownLinks(bodyMarkdown, baseUrl)`, where `url` is derived internally as
  `resolveBaseUrl(baseUrl) + canonicalPath`. Taking the site-relative `canonicalPath` (the same value callers pass to
  `emitShell`) and deriving the absolute `url` inside the helper keeps the frontmatter `url` and the absolutified body
  links on the same base by construction, so no caller can pair a production `url` with staging links. The `description`
  is body prose (`extractDescription`) and can carry authored site-relative links, so `composeTwin` absolutifies it too:
  the twin surface promises every link self-resolves.

The homepage, subpages, and principle emitters all call `composeTwin`; the principle byte-equivalence invariant (R8)
re-derives the expected twin with the **same** `composeTwin`, so emit and check can never drift. DRY + single point of
test.

### KTD3. `llms-full.txt` stays frontmatter-free with zero code change

`09-llms-emit.mjs` builds `llms-full.txt` from **source** bodies (`p.source`, `s.source`, `introFullSource`), not from
the dist twins. Because frontmatter is added only at twin-emit time (KTD1), `llms-full.txt` is naturally untouched: no
edit to `llms.mjs` or `09-llms-emit.mjs` is required. This is also the correct outcome on the merits: the A5 per-section
header (`# Title`, `Source:`, `Canonical-Markdown:`) already carries the same metadata, and YAML `---` fences would
collide with the `---` delimiters `buildLlmsFull` writes between sections, breaking naive parsers. The plan records this
as an explicit non-change so a reviewer confirms it was considered, not overlooked.

### KTD4. `url` is the canonical HTML URL, not the `.md` URL

The frontmatter `url` mirrors `<link rel="canonical">` (`resolveBaseUrl() + canonicalPath`, e.g.
`https://anc.dev/audit`, `https://anc.dev/`, `https://anc.dev/p3`), not the `.md` twin path. It states where the
canonical page lives, matching context.dev and the existing canonical semantics. The twin is a representation of that
URL, not a distinct resource.

### KTD5. Field set is exactly `title` / `description` / `url` (no more)

Match the endorsed context.dev convention and keep the block minimal. Additional fields (tags, dates, principle tier)
are deferred: they add serialization surface and per-page-type special-casing for no established consumer. YAGNI.
Revisit only if a downstream consumer needs them.

---

## High-Level Technical Design

Twin emission today vs. after this change (authored content twins only):

```text
              source (content/**.md)  ── unchanged ──►  extractTitle / extractDescription ──► HTML <head> + JSON-LD  (unchanged)
                       │
                       │  (twin path only)
                       ▼
   composeTwin({title, description, canonicalPath}, body):
        ┌───────────────────────────────┐
        │ ---                            │   renderFrontmatter(): js-yaml.dump
        │ title: <extractTitle>          │
        │ description: <extractDescription, links absolutified>
        │ url: <resolveBaseUrl()+canonicalPath>
        │ ---                            │
        │                               │
        │ <absolutifyMarkdownLinks(body)>│   existing twin body
        └───────────────────────────────┘
                       ▼
             dist/<page>.md  (twin, now with frontmatter)

   llms.txt / llms-full.txt  ── built from SOURCE bodies, not twins ──►  NO frontmatter (KTD3)
```

---

## Implementation Units

### U1. Add `renderFrontmatter` + `composeTwin` helpers to `src/build/util.mjs`

**Goal:** One tested, pure place that turns `(title, description, canonicalPath, body)` into a frontmatter-prefixed,
link-absolutified twin string.

**Requirements:** R2, R3, R9.

**Dependencies:** none.

**Files:**
- `src/build/util.mjs` (add `renderFrontmatter`, `composeTwin`; import `js-yaml`)
- `tests/build.test.ts` (new `describe` block)

**Approach:**
1. `renderFrontmatter({ title, description, url })`: build `yaml.dump({ title, description, url }, { lineWidth: -1 })`
   (import `* as yaml from 'js-yaml'`, mirroring `13-web-audit-registry.mjs`), wrap as `` `---\n${dumped}---\n\n` ``.
   `lineWidth: -1` disables folding, so a long `description` (the extractor caps at 180 chars) stays on one physical
   line instead of folding into a `>-` block scalar. `dump` appends its own trailing newline, so the closing fence is
   `---\n` followed by one blank line before the body.
2. `composeTwin({ title, description, canonicalPath }, bodyMarkdown, baseUrl)`: return `renderFrontmatter({ title,
   description: absolutifyMarkdownLinks(description, baseUrl), url: resolveBaseUrl(baseUrl) + canonicalPath }) +
   absolutifyMarkdownLinks(bodyMarkdown, baseUrl)`. `baseUrl` is optional and defaults through `resolveBaseUrl`;
   deriving the `url` inside the helper keeps the frontmatter and the body links on one base, and absolutifying the
   `description` keeps the twin's promise that every link self-resolves.
3. Keep both functions pure (no fs, no rendering). `util.mjs` is build-only (the Worker imports
   `src/shared/scorecard-format.mjs`), so the `js-yaml` import adds no Worker bundle weight.

**Patterns to follow:** `absolutifyMarkdownLinks` in the same file (twin-shaping, `resolveBaseUrl` default); the
`js-yaml` import + `dump` usage in `src/build/13-web-audit-registry.mjs`.

**Test scenarios:**
- `renderFrontmatter` emits a block that starts with `---\n`, ends with `---\n\n`, and contains `title:`,
  `description:`, `url:` keys.
- The emitted block round-trips: `yaml.load` of the content between the fences yields `{ title, description, url }`
  deep-equal to the input.
- A title containing a colon-space (e.g. `P3: Progressive Help Discovery`) serializes to valid YAML and round-trips
  (regression against naive unquoted output).
- A description containing double quotes and a trailing `…` ellipsis serializes to valid YAML and round-trips.
- A `url` like `https://anc.dev/p3` serializes as a plain scalar and round-trips.
- A 180-char `description` emits a single physical `description:` line (no folded `>-` block scalar), proving
  `lineWidth: -1` is applied.
- `composeTwin` output starts with the frontmatter block (its `url` derived from `canonicalPath`) and, after it, equals
  `absolutifyMarkdownLinks(body)` for a body containing a `[text](/p3)` link (link becomes absolute).
- An explicit `baseUrl` override moves the frontmatter `url` and the body links together (e.g. a staging base yields
  `url: https://staging.example/p3` and `](https://staging.example/p1)`, with no `anc.dev` anywhere).
- A `description` containing a site-relative link (`[website audit](/web-audit)`) emits with that link absolutified, so
  the twin self-resolves.

**Verification:** New `util` tests pass; no other suite regresses.

---

### U2. Emit homepage twin with frontmatter (`src/build/06-homepage.mjs`)

**Goal:** `dist/index.md` opens with `title`/`description`/`url` frontmatter, body unchanged, HTML unchanged.

**Requirements:** R1, R2, R4, R7, R9.

**Dependencies:** U1.

**Files:**
- `src/build/06-homepage.mjs` (twin write)
- `tests/build.test.ts`

**Approach:**
1. `emitHomepage` already computes `introTitle`, `introDescription` (local var), and `introLede`; the homepage's
   canonical path is `/`.
2. Replace the `writeFile(join(distDir, 'index.md'), absolutifyMarkdownLinks(indexMdLines.join('\n')))` call with
   `composeTwin({ title: introTitle, description: introDescription, canonicalPath: '/' }, indexMdLines.join('\n'))`.
3. Update imports: this was the file's only use of `absolutifyMarkdownLinks`, so drop it (`composeTwin` calls it
   internally) and add `composeTwin`; no `resolveBaseUrl` import is needed because `composeTwin` derives the `url`
   itself. `biome check` (the `lint` gate) reds on an unused import, so leaving `absolutifyMarkdownLinks` fails CI.
4. Do not touch `emitShell` / `index.html` emission or the returned sidecar sources consumed by `09-llms-emit.mjs`.

**Patterns to follow:** existing `index.md` write in the same function.

**Test scenarios:**
- After `emitHomepage` (temp dist + real `content/` sidecars, or a focused fixture), `dist/index.md` starts with a
  frontmatter block whose `url` is `https://anc.dev/` and whose `title` matches `extractTitle(content/_intro.md)`.
- The body after the frontmatter still contains the `## Principles` section and the use-note; the homepage-silence
  tokens (`live-score`, `turnstile`, `challenges.cloudflare.com`, `/api/score`) are still absent (R7).
- `dist/index.html` contains no `\n---\n` frontmatter fence and no `url:` frontmatter line (R4).

**Verification:** `bun run build` produces `dist/index.md` with frontmatter; invariant #5 still passes.

---

### U3. Emit `07-subpages` twins with frontmatter (`src/build/07-subpages.mjs`)

**Goal:** Each of the twelve subpage twins carries `title`/`description`/`url` frontmatter derived from its source; HTML
unchanged; the widget prose-pointer behavior is preserved.

**Requirements:** R1, R2, R4, R9.

**Dependencies:** U1.

**Files:**
- `src/build/07-subpages.mjs` (twin write)
- `tests/build.test.ts`
- `tests/regression.test.ts` (the `/install` twin H1 anchor)

**Approach:**
1. Inside the `for` loop, `title` and `description` are already extracted; each subpage's canonical path is `/${name}`.
2. Replace `writeFile(join(distDir, '${name}.md'), absolutifyMarkdownLinks(twinSource))` with `composeTwin({ title,
   description, canonicalPath: `/${name}` }, twinSource)`. The widget substitution that produces `twinSource` (prose
   pointer, not HTML markup) is unchanged and still upstream of `composeTwin`.
3. Update imports: this was the file's only use of `absolutifyMarkdownLinks`, so drop it (`composeTwin` calls it
   internally) and add `composeTwin` (no `resolveBaseUrl` needed), or `bun run lint` reds on the unused import.
4. Leave `subPageData.push({ name, source: twinSource, title })` unchanged: `subPageData` feeds `llms-full.txt`, which
   must stay frontmatter-free (KTD3). Pushing `twinSource` (no frontmatter) keeps that guarantee.

**Patterns to follow:** existing subpage twin write; the `htmlSource`/`twinSource` split already in the loop.

**Test scenarios:**
- For a representative subpage (`audit`), the emitted `dist/audit.md` starts with frontmatter whose `url` is
  `https://anc.dev/audit` and whose `title` matches `extractTitle(content/audit.md)`.
- For a widget page (`web-audit`), the frontmatter is present, the body still carries the prose pointer (not the
  `<form>` HTML), and no `data-web-audit-form` markup leaks into the twin.
- `dist/audit.html` contains no frontmatter fence / `url:` line (R4).
- `subPageData` entries still carry the frontmatter-free `twinSource` (guards KTD3 / R6 at the source of
  `llms-full.txt`).
- Regression #6's `/install` twin assertion (`tests/regression.test.ts`) matches its H1 with a multiline anchor
  (`/^#\s+Install anc/m`): the twin opens with the frontmatter block, and the H1 follows it.

**Verification:** `bun run build` produces every subpage twin with frontmatter; HTML pages unchanged.

---

### U4. Emit principle twins with frontmatter and strengthen the byte-equivalence invariant (`src/build/build.mjs`)

**Goal:** `dist/p1.md`..`dist/p8.md` carry frontmatter, and invariant #4 verifies `dist/p<n>.md === composeTwin(fm,
source)` exactly.

**Requirements:** R1, R2, R4, R8, R9.

**Dependencies:** U1.

**Files:**
- `src/build/build.mjs` (principle twin write in the section-4/5 loop; `runInvariantChecks` #4, exported)
- `tests/build.test.ts`
- `tests/regression.test.ts` (regression #3 twin contract + per-page HTML locks)

**Approach:**
1. In the principle page loop, `title` and `description` are already destructured from `p`; each principle's canonical
   path is `/p${n}`.
2. Replace `writeFile(join(DIST_DIR, 'p${n}.md'), absolutifyMarkdownLinks(source))` with `composeTwin({ title,
   description, canonicalPath: `/p${n}` }, source)`.
3. Update invariant #4 in `runInvariantChecks`: for each principle, re-derive `title = extractTitle(source)`,
   `description = extractDescription(source)`, and assert `distContent === composeTwin({ title, description,
   canonicalPath: `/p${n}` }, source)`. `runInvariantChecks` receives `principleSources` as `[{ n, sourcePath }]`; it
   already re-reads source, so it re-runs the same extractors. Export `runInvariantChecks` from `build.mjs` so the
   invariant unit tests can drive it directly against a seeded temp dist. Update `build.mjs`'s imports: add
   `composeTwin` and drop `absolutifyMarkdownLinks`. Both of its uses (the section-4/5 twin write in step 2 and
   invariant #4) now route through `composeTwin`, so the import is left unused and `biome check` reds CI.
4. The invariant re-derivation and the emit share `composeTwin` (KTD2), so there is exactly one definition of a
   principle twin's bytes.
5. Update `tests/regression.test.ts` to the frontmatter twin contract: regression #3 asserts `dist/p<n>.md ===
   composeTwin(frontmatter, source)` for every principle, driven by `LOCKED_SLUGS.length` (all eight pages, not a
   hardcoded seven), and the file-header comment states the llms.txt shape's eight `.md` bullets.

**Patterns to follow:** existing principle twin write (section 5 comment) and existing invariant #4.

**Test scenarios:**
- Via a `runInvariantChecks` unit test over a seeded temp dist (`tests/build.test.ts`): a `dist/p1.md` that lacks the
  expected frontmatter fails invariant #4.
- A `dist/p1.md` whose body drifts from the absolutified source still fails invariant #4 (regression: the strengthened
  check keeps body-equivalence).
- A correctly composed twin (frontmatter + absolutified body from `composeTwin`) passes invariant #4.
- Every `dist/p<n>.html` (all eight, via `LOCKED_SLUGS`) carries no frontmatter fence (`---\ntitle:`) and no `url:` line
  (R4; `tests/regression.test.ts`).

**Verification:** `bun run build` completes; invariant #4 passes for a real build and fails on an injected drift.

---

### U5. Confirm and lock the `llms-full.txt` / `llms.txt` non-change

**Goal:** Prove (in a test) that frontmatter did not leak into the concatenated corpus and that the index is untouched.

**Requirements:** R6.

**Dependencies:** U2, U3, U4.

**Files:**
- `tests/build.test.ts`

**Approach:** No production code changes here (KTD3 means `09-llms-emit.mjs` already uses source bodies). Add a
regression test that guards the property so a future refactor that starts feeding twins into `llms-full` is caught.

**Execution note:** This unit is a regression lock, not a feature; its whole value is the test.

**Test scenarios:**
- `buildLlmsFull` output for a section whose source body has no frontmatter contains no `\nurl: https://` line and no
  YAML `---` fence introduced by this feature (the only `---` present are the A5 inter-section delimiters).
- `buildLlmsIndex` output equals a fixed expected string (inline snapshot) for fixed inputs, proving the index is
  unchanged by this feature.

**Verification:** New `llms` regression tests pass.

---

## Scope Boundaries

**In scope:** frontmatter on the authored content twins (`index.md`, `p1..p8.md`, the twelve `07-subpages` twins), a
shared `composeTwin` helper, the strengthened principle invariant, and regression locks for the HTML / `llms-full`
non-changes.

**Out of scope / Deferred to Follow-Up Work:**
- Frontmatter on **generated** twins: `scorecards.md`, per-tool `score/<name>.md`, `coverage.md`, `skill.md`, the web
  scorecard twins (`14-web-scorecards-emit.mjs`), and the `/web-audit/skill/<id>.md` fix-skill twins
  (`15-web-audit-skills.mjs`). These are projections rather than authored pages; their title/description derivation
  differs and no consumer needs them yet. The part (b) MAY check probes only `/`, so it does not require them. A
  follow-up can extend `composeTwin` to these emitters if desired.
- Additional frontmatter fields beyond `title`/`description`/`url` (KTD5).
- Any change to `llms.txt` / `llms-full.txt` shape (KTD3).

**Explicit non-goals:** modifying `content/**` source, changing any HTML output, or bumping any schema/version.

---

## Cross-Feature Contention Notes

A sibling plan (`docs/plans/2026-08-03-003-feat-web-audit-frontmatter-check-plan.md`, part b) adds a MAY web-audit check
that detects this exact frontmatter on **other** sites' twins.

- **No file overlap.** Part (a) touches `src/build/util.mjs`, `06-homepage.mjs`, `07-subpages.mjs`, `build.mjs`, and
  `tests/build.test.ts` (Node build pipeline). Part (b) touches `src/data/web-audit/*.yaml`, the Worker audit engine,
  and Worker tests. The two can land in either order or in parallel.
- **Soft ordering (nice-to-have, not required):** land part (a) before part (b)'s staging e2e so anc.dev's `/` twin
  carries frontmatter and self-audits as `pass` for the new check. If (b) lands first, anc.dev simply reports `n_a`
  (`optional-absent`) for that check until (a) ships. No functional dependency either way.
- A separate sibling is planning Feature 1 (markdown-serving MAY probes). Feature 1 is in the Worker/registry subsystem
  and does not touch this plan's files.

---

## System-Wide Impact

- Agents fetching any authored `.md` twin now receive canonical `title`/`description`/`url` up front. No human-facing
  surface changes.
- `dist/*.md` byte size grows by a few lines per twin. Minification (`12-minify-dist.mjs`) does not touch `.md`.
- CI: the strengthened invariant #4 is a stronger contract, not a looser one, so no gate is softened.

---

## Assumptions

- `js-yaml`'s `dump` is available in the build runtime (confirmed: imported by `src/build/13-web-audit-registry.mjs`).
- `extractDescription` returning `''` (fallback) for a page with no prose paragraph is acceptable as a frontmatter
  `description: ''` value; every current authored content page has a lede, so this is not expected to fire. If a
  stricter policy is wanted, guard is a one-line follow-up.
- The `07-subpages` `mcp` and `changelog` twins, though short, still have an H1 + first paragraph for
  `extractTitle`/`extractDescription`; no special-casing needed.

---

## Open Questions

- **OQ1** Should the frontmatter `description` reuse the 180-char-capped `extractDescription` (matches the HTML `<meta
  name="description">` exactly) or the uncapped first paragraph? Recommended default (taken in this plan): the capped
  `extractDescription`, for parity with the HTML meta and to keep the block short. Revisit only if an ingestion consumer
  wants the full lede.
- **OQ2** Do we want frontmatter on the generated twins (scorecards/coverage/skill/web) in this PR or a follow-up?
  Default (this plan): follow-up, to keep the PR bounded to authored content.

---

## Sources & Research

- Twin emit sites: `src/build/06-homepage.mjs` (index.md), `src/build/07-subpages.mjs` (subpage twins),
  `src/build/build.mjs` (principle twins + `runInvariantChecks` #4/#5).
- Metadata extractors: `src/build/content.mjs` (`extractTitle`, `extractDescription`, `extractFirstParagraph`).
- Twin/link/base helpers: `src/build/util.mjs` (`absolutifyMarkdownLinks`, `resolveBaseUrl`); `js-yaml` usage precedent
  in `src/build/13-web-audit-registry.mjs`.
- HTML path (must stay unaffected): `src/build/shell.mjs` (`emitShell` uses title/description/canonical + JSON-LD, all
  from source).
- `llms` corpus: `src/build/llms.mjs` + `src/build/09-llms-emit.mjs` (built from source bodies, A5 per-section header).
- Prior art: context.dev prepends `title`/`description`/`url` frontmatter to its agent-markdown (user-endorsed).
