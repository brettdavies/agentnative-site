---
date: 2026-09-02
topic: webmcp-observability-spike
upstream: docs/plans/2026-09-01-0042-refactor-structured-log-emitter-plan.md (unit U13; R12, KTD15)
purpose: What the WebMCP layer can observe about co-browsing, with evidence, before any backend for it is designed.
recommended_shape: allowlisted-event-beacon
---

# WebMCP Observability Spike

Answers R12 of the structured-log emitter plan
([docs/plans/2026-09-01-0042](../plans/2026-09-01-0042-refactor-structured-log-emitter-plan.md), unit U13): what the
WebMCP layer can observe and report about agent activity, established before any backend for co-browsing telemetry is
designed. The parent telemetry plan
([docs/plans/2026-09-01-1732](../plans/2026-09-01-1732-feat-sitewide-telemetry-plan.md)) carries actor A4, the
co-browsing pair, with three datapoints marked "pending spike": agent product name, MCP method and outcome, and a
co-presence signal. This document settles all three.

No production code ships from this unit. Every claim below is grounded in a `path:line` citation into the repo, in the
WebMCP specification (Draft Community Group Report, 2 September 2026, https://webmachinelearning.github.io/webmcp/), or
in the Fetch Metadata specification.

## TL;DR

- **Interceptable: all fifteen tools, at one seam.** Every tool is assembled by `toolsFor` and handed to the browser by
  `bindModelContext` (`src/client/webmcp-lib.ts:161-182`). Wrapping `execute` on that array observes every invocation on
  every registration path. Nothing outside that seam sees anything.
- **The navigation signal does not generalize.** `open_web_audit` is a plain `GET /web-audit?url=` document navigation
  from the human's browser (`src/client/webmcp-home.ts:40`; `src/build/06-homepage.mjs:213`). Server-side it is a
  browser page view; no header separates it from a human pressing Audit. Fourteen of fifteen tools produce no origin
  traffic at all.
- **Name and outcome, yes; arguments, never.** The seam sees `tool.name`, whether `execute` settled, rejected, or was
  aborted, and wall-clock duration. It also sees the argument object, which carries user intent (target URLs, free text)
  and must not leave the page.
- **Agent identity is not knowable client-side.** The execute callback receives the input object and an `AbortSignal`
  and nothing else (spec section 4.2.2). An execution proves a registered tool ran, not who ran it.
- **An ingest endpoint costs a new open POST route, a per-IP rate-limit binding in two environments, an emitter scope, a
  privacy-page disclosure, and the surrender of the pinned "no network calls" property.** Turnstile and the session
  cookie cannot gate it without collapsing coverage to zero.
- **Recommendation: an allowlisted-event beacon, per-IP rate-limited, carrying no identity and no arguments.** It
  deliberately gives up agent identity, argument content, tamper resistance, and any agent that reads without calling a
  tool.

## Method

Static reading of the twenty modules under `src/client/`, the WebMCP tool tests, the Worker's POST routes and their gate
waterfalls, the rate-limit bindings in `wrangler.jsonc`, the CSP, the privacy posture page, and the WebMCP
specification's IDL and security sections. Confirmation greps are quoted where they carry the argument. No browser with
a WebMCP agent attached was driven; the spec's IDL is the authority on what the callback receives, and the site's own
test harness exercises the seam the same way a browser does (`tests/webmcp.test.ts:600-623`).

## 1. Which tool invocations are interceptable, and where the seam is

The entry module calls `initWebMcp()` (`src/client/webmcp.ts:4-6`). `initWebMcp` probes `document.modelContext`, then
`navigator.modelContext`, and returns without registering anything when both are absent
(`src/client/webmcp-lib.ts:192-214`). `registerWithLifecycle` reads the page's origin and pathname, calls
`toolsFor(pathname, { doc, origin })`, and passes the resulting array to `bindModelContext`, which calls
`mc.registerTool(tool, { signal })` once per tool, or `mc.provideContext({ tools })` when `registerTool` is missing
(`src/client/webmcp-lib.ts:174-190`). `toolsFor` is the single assembly point: it composes the page-state tool with the
home, audit, result, and orientation tool sets by path predicate (`src/client/webmcp-lib.ts:161-172`).

Every tool is a `WebMcpTool` whose `execute(input)` returns a string or a promise of one
(`src/client/webmcp-lib.ts:24-30`). The browser invokes `execute` with the parsed input object and an options dictionary
(spec section 3.1, imperative execute steps; section 4.2.1). The seam is the array `toolsFor` returns: a wrapper
installed there, before `bindModelContext` hands the objects to the browser, observes every invocation of every tool on
both registration paths. The existing test already exercises the tools through exactly this seam, iterating
`toolsFor(...)` and calling `tool.execute` directly (`tests/webmcp.test.ts:611-621`).

Routes below follow the path predicates in `src/client/webmcp-lib.ts:56-72`: `home` is `/`, `audit` is `/web-audit`,
`result` is `/web/<domain>`, and `orientation` is `/`, `/mcp`, and `/p1` through `/p8`.

| Tool                 | Module (`src/client/`)        | Route               | Effect                          |
| -------------------- | ----------------------------- | ------------------- | ------------------------------- |
| `get_page_state`     | `webmcp-lib.ts:149-159`       | home, audit, result | reads DOM                       |
| `set_surface`        | `webmcp-home.ts:46-60`        | home                | writes DOM                      |
| `fill_cli_target`    | `webmcp-home.ts:61-73`        | home                | writes DOM                      |
| `fill_web_target`    | `webmcp-home.ts:74-86`        | home                | writes DOM                      |
| `open_web_audit`     | `webmcp-home.ts:87-99`        | home                | navigates `GET /web-audit?url=` |
| `fill_audit_url`     | `webmcp-audit.ts:35-47`       | audit               | writes DOM                      |
| `set_plan`           | `webmcp-audit.ts:48-60`       | audit               | writes DOM                      |
| `set_public_listing` | `webmcp-audit.ts:61-73`       | audit               | writes DOM                      |
| `get_worksheet`      | `webmcp-result.ts:308-316`    | result              | reads DOM                       |
| `get_fix_prompt`     | `webmcp-result.ts:317-333`    | result              | reads DOM                       |
| `get_fix_prompts`    | `webmcp-result.ts:334-342`    | result              | reads DOM                       |
| `get_audit_summary`  | `webmcp-result.ts:343-354`    | result              | reads DOM                       |
| `get_principle_url`  | `webmcp-orientation.ts:5-24`  | orientation         | returns a constant              |
| `get_llms_index`     | `webmcp-orientation.ts:25-33` | orientation         | returns a constant              |
| `get_mcp_endpoint`   | `webmcp-orientation.ts:34-44` | orientation         | returns a constant              |

Fifteen tools, one of which produces origin traffic. Eight carry `readOnlyHint: true` (four in `webmcp-result.ts`, three
in `webmcp-orientation.ts`, one in `webmcp-lib.ts`); seven mutate the DOM or navigate.

**Network calls, verified.** `rg -n "fetch\(|XMLHttpRequest|sendBeacon|form\.submit|navigator\.|window\.location"
src/client/` matches, inside the six WebMCP modules, only `src/client/webmcp-home.ts:40` (`form.submit()`) and two
comments about `navigator.modelContext` (`src/client/webmcp-lib.ts:2,199`). The `location.origin` reads at
`src/client/webmcp-lib.ts:124,186-187` and `src/client/webmcp-result.ts:116` build URLs for tool output and open no
connection. The modules the six import, `src/client/assemble-prompt.ts` (DOM reading only),
`src/shared/web-audit-findings.ts`, and `src/shared/site-url.ts`, contain no network call either. The fourteen other
client modules do talk to the origin, `src/client/live-score.ts:193` POSTs `/api/score` and
`src/client/web-audit-scoring.ts:192` POSTs `/api/audit-web`, but no WebMCP tool reaches either. KTD15's claim holds.

**What the seam cannot see.** The browser's agent lists tools through an internal mechanism, not `getTools()` (spec
section 4.2), so listing is invisible. An agent that reads the page through the accessibility tree or a screenshot and
never calls a tool is invisible. Tools registered on other origins are out of scope by permissions policy (the `tools`
feature defaults to `'self'`, spec section 4.5). The spec's `toolactivated` event, which would be a page-level
alternative to wrapping, is unspecified (section 3.1, "Specify and fire the toolactivated event", issue 146); the
specified events are `toolchange` and `toolcanceled` (section 4.4), neither of which fires on a call. A future
`toolactivated` event would be equivalent to the wrapper for imperative tools and would add declarative form-based
tools, of which the site registers none (`rg -n "toolname|toolautosubmit" src/build/ src/client/` is empty).

## 2. How `form.submit()` surfaces server-side, and whether it generalizes

`openWebAudit` optionally fills `[data-web-home-input]`, then calls `form.submit()` on `[data-web-home-form]`
(`src/client/webmcp-home.ts:33-42`). That form is `<form method="get" action="/web-audit">` with `<input name="url">`
(`src/build/06-homepage.mjs:213-214`), so the browser issues `GET /web-audit?url=<value>` as a top-level document
navigation that unloads the homepage.

At the origin the request enters `default.fetch` (`src/worker/index.ts:1007-1010`) and `classifyGatewayRequest`, which
classifies HTML versus markdown and deletes the User-Agent from the HTML class before the cached inner Worker runs
(`src/worker/accept.ts:190-222`). The `page.request` record U10 adds at that gateway would show path `/web-audit`,
status, served format `html`, client class `browser`, and the human's browser family, version, engine, and OS. Nothing
in that record, and nothing on the wire, marks the agent:

- `Sec-Fetch-Mode: navigate`, `Sec-Fetch-Dest: document`, `Sec-Fetch-Site: same-origin`, and `Referer` are identical to
  a human pressing Audit on the same form.
- `Sec-Fetch-User: ?1` is sent only for navigations triggered by user activation
  (https://w3c.github.io/webappsec-fetch-metadata/#sec-fetch-user-header). An agent-driven `form.submit()` outside an
  activation window lacks it, but so does every script-driven navigation the site performs itself
  (`src/client/live-score.ts:230,325,331`, `src/client/web-audit.ts:85`, `src/client/web-audit-scoring.ts:109,218`,
  `src/client/surface.ts:98`), and so does a human whose activation expired. The Worker reads no `Sec-Fetch-*` header
  today (`rg -n "Sec-Fetch|sec-fetch" src/worker/` is empty). The absence means "script-initiated", never
  "agent-initiated".
- The `url=` query string is the tool's argument value verbatim. U10 records the path; it must not record the query
  string, or the record carries argument content by the back door.

**Generalization: it does not.** The signal exists only for tools whose effect is a navigation or a request, which is
one tool in fifteen. The human-completed flows do not help either: after `fill_audit_url`
(`src/client/webmcp-audit.ts:5-11`) the human clicks Audit and `src/client/web-audit-scoring.ts:192` POSTs
`/api/audit-web` with a Turnstile token; after `fill_cli_target` the Score flow POSTs `/api/score` the same way. In
both, the request is a human's request in every server-observable respect. Origin traffic is the wrong place to look for
co-browsing; only the client seam sees it.

## 3. Name, arguments, and outcome at the seam, without touching argument content

**Name: yes.** `tool.name` is on the object the wrapper closes over (`src/client/webmcp-lib.ts:25`). The set is closed
and fixed at build time: the fifteen names above.

**Arguments: observable, and must not be recorded.** The wrapper receives the input object the browser parsed from the
agent's JSON string (spec section 3.1). Its values are user intent: `text` up to 200 characters for `set_plan`
(`src/client/webmcp-audit.ts:13-21`), free `text` for `fill_cli_target` (`src/client/webmcp-home.ts:17-23`), `url` for
`fill_web_target`, `open_web_audit`, and `fill_audit_url`, and `id`, `ids`, `keywords`, `statuses`, `offset`, `limit`
for the result tools (`src/client/webmcp-result.ts:282-291`). Key names could be recorded without values, but every
`inputSchema` fixes its keys with `additionalProperties: false` (for example `src/client/webmcp-home.ts:49-56`), so key
names add nothing the tool name does not already say. Record nothing about arguments, not even their shape.

**Outcome: three classes at no cost, a fourth with a refactor.** `execute` settles with a DOMString, rejects, or is
aborted through `options.signal` (spec section 4.2.2). Those three are observable without reading the result. Below
that, the tools use two conventions: the result tools return JSON envelopes with `ok: true` or `ok: false`
(`src/client/webmcp-result.ts:69-71`; `src/client/webmcp-lib.ts:96-113`), while the home, audit, and orientation tools
return sentences in which a validation miss reads `url must be a string.` (`src/client/webmcp-home.ts:26`). A wrapper
can classify the envelopes reliably and the sentences only by convention. A uniform `ok | invalid | error | aborted`
outcome needs the tool functions to return a typed result and let the registration layer stringify it, a refactor
confined to `src/client/` that no backend has to wait on.

**Duration: yes, coarsely.** Wall-clock around `execute` is available. The tools are synchronous DOM reads, so a bucket,
not a millisecond value, is the honest field.

**Page: yes, as a route class.** `pathname` is in scope at registration (`src/client/webmcp-lib.ts:187`) and the
existing predicates yield `home`, `web-audit`, `web-result`, or `orientation` (`src/client/webmcp-lib.ts:56-72`). The
concrete `/web/<domain>` path names an audited domain; the route class suffices, because every tool name already implies
its route.

## 4. Agent identity: knowable client-side, or only that an agent acted

**Not knowable.** `ToolExecuteCallbackOptions` has exactly one member, `signal` (spec section 4.2.2), and
`ModelContextTool.execute` receives `(inputObject, options)` (section 4.2.1). `ModelContextRegisterToolOptions`
(`exposedTo`, `signal`; section 4.2.3) and `ModelContextExecuteToolOptions` (`signal`; section 4.2.5) add nothing. No
member names the agent, the model, the AI platform, or the extension. The spec defines an "agent" and a "browser's
agent" that may be built into the browser or hosted through an extension (section 2), and the API does not tell them
apart.

**An execution is the primitive, and "an agent acted" is an inference from it.** `execute` can be invoked by the
browser's agent, by any same-origin script through `document.modelContext.executeTool()` (section 4.2), by an extension
content script, and by the site's own tests (`tests/webmcp.test.ts:614-620`). The strongest statement the client can
make is "a registered tool was executed on this page". Nothing distinguishes a human-directed agent from an automated
one, or an agent from a script.

**The environment describes the human's browser.** `navigator.userAgent` and the client hints belong to the browser the
human is using; a browser-hosted agent shares them. The gateway classifies the co-browsing pair as `browser` with the
human's family and version (U11, U12). That is correct and is all it can do.

**Capability presence is not presence.** `probeModelContext` returning a context (`src/client/webmcp-lib.ts:192-208`)
proves the browser exposes WebMCP, not that an agent is attached. Which surface answered, `document.modelContext` or the
deprecated `navigator.modelContext` (`src/client/webmcp-lib.ts:198-199`), says which implementation generation the
browser runs, not which agent. Chromium's `Sec-CH-UA` brand and version, which U11 reads, already tell the server which
browsers can carry WebMCP, so a capability share needs no beacon.

The parent plan's "Agent product name" row for A4 is therefore `no`, not `pending`.

## 5. What an ingest endpoint would cost

**The write surface today.** POST is accepted at `/api/score` (`src/worker/score/handler.ts:90`), `/api/audit-web`
(`src/worker/audit-web/route.ts:3,163`), `/api/web-rescore` and `/api/web-audit-backfill`
(`src/worker/audit-web/rescore-trigger.ts:93,110`; dispatched at `src/worker/index.ts:430,436`), `/mcp`
(`src/worker/index.ts:568-620`), and `/oauth2/token`, which answers with a typed no-auth explanation
(`src/worker/index.ts:484-487`). The first two sit behind a kill switch, Turnstile siteverify, a session cookie minted
on the Turnstile pass, a session-keyed limiter, and a per-IP fallback limiter (`src/worker/score/handler.ts:433-520`;
`src/worker/audit-web/route.ts:231-300`). The rescore pair requires a shared secret header
(`src/worker/audit-web/rescore-trigger.ts:76-91`). `/mcp` is open and per-IP rate-limited with an `anon` fallback
(`src/worker/index.ts:707-715`; `wrangler.jsonc:150-160`). The unit text's "only two `/api/` POST routes" undercounts by
two, but its conclusion stands: nothing accepts a fire-and-forget event, and an ingest is new surface.

**What the existing gates can offer a beacon.**

- *Turnstile: nothing.* Invisible Turnstile acquires its token on the form's submit gesture and has no interactive
  fallback (`src/client/turnstile.ts:1-7`). A tool callback runs on the webmcp task source with no user activation (spec
  section 5.1), so a Turnstile-gated beacon fails closed for exactly the traffic it exists to measure.
- *Session cookie: nothing useful.* `__Host-anc-session` is minted only after a Turnstile pass on `/api/score` or
  `/api/audit-web`, with a one-hour TTL (`src/worker/score/session.ts:1-21`; `src/worker/audit-web/route.ts:242-259`).
  Gating on it collapses coverage to post-audit sessions and adds a linkage the record then has to scrub.
- *Per-IP limiter: yes.* The `MCP_LIMITER` pattern, keyed on `cf-connecting-ip` with an `anon` fallback because a small
  anonymous flood of trivially cheap writes is recoverable (`wrangler.jsonc:150-160`).
- *Allowlist: yes.* A closed set of fifteen names and a closed outcome set, checked before any write, unknown values
  rejected with no write. The corpus already records this shape and its abuse posture
  (`docs/solutions/design-patterns/cookieless-allowlisted-event-beacon-for-analytics-engine.md`;
  `docs/solutions/design-patterns/bound-agent-native-endpoint-with-rate-limit-and-allowlist-not-origin-check.md`).

**Itemized cost of an open ingest.**

1. One route branch in `src/worker/index.ts` beside the `/api/` dispatch (`src/worker/index.ts:425-440`), one handler
   module, one test file.
2. One rate-limit binding, declared twice: the top-level `ratelimits` block and the staging block, each with its own
   namespace id (`wrangler.jsonc:130-175`, `385-410`).
3. One emitter scope, `webmcp.tool`, through `src/worker/telemetry/` so the record lands in the same live, zone, and
   archive tiers the posture page discloses. A separate Analytics Engine dataset on the `SCORE_TELEMETRY` model
   (`wrangler.jsonc:214-225`; `src/worker/score/telemetry.ts:1-42`) would work but adds a fourth store.
4. A client wrapper at the `bindModelContext` seam sending `navigator.sendBeacon('/api/<event-route>', ...)`.
   `sendBeacon` matters for `open_web_audit`: `form.submit()` unloads the page, and a beacon survives that. The reporter
   must be injectable through `InitWebMcpHost` (`src/client/webmcp-lib.ts:42-46`) so tests pass a stub.
5. No CSP change: `connect-src 'self'` already admits a same-origin beacon (`src/worker/headers.ts:127`).
6. A `content/privacy.md` change, which the page commits to whenever collection changes (`content/privacy.md:66-69`),
   and the A4 rows in the parent plan's datapoint table.
7. Surrender of a pinned property. `tests/webmcp.test.ts:600-623` asserts `execute` never calls `fetch`, and
   `src/client/webmcp-result.ts:1-3` states "no fetch, no form submission, no navigation". The property KTD15 rests on
   is given up on purpose; the test keeps its meaning only if the wrapper is the sole network path and is stubbed in the
   test.
8. Abuse. An open POST is spoofable by any client, so counts are directional. The limiter bounds volume, the allowlist
   bounds cardinality, the fixed record shape bounds storage, and the per-event cost in Workers Logs is negligible. The
   exposure is data quality, not money.
9. R5. The handler reads `cf-connecting-ip` for the limiter key and discards it. No IP, User-Agent, or cookie reaches
   the record, and the parent plan's AE3 acceptance test extends to the new scope.

## 6. The privacy surface of a beacon on a co-browsed page

- **A new datapoint class about the human.** The beacon reports that an AI agent acted in the human's browser on the
  page the human is viewing. That is a fact about the person's tooling. It is reported in aggregate only, and published
  as shares, never counts (`content/privacy.md:64`).
- **Argument content is user intent and never leaves the page.** Target URLs are domains a person means to audit,
  possibly unlaunched ones; `set_plan` text is free prose. The beacon carries tool name, outcome, route class, and a
  duration bucket. Nothing else.
- **Tool results never leave the page either.** They carry page content and the filled URL (`getPageState`,
  `src/client/webmcp-lib.ts:133-147`) and go to the agent, not to the beacon.
- **The wire carries the human's IP and User-Agent to the edge.** Both are derived from and discarded, as for every
  other request (`content/privacy.md:24-25`). No Turnstile in the path means no `remoteip` is forwarded to siteverify
  for this request (`src/worker/score/turnstile.ts:49`).
- **The session cookie rides along and must be ignored.** A same-origin POST carries `__Host-anc-session` when the
  visitor holds one (`SameSite=Lax; Path=/`, `src/worker/score/session.ts:53`). The handler reads no cookie and the
  record carries no session id, so the beacon adds no cross-window linkage. Within-window joins to `page.request`
  through the journey key are already disclosed (`content/privacy.md:18-20`).
- **Nothing hidden from the human is reported.** Every tool effect lands in the human's own DOM (`set_plan` writes a
  visible status, `src/client/webmcp-audit.ts:16-20`). The beacon reports less than the page shows.
- **No third party.** Same origin only. The Cloudflare Web Analytics beacon is a separate, cookieless instrument
  (`content/privacy.md:45-49`).
- **Fire on execution, never on load.** A page-load "capability ping" would beacon from every WebMCP-capable browser on
  every page view with no agent attached: volume for nothing, and a fingerprint-adjacent signal the client hints already
  give U11.

## What is observable, what is not, and what each option costs

| Signal                            | Observable      | Where                      | Cost                   |
| --------------------------------- | --------------- | -------------------------- | ---------------------- |
| `open_web_audit` navigation       | yes, unmarked   | `page.request`             | zero once U10 lands    |
| Tool name (closed set of 15)      | yes             | client seam                | beacon                 |
| Outcome: settled/rejected/aborted | yes             | client seam                | beacon                 |
| Outcome: ok vs invalid input      | partial         | client seam                | beacon + typed results |
| Duration bucket                   | yes             | client seam                | beacon                 |
| Route class                       | yes             | client seam                | beacon                 |
| Co-presence (execution on page)   | yes, as a ratio | beacon over `page.request` | beacon                 |
| WebMCP-capable browser share      | yes             | `Sec-CH-UA` through U11    | zero                   |
| Argument content                  | yes, forbidden  | client seam                | never captured         |
| Agent product name                | no              | nowhere                    | not capturable         |
| Human-directed vs automated agent | no              | nowhere                    | not capturable         |
| Agent reads page, calls no tool   | no              | nowhere                    | not capturable         |
| Tools listed but not called       | no              | nowhere                    | not capturable         |

Options, lettered as the recommendation refers to them:

| Option                      | Covers                      | New surface             | Gives up                     |
| --------------------------- | --------------------------- | ----------------------- | ---------------------------- |
| A. Navigation only          | 1 of 15, unmarked           | none                    | 14 tools, outcomes, presence |
| B. Fetch Metadata           | nothing reliable            | none                    | reliability (section 2)      |
| C. Marker query parameter   | 1 of 15                     | URL marker in history   | 14 tools                     |
| D. Metered-POST piggyback   | tools before a metered POST | field on 2 gated routes | most sessions                |
| E. Turnstile+session gate   | near zero                   | route, limiter, gates   | coverage (no gesture)        |
| F. Allowlisted-event beacon | 15 tools, outcome, presence | route, limiter, scope   | identity, args, spoof-proof  |

## Recommendation: allowlisted-event beacon

Build F, and nothing else. The shape:

- **Client.** A wrapper installed at the `bindModelContext` seam (`src/client/webmcp-lib.ts:174-182`) times each
  `execute`, classifies its outcome as `ok`, `invalid`, `error`, or `aborted`, and reports `{ tool, outcome, route,
  ms_bucket }` through `navigator.sendBeacon` to a same-origin route. The reporter is injected through `InitWebMcpHost`,
  defaults to a no-op outside a browser, never throws into the tool, and fires only on execution. The `ok | invalid`
  split requires the typed-result refactor from section 3; until it lands, the wrapper reports `settled | error |
  aborted`.
- **Server.** One POST route under `/api/`: method check, body cap of a few hundred bytes, closed allowlists for `tool`,
  `outcome`, and `route` with unknown values rejected and nothing written, a dedicated per-IP rate-limit binding with an
  `anon` fallback, no cookie read, no Turnstile, and a bodyless `204` with `cache-control: no-store`. The handler emits
  one `webmcp.tool` record through the structured-log emitter carrying the four beacon fields plus the gateway's derived
  client fields (class, browser family, `major.minor`, engine, OS) from ambient request context, and never an IP,
  User-Agent, cookie, argument, or result.
- **Reporting.** Shares only: executions by tool, outcome share by tool, and executions per hundred `page.request`
  records on each tool-bearing route as the co-presence proxy. Absolute counts are directional because the route is
  open.
- **Disclosure.** A bullet under "What the site derives from a visit" in `content/privacy.md` naming the four fields and
  stating that no tool argument or result is sent, landing in the same change as the route.
- **Sequencing.** After U10 (`page.request` is the denominator) and the emitter units U0 through U2 (the scope needs the
  emit path). The parent plan's A4 rows become: agent product name `no`; MCP method and outcome `yes (beacon)`;
  co-presence signal `yes (ratio)`.

### What it deliberately gives up

- Agent identity, in every form. The API does not carry it and nothing on the wire does.
- Argument content and argument shape. User intent stays on the page.
- Tamper resistance. Any client can post allowlisted events; the numbers are directional and published as shares.
- Agents that read without calling a tool, and tools listed but never called. Invisible by construction.
- Distinct-visitor counts. No identifier exists, so the co-presence signal is a ratio of events to page views, not a
  share of visitors.
- The "no network calls" property of the WebMCP modules, traded for the one beacon path, which the test suite pins as
  the only one.
- Capability pings on page load. Browser capability share comes from client hints at no cost.

### Rejected shapes

- **A, navigation only.** Measures one tool, cannot separate it from human submissions, and leaves A4 invisible forever.
  It is the baseline U10 delivers anyway, not a co-browsing backend.
- **B, Fetch Metadata heuristics.** `Sec-Fetch-User` absence marks script-initiated navigations, of which the site
  already performs six kinds on its own (section 2).
- **C, a marker query parameter.** Puts a tracking token in the human's URL bar, history, and Referer to count one tool.
- **D, piggyback on the next metered POST.** Changes the contract of two Turnstile-gated endpoints, records only
  sessions that go on to spend budget, and mixes telemetry into request bodies the abuse gates parse.
- **E, Turnstile and session gating.** Turnstile has no gesture to bind to inside a tool callback, and the session
  cookie exists only after a metered request. Highest cost, near-zero coverage.

## Corrections the plan text needs

- The unit's "only `/api/` POST routes" list omits `/api/score` and `/api/audit-web`, both gated POST routes (section
  5). The narrower point, that no open beacon exists, holds.
- U10's `page.request` must record the path and never the query string; for `/web-audit?url=` the query is a tool
  argument value (section 2).
- KTD15's "an agent acting on a loaded page" is one step removed from the primitive: what the client can attest is that
  a registered tool was executed, by an agent, a script, or an extension (section 4).
- A4's "Agent product name" is `no`, not `pending spike` (section 4).
