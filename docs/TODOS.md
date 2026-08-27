# TODOS

Deferred work. Challenge-week WebMCP **code** (T1–T4) merged in
[#280](https://github.com/brettdavies/agentnative-site/pull/280). Remaining WebMCP work is T5 (ChatGPT/Chrome
`getTools`) and T6 (`release/*` → `anc.dev`); see `docs/designs/webmcp-page-collaboration.md`. The scoring-funnel item
below is **after T0** and **not** part of that plan.

## Scoring funnel

### Align CLI and web live-scoring on one prepare → transact → result machine

**What:** After T0 (`turnstile-sitekey` on `/web-audit`, #279) and the WebMCP client (#280), write a short
scoring-funnel design and extract the shared middle. Do not fold this into a WebMCP follow-up or expand T0 into
unification.

**Why:** CLI and web are the same three phases that grew into two page graphs and two Turnstile stacks. T0 only makes
the *intended* web transact click work (gate on `/web-audit`, WIP spends a stash). Unifying the machine is real
follow-up work; doing it in challenge week recouples surfaces that WebMCP needs to keep split (tools may prepare, must
not transact).

**Context (as of 2026-08-26):**

Both products are:

1. **Prepare** — human types a target (web also: listing checkbox).
2. **Transact** — human click, Turnstile token, cost-bearing POST.
3. **Progress** — theater while the audit runs; **reuse the token, do not re-challenge**.
4. **Result** — cache-backed share URL; no Turnstile.

How they land today:

| Phase    | Shared intent                       | CLI today                                      | Web today                                                                                                            |
| -------- | ----------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Prepare  | fill, optional extras, no token     | homepage box                                   | `/` Website **Audit** is `GET /web-audit?url=` (not transact)                                                        |
| Transact | sitekey + token + POST on the click | homepage **Score** POSTs `/api/score` in place | `/web-audit` **Audit** acquires + stashes (sitekey on the form as of #279); WIP falls back to on-load if stash empty |
| Progress | theater; consume stash              | inline “Queued…” / phases on `/` (no WIP URL)  | `/web/scoring/<host>` streams NDJSON; on-load Turnstile if stash empty                                               |
| Result   | GET cache URL                       | `/score/<slug>` or `/score/live/<binary>`      | `/web/<host>` (`location.replace` so Back skips WIP)                                                                 |

Other facts that belong in the later design:

- Turnstile is three things: **sitekey** in HTML, Cloudflare **script**, **token** on the POST. A page can have a
  sitekey and never load the script (homepage web form).
- CLI lazy-loads the script on first focus/click/paste/chip; the widget runs on **Score**. Sitekey is `<meta>` in the
  homepage `<head>` (`emitShell` `isIndex` only).
- `/audit` **Score** is `GET /?score=…` (prepare hop onto the homepage). It does not submit.
- Web WIP does not inherit a widget. It **takes a sessionStorage token** or **acquires on page load** (weaker; no
  click). Direct/shared `/web/scoring/<host>` links still need that fallback.
- CLI Turnstile lives in `src/client/live-score.ts` (private copy). Web uses `src/client/turnstile.ts`. Scoring page
  injects sitekey **in the article body** (`scoringBody` in `src/worker/audit-web/route.ts`), not the shared shell.
- MCP `score_cli` / `audit_website` never use Turnstile (IP rate limits).
- Invisible Turnstile wants a real click. That is why web *meant* to acquire on `/web-audit` and why CLI never had a
  WIP-token hole: submit never left `/`.

They diverged for product reasons, not only drift:

- **Duration.** CLI is one JSON body plus a 2s cached-theater floor. Web is a long NDJSON stream with per-check rows, so
  it earned a WIP URL.
- **Extra field.** Listing only exists on web, so prepare needed a page that is not the homepage hero.
- **No-JS.** Homepage web form is a real GET so the CLI/Web toggle still works without JS. CLI without JS POSTs
  `/api/score` and fails siteverify.
- **WebMCP (constraint on any later funnel, not work for that plan).** Tools may fill and hop. Tools must not transact.
  Homepage Website Audit stays a GET. `/web-audit` Audit stays the only browser transact cut.

**Later shape (do not implement in T0 or WebMCP):** one state machine, two skins. Progress UI may stay different (2s
status line vs streaming table). Overlap to extract:

- One Turnstile helper (`turnstile.ts`; delete the CLI private copy or wrap it).
- One way to emit the sitekey on every **transact** page (not `isIndex`-only, not body-only on WIP).
- One rule: **only the transact click acquires**.
- One rule: progress pages never challenge unless the user landed there with no stash (shared/direct WIP).
- Homepage stays prepare-only on **both** surfaces if CLI ever grows a dedicated prepare URL; until then CLI may keep
  prepare+transact collapsed on `/`.

**Do not:**

- Collapse web onto the CLI homepage (lose listing, lose stream, turn homepage Audit into transact).
- Collapse CLI onto web’s three URLs as a drive-by (new `/score/prepare`, new WIP, new tests) in challenge week.
- Expand T0 into this item. T0 is: put `turnstile-sitekey` on `/web-audit` so Audit-click can stash a token. WIP still
  acquires on load when there is no stash. CLI homepage path unchanged.

**First slice (after T0 + WebMCP clip):** shared `turnstile.ts` + consistent sitekey emission + the two rules above.
**Second slice:** optional CLI prepare URL / optional in-place web stream — only if a design says the page counts should
match. They do not have to.

**Effort:** M (first slice) / L (full page-graph alignment) **Priority:** P3 **Depends on:** T0 merged (#279); WebMCP
T1–T4 merged (#280); clip on production still T5+T6 (deadline 3 Sep 2026). **Out of scope for:**
`docs/designs/webmcp-page-collaboration.md`

## Web audit

### Neutralize Issue evidence in assembleRemediation

**What:** Escape or collapse instruction-like third-party evidence when building the `Issue:` line in
`src/worker/audit-web/remediation.ts`.

**Why:** `get_fix_prompt`, the Copy-prompt widget, and `/web/<host>.md` all return that string. A hostile audited site
can plant adversarial text in headers/robots/llms.txt. We skipped `untrustedContentHint` because it would only mark the
WebMCP path.

**Context:** `assembleRemediation` interpolates `input.evidence` into `Issue: ${issue}` (`remediation.ts` ~83). Do not
special-case WebMCP. Preserve useful URLs and header names; do not over-strip. Start with a golden-file test of a
payload that contains “ignore previous instructions”.

**Effort:** M **Priority:** P2 **Depends on:** WebMCP clip shipped (or can land independently)

### Live getTools() for the webmcp check

**What:** Replace the static HTML-marker grep in `src/worker/audit-web/handlers/webmcp.ts` with a real `getTools()`
probe that grades answer/act/transact.

**Why:** After 3 Sep the MAY `webmcp` check should measure the collaboration surface, not the word `webmcp` in HTML. The
challenge video must not claim this check already flipped.

**Context:** Today `runWebMcp` only regexes `ctx.root.body`. There is no browser in the audit engine. This needs
Chromium (or equivalent) in the worker pipeline. Blocked by: no headless browser in `src/worker/audit-web`.

**Effort:** L **Priority:** P3 **Depends on:** First-party page tools shipping so there is something to grade **Blocked
by:** Headless browser runtime in the web-audit engine

## Completed
