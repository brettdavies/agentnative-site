# VOICE.md — agentnative spec site

You are writing for **the agent-native CLI standard**, a specification published at `agentnative.dev`. The site has two
first-class audiences: developers evaluating the standard (often arriving from a Show HN post) and AI agents consuming
the spec programmatically. Copy runs on the principle-page index, `/check`, `/about`, the header wordmark, the footer
colophon, the OG social card, and any future surface. Voice is third-person — the site speaks as a standard, not a
person. There is no "we," no "our team," no first-person singular. When a requirement has an actor, the actor is "tools"
or "the CLI," not "you." Second-person is allowed only on `/check`, where the reader IS the actor.

Structure adapted from
[Anh-Tho Chuong / Lago's voice-skill template](https://github.com/getlago/inside-lago-voice-skill).

Pair with:

- [`.impeccable.md`](../.impeccable.md) — users, brand personality, anti-references.
- [`docs/DESIGN.md`](DESIGN.md) — typography, palette, layout.
- Voice anchor: `~/obsidian-vault/Projects/brettdavies-Brand-System/seed-material/xAI-Cover-Letter-VOICE-ANCHOR.md`. The
  letter is first-person; the spec site is third-person. Everything else — concrete-before-abstract, numbers-not-
  adjectives, "the code speaks for itself" close — transfers.

## Voice

Opinionated, precise, inviting.

- **Opinionated.** The standard has a point of view. It does not enumerate tradeoffs and shrug; it issues verdicts
  ("MUST do X, here is the failure mode, here is the canonical fix"). The opinion shows up in the keyword tiering, the
  anchor-link design, and the absence of hedging in every single sentence.
- **Precise.** RFC 2119 language throughout. Exit codes beat "helpful errors," 30-second timeouts beat "reasonable
  timeouts." If a sentence doesn't have a number or a concrete artifact in it, ask why. Contrast ratios are measured;
  anchor slugs are locked; tokens and identifiers on the page match exactly what the `agentnative` linter reports.
- **Inviting.** This is the word that keeps the voice from sliding into dry-RFC failure mode. A reader should *want* to
  keep reading at page three — not because the site performs warmth, but because the details reward slow reading
  (tabular-numeral version stamps, small-caps labels, `:target` landings that actually land, Monaspace Xenon operator
  shapes that render clean). Inviting is not friendly and it is not marketing. It is "rewards engagement."

Sentence rhythm: short on average; fragments fine when they carry weight. Transitions are earned by content, not by
words like "furthermore" or "in addition." One-sentence paragraphs are allowed when the sentence deserves a frame.

## Core Rules

1. **Concrete before abstract.** Every principle page opens with the *failure mode* before the requirement. "The agent
   hangs. The user sees nothing. The operation times out silently." — then the MUST.
2. **Show the shape, then prescribe.** Broken code or broken behavior in a fenced block, canonical fix second. A
   six-line code example beats a three-paragraph description, every time.
3. **Exit codes, not adjectives.** Numbers and identifiers everywhere they exist. "Exit code 77 (auth/permission)" beats
   "helpful error." "30-second timeout" beats "sensible default."
4. **One MUST per bullet.** If a bullet contains two requirements, it's two bullets. Conditions go in a nested
   sub-bullet, never buried in a long sentence.
5. **The code speaks for itself.** End-of-section links carry the path or command as their link text — not "learn more,"
   not "read more." A reader who wants the proof clicks; a reader who doesn't has already gotten the requirement.
6. **No first-person singular on spec surfaces.** The site has no `I`. Third-person descriptions of requirements and
   tools. Second-person only on `/check`, where it maps to a real action the reader is taking.
7. **Cite check IDs as the permanent citation primitive.** When copy refers to a specific check, it names the ID
   (`p4-process-exit`, `p1-non-interactive`). IDs survive reformatting; adjectival descriptions do not.

## Anti-Filler Checklist

AI drafts reliably ship with these patterns. Delete them on sight.

- **The preamble.** Any sentence that announces the insight before delivering it. ("Here's why this matters…", "One key
  thing to understand…") Strip and start at the insight.
- **The softener.** "Might," "somewhat," "often," "typically," "in general." If a requirement is a MUST, say MUST. If
  it's a SHOULD, say SHOULD. There is no "sometimes" tier.
- **"Simply," "just," "easy," "simple."** These words add zero signal and insult readers who are still working it out.
  Cut every instance.
- **The recap.** A closing paragraph that summarizes the section. The reader was there. Delete.
- **The duplicate.** Two consecutive sentences saying the same thing in different words. Keep the sharper one.
- **Appeal-to-authority adjectives.** "Industry-leading," "best-in-class," "modern," "robust." The code is the
  authority. Let scorecards and check IDs demonstrate it.
- **Marketing interjections.** 🚀 ✅ 🎯 — not one of these ships. Ever. On any surface.
- **Transition-by-bridge-word.** "Furthermore," "moreover," "in addition," "that said." If two paragraphs don't flow
  without a bridge, rewrite them until they do.
- **"Developer-loved," "developer-friendly," any variation.** Never describes a real property; always a tell.
- **Em-dash overuse.** Em-dashes are fine; four on a page is a draft, not a final. Tighten sentences so some of them
  become periods.

## Audience Adaptation

### Register 1: Developers arriving cold (most of `/` and `/about`)

Assumes the reader came from a link, knows how to read RFC-flavored docs, wants to decide in <60 seconds whether the
standard is serious. Third-person throughout. Confident verdicts. Concrete failure modes in the first line of each
section. Never explains what RFC 2119 is *before* quoting it — explain only on `/about`, where a reader going deep might
reasonably ask.

### Register 2: Developers running the tool (`/check`)

Second-person, imperative, task-oriented. The reader is installing and running `agentnative` right now. Short
paragraphs. Code fences do most of the work. No narration between the install block and the usage block.

### Register 3: Agents fetching markdown (`/llms.txt`, `/llms-full.txt`, `*.md`)

The same copy a human sees, served verbatim as the markdown source. Do NOT write agent-specific copy as an alternate
pass — the source-of-truth policy forbids drift. What this means for authoring: every sentence that works in prose also
has to make sense to an agent scanning for keywords. Headings are structural, not decorative. Anchor slugs are stable.
Code fences name the language.

### What stays the same across all three

- No first-person singular.
- RFC 2119 keywords carry their contractual meaning.
- Check IDs and anchor slugs appear verbatim.
- No marketing intensifiers.

## Surface-Specific Notes

### Principle page (`content/principles/p<n>-...md`)

Five-section shape, locked by
  [`principles/AGENTS.md`](~/obsidian-vault/Projects/brettdavies-agentnative/principles/AGENTS.md):
Definition, Why Agents Need It, Requirements, Evidence, Anti-Patterns. No intro paragraph above the Definition — the
anchor text is the summary. Link-text convention for templates: the path itself (`templates/output-format.rs`) or the
flag (`--no-interactive`), never "this pattern" or "the reference."

### `/check`

Second-person. One sentence framing → install block → first-run block → example output → one line on how to read the
output. Every code fence uses a real, runnable invocation. No pseudo-code.

### `/about`

Third-person. Short sections on standard / versioning / RFC 2119 / license / contributing / colophon. Attribution is a
colophon line at the bottom, not a bio section. The site does not lead with Brett's name; davies.fyi owns the named
surface.

### Footer

`v{version} · {YYYY-MM-DD} · source on GitHub` — exact form, every page, always. Middot is U+00B7.
`font-variant-numeric: tabular-nums`. No personal attribution.

### OG / social headline

Two lines maximum. Line 1: the standard's name. Line 2: one clause naming the reader ("for CLIs," "for agents"). No
"introducing," no gerunds, no taglines.

## Drafted vs Sent: Calibration Examples

This section captures the gap between what was drafted (usually by an AI) and what was actually sent. More examples =
better calibration. Each entry names the surface, the draft, the send, and the lesson.

### Example 1 — brand-voice words (session 2026-04-14)

- **Drafted** (option 1 of 4): "precise, austere, self-evident."
- **Sent**: "opinionated, precise, inviting."
- **Delta**: "austere" and "self-evident" read as permission to be boring. "Opinionated" carries a POV the reader can
  engage with; "inviting" prevents drift into dry-RFC. Same authority intent, different engagement vector.
- **Lesson**: A spec voice that defaults to minimal reads as uncommitted, not confident. "Restraint is not austerity"
  (Design Principle 3 in `.impeccable.md`) is the tight formulation.

### Example 2 — `/check` install stanza framing (session 2026-04-14)

- *(empty — populate the first time a draft of `/check` content is edited)*

### Example 3 — `/about` attribution line (session 2026-04-14)

- *(empty — populate the first time a draft of `/about` content is edited)*

Every time copy ships after an edit, add an entry. The site voice lives in these diffs.

## Product Context

### How to describe `agentnative` (the linter)

- Call it "the reference linter for this standard" on the site, not "my tool" or "our CLI." The site speaks as the
  standard; `agentnative` is one compliant artifact that happens to measure the others.
- Use the full binary name `agentnative`. `anc` is a local tmux alias for Brett's workflow, not a public name — don't
  publish it.
- Install instructions cover `cargo install agentnative` and `cargo binstall agentnative`. Homebrew will land later;
  wait until the formula ships before writing about it.
- Check output uses check IDs (`p4-process-exit`). Copy that references specific checks names the ID.

### How to describe the relationship to `davies.fyi`

- The spec site does not link to `davies.fyi` from the header or principle pages. The only mention lives in `/about` as
  a single-line maintainer colophon, and only once `davies.fyi` is live and linkable. Until then, attribution is "Source
  on GitHub" with no name.

### What the site never says

- It does not promote the HN launch from within its own copy. The HN post links to the site, not the other way around.
- It does not compare itself to dev-ex frameworks, testing libraries, or other "standards." The scorecard does the
  comparing.
- It does not claim adoption numbers. Adoption is visible in scorecard coverage; claiming it is performance.

## Editing Process

1. **Self-edit with this file open.** Delete anything that trips any of the Core Rules or matches the Anti-Filler
   Checklist. Cut aggressively; every surviving word should carry weight.
2. **`/clarify`** (impeccable skill) — treat as a lint pass for passive voice, buried verbs, jargon leaks. Not a rewrite
   pass.
3. **Read aloud once.** If any sentence trips the tongue, rewrite the sentence — not the tongue.
4. **Diff against the upstream principle file** (for principle pages). Confirm every MUST / SHOULD / MAY in the upstream
   appears on the site, possibly collapsed but never dropped silently. If a requirement is intentionally cut, note why
   in a commit message.
5. **If an edit surfaces a new pattern worth keeping, add it to the Anti-Filler Checklist or Core Rules above.** Don't
   trust memory; capture on sight.

## Future work

If copy-drafting becomes frequent (third surface, blog cadence, v0.2 changelog copy), codify this file as a
project-local `/draft-spec-voice` skill in `.claude/skills/spec-voice/SKILL.md`. The skill wraps `/clarify` with a
prepended copy of the Core Rules, Anti-Filler Checklist, and the three most recent Drafted vs Sent examples. Until then,
the file is enough.

---

Structure from [inside-lago-voice-skill](https://github.com/getlago/inside-lago-voice-skill), built by Anh-Tho Chuong
([@anhtho](https://www.linkedin.com/in/anhtho/), Lago). The template is generalized; the agentnative fills are this
project's.
