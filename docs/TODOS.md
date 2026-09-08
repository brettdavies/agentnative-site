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

### Live getTools() for the webmcp check

**What:** Replace the static HTML-marker grep in `src/worker/audit-web/handlers/webmcp.ts` with a real `getTools()`
probe that grades answer/act/transact.

**Why:** After 3 Sep the MAY `webmcp` check should measure the collaboration surface, not markup that declares one. The
challenge video must not claim this check already flipped.

**Context:** `runWebMcp` regexes `ctx.root.body` against `WEBMCP_MARKERS`: an `application/webmcp` script type, a
`navigator`/`document`/`window.modelContext` reference, and a `webmcp` script `src`. Those are structural rather than a
bare `webmcp` substring, so a site that merely writes the word no longer passes, but a site that ships the markup and
registers nothing still does. Grading answer/act/transact needs Chromium (or equivalent) in the worker pipeline. Blocked
by: no headless browser in `src/worker/audit-web`.

**Effort:** L **Priority:** P3 **Depends on:** First-party page tools shipping so there is something to grade **Blocked
by:** Headless browser runtime in the web-audit engine

## Release

### Ship the telemetry family deliberately in a coming release

**What:** The telemetry family (#322 privacy posture page + lake config + stall alert, #330 structured-log emitter +
client taxonomy + gateway page record, #331 emitter migration of every Worker log site) lives on `dev` and staging but
is absent from `main`: the 2026-09-08 release reverted its 54-file footprint to the pre-telemetry baseline and stripped
the emitter/lake prose from AGENTS.md and RELEASES.md.

**Why:** The family needs an explicit readiness call before it reaches production. Until it ships, every release cut
from `dev` must either carry it (the default overlay behavior) or repeat the hold surgery; an overlay built without
remembering this entry ships telemetry silently.

**Context:** The hold classification is mechanical to reproduce: the three squash commits' file lists, minus the five
overlap files (AGENTS.md, RELEASES.md, `src/build/07-subpages.mjs`, `src/build/shell.mjs`, `tests/e2e/flows.e2e.ts`)
whose privacy/telemetry hunks are stripped by hand. When it ships, restore the `#### R2 telemetry-lake catalog` section
to the released RELEASES.md and the emitter bullet to AGENTS.md. Separately, `RELEASES-PREFLIGHT.md` and
`RELEASES-POSTFLIGHT.md` both list `scorecard-summary` among the share-page render classes; the renderer no longer emits
that class (three classes is the full set), so fix both docs through the normal PR flow.

**Effort:** S **Priority:** P1 **Depends on:** telemetry readiness call

## CI

### Escalate if the `wrangler dev` death keeps eating deep-check retries

**What:** The mid-suite `wrangler dev` death is diagnosed and mitigated: the crash-probe action uploads wrangler's debug
log and the Playwright JSON summary, `probe.sh` recognizes two evidence classes (the workers-sdk#15317 proxy-crash
signature, and mass connection refusals from a silent kill), and `deep-check-crash-retry.yml` spends one rerun on a
fresh runner when either matches. What remains is the day the retry is not enough.

**Why:** The fault is upstream (workers-sdk#15317; fix PR workers-sdk#15448 open, unmerged as of 2026-09-08, and
wrangler 4.130.0 ships without it). On a bad runner-pool day the crash rate can exceed what one retry absorbs:
2026-09-08 produced four crashes in four consecutive e2e executions, including a failed rerun.

**Context:** Escalation options if red nightlies persist: (a) supervise the webServer so a killed `wrangler dev`
restarts in place and Playwright's per-test CI retry re-covers the gap, shrinking the blast radius from "rest of the
suite" to "tests in flight"; (b) shard the e2e matrix into per-project jobs so a crash fails one short shard and the
retry reruns only that shard; (c) adopt the upstream fix the moment workers-sdk#15448 merges and drop the special casing
that stops earning its keep. Watch the issue before building (a) or (b).

**Effort:** M **Priority:** P2 **Depends on:** upstream workers-sdk#15448 (watch), or a run of red nightlies that
justifies (a)/(b)

## Completed
