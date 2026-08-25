---
title: Restore edge HIT on negotiated HTML and markdown
type: requirements
status: captured
date: 2026-08-25
canvas: ~/.cursor/projects/home-brett-dev-agentnative-site/canvases/edge-hit-miss-matrix.canvas.tsx
note: Confirmations closed. Requirements-only unified plan is docs/plans/2026-08-25-1613-feat-edge-hit-restore-plan.md.
---

# Restore edge HIT on negotiated HTML and markdown

## Problem

After #265 / #266, negotiated HTML and markdown skip Cloudflare shared-cache reuse (`Cloudflare-CDN-Cache-Control:
no-store`, no `s-maxage`) so clients see `Vary: Accept, User-Agent`. That made `markdown-vary` a real SHOULD pass on
`anc.dev`. First-view and agent TTFB no longer get a long edge HIT. Bake-at-build pages (`/scorecards`, `/about`,
principles) pay that cost even though their bodies only change on deploy. Live web-board URLs (`/`, `/web`,
`/web/<domain>`) must not freeze behind a day-long HIT.

This unit restores edge HIT **without** repeating the 2026-08-25 production bug: a HIT that omitted `Vary`.

## Success

- Curl vs browser markdown negotiation stays on extensionless URLs.
- A cache HIT on a negotiated URL still shows `Vary: Accept, User-Agent` to the client. A cache-key-only fix that leaves
  `Vary` absent does not ship.
- `markdown-vary` stays a SHOULD on `GET /` and continues to fail loudly when `Vary` is missing or is only
  `Accept-Encoding` plus `User-Agent`.
- Live web-board surfaces HIT for minutes and purge when the R2 aggregate or that domain's audit is rewritten. They do
  not sit on a day-long TTL.
- Explicit `.md` is path-keyed like `.txt` (no `Vary`), except homepage and `/web` twins that carry live board rows.

## Session-settled decisions

1. Assume #265/#266 are on production before this work. (session-settled: user-directed — chosen over designing against
   the pre-Vary Worker.)
2. Explicit `.md` is one representation. Drop `Vary` on those URLs and restore edge HIT like `.txt`, except homepage /
   `/web` twins that carry live boards. (session-settled: user-directed — chosen over keeping `Vary` on every markdown
   response.)
3. This unit includes **both** path-keyed `.md` HIT **and** negotiated extensionless HIT, except the overrides below.
   (session-settled: user-directed — chosen over splitting Cache Rules / UA-key to a later unit.)
4. Approach: **format-class edge cache**. Keep curl-vs-browser negotiation. Key HIT on a tiny agent-vs-browser class
   plus `Accept`. HIT must still show `Vary`. Rejected: Accept-only (bare curl would get HTML) and a Worker-owned second
   cache. (session-settled: user-directed — chosen over Accept-only and origin-owned variants.)
5. Homepage HTML **and** all homepage markdown (negotiated `/` and `/index.md`) include CLI + web board slices, share a
   **short** edge TTL, and purge when the R2 board aggregate is rewritten. Drop homepage HTML `no-store` so browser and
   curl stay in sync. Do not ESI/split the board out of the HTML. (session-settled: user-directed — chosen over HTML
   live / markdown TTL and over keeping both `no-store` until purge is proven.)
6. CLI bake-at-build (`/scorecards`, `/score/<tool>`, spec pages) may long-HIT and purge on deploy. Web R2 surfaces
   share the homepage short-TTL + purge class. (session-settled: user-directed.)
7. Do not move `markdown-vary` off `GET /`. (session-settled: user-directed.)

## Planned edge HIT vs MISS

Encoded from the canvas the user accepted (`edge-hit-miss-matrix`). Three classes:

| Class   | Edge | TTL             | Evict                        |
| ------- | ---- | --------------- | ---------------------------- |
| HIT 1d  | HIT  | ~1 day edge     | purge on deploy              |
| HIT min | HIT  | minutes (short) | purge on board / audit write |
| MISS    | MISS | CDN `no-store`  | every request                |

Negotiated URLs keep curl-vs-browser markdown. Explicit `.md` is path-keyed except where the twin carries live board
rows. A HIT that omits `Vary` does not ship.

**Homepage is one cache object.** `/` HTML contains the CLI pane (build-time) and the web pane (R2). Those panes cannot
have different edge TTLs. The whole homepage uses the web class: short HIT plus purge when the board aggregate is
rewritten.

### How to read curl vs browser

On an extensionless URL, `Accept` and `User-Agent` pick HTML vs markdown. Browser with `Accept: text/html` gets HTML.
Default curl (`User-Agent: curl/…`, `Accept: */*`) gets markdown. Both variants HIT independently once the cache keys on
a small agent-vs-browser class, not the raw `User-Agent` string. Fetching `/about.md` skips negotiation: always
markdown, HIT like `/llms.txt`, no `Vary`.

### CLI boards (bake at build)

Change only on deploy, except homepage HTML which is shared with the live web pane. Browser = HTML. curl with default UA
= markdown. Explicit `.md` never negotiates to HTML. `/check.md` is a 301.

| Surface                  | URL             | Browser (HTML)   | curl (markdown UA) | Explicit `.md`                 |
| ------------------------ | --------------- | ---------------- | ------------------ | ------------------------------ |
| Homepage CLI + web panes | `/`             | HIT min          | HIT min            | `/index.md` HIT min, no `Vary` |
| CLI leaderboard          | `/scorecards`   | HIT 1d           | HIT 1d             | HIT 1d, no `Vary`              |
| Per-tool scorecard       | `/score/<tool>` | HIT 1d           | HIT 1d             | HIT 1d, no `Vary`              |
| Legacy `/check` twin     | `/check.md`     | 301, max-age 300 | 301                | 301                            |

### Web boards (R2 at request time)

Same remote class as homepage: short edge TTL, purge when the aggregate or that domain's audit is rewritten.
`/web/scoring*` stays `no-store` so an in-flight audit never HITs a previous shell.

| Surface             | URL             | Browser (HTML) | curl (markdown UA) | Explicit `.md`     |
| ------------------- | --------------- | -------------- | ------------------ | ------------------ |
| Web leaderboard     | `/web`          | HIT min        | HIT min            | HIT min, no `Vary` |
| Per-site result     | `/web/<domain>` | HIT min        | HIT min            | HIT min, no `Vary` |
| Homepage web pane   | `/`             | HIT min        | HIT min            | HIT min, no `Vary` |
| In-progress scoring | `/web/scoring*` | MISS           | MISS               | MISS               |

### Spec and docs pages (no live board)

Negotiated HIT uses a tiny agent-vs-browser cache class plus `Accept`. HIT must still send `Vary: Accept, User-Agent`.
Explicit `.md` drops `Vary`.

| Surface                         | URL           | Browser (HTML) | curl (markdown UA) | Explicit `.md`    |
| ------------------------------- | ------------- | -------------- | ------------------ | ----------------- |
| About / install / skill / audit | `/about`      | HIT 1d         | HIT 1d             | HIT 1d, no `Vary` |
| Principle page                  | `/p1` … `/p8` | HIT 1d         | HIT 1d             | HIT 1d, no `Vary` |
| MCP skill (HTML/md)             | `/mcp-skill`  | HIT 1d         | HIT 1d             | HIT 1d, no `Vary` |
| GET `/mcp` as a page            | `/mcp`        | HIT 1d         | HIT 1d             | HIT 1d, no `Vary` |
| Explicit `.html`                | `/about.html` | 301            | 301                | n/a               |

### Path-keyed assets and always-MISS APIs

These URLs are one representation. curl vs browser does not change the body. No `Vary`. Already true after #265 for
`.txt` / `.json` / `.svg` / fonts.

| Surface             | URL           | Browser            | curl               | Notes                            |
| ------------------- | ------------- | ------------------ | ------------------ | -------------------------------- |
| llms index          | `/llms.txt`   | HIT 1d             | HIT 1d             | Not rewritten to `.md`           |
| JSON / SVG          | `/skill.json` | HIT 1d             | HIT 1d             | Same for badges `.svg`           |
| Fonts / OG          | `/fonts/*`    | HIT immutable year | HIT immutable year | Hashed / immutable; new URL      |
| Most explicit `.md` | `/about.md`   | HIT 1d, no `Vary`  | HIT 1d, no `Vary`  | Except homepage and `/web` twins |
| POST `/mcp`         | `/mcp`        | MISS               | MISS               | Transport, not a page            |
| Live score JSON     | `/api/score`  | MISS               | MISS               | Same for `/api/audit-web`        |

## Grounded facts (do not re-litigate)

- Worker today: HTML + served markdown use `NEGOTIATED_CACHE` (no `s-maxage`) + `Cloudflare-CDN-Cache-Control: no-store`
  - `Vary: Accept, User-Agent`. JSON/SVG/untwinned `.txt` keep `SHORT_CACHE` with `s-maxage=86400`. Fonts/OG are
    immutable. (`src/worker/headers.ts`)
- Explicit `.md` is always markdown except `/check.md` → 301 `/audit.md`.
- `index.md` currently has no live board; homepage HTML injects `{{WEB_BOARD_ROWS}}` from R2. Putting CLI + web slices
  into every homepage markdown representation is **in scope** (settled #5).
- `/web` and `/web.md` render from R2 then `applyHeaders`. `/web/<domain>` uses the negotiated class. Extra `no-store`
  is `/web/scoring*` only.
- `putAggregate` writes R2 only. No zone purge. No `Cache-Tag` on negotiated responses.
- `wrangler.jsonc` has no Workers Caching `cache.enabled` and no Cache Rules.
- `markdown-vary` is recommended (SHOULD) on `GET /`.
- `DESIGN.md` still documents HTML/`.md` `s-maxage=86400`.
- Cloudflare Cache Rules can honor origin `Vary` (shipped 2026-07-02, all plans): per-header `normalize` / `passthrough`
  / `bypass`. Purging a URL purges **all** `Vary` versions of that URL.
- Cache Rules `normalize` is semantic for `Accept` / `Accept-Language` / `Accept-Encoding` only. For `User-Agent`,
  `normalize` is whitespace-join, `passthrough` shards on every UA string, `bypass` means do not cache whenever `Vary`
  lists `User-Agent`. The canvas class is **not** something Cache Rules can derive from the raw UA.
- Zone Cache Rules do **not** apply to Workers Caching. `ctx.cache.purge()` does not clear the zone cache, and zone
  purge does not clear Workers Caching.
- Purge by URL, hostname, tag, prefix, and purge-everything are available on all plans (2025-04-01). Prefix `/` is too
  broad. Prefix `/web` also matches `/web/scoring*` (acceptable: those stay `no-store`). Homepage `/` needs a URL or a
  tag, not a prefix of `/`.
- Custom cache keys: dashboard single-file purge often cannot replay the key; purge by tag or prefix is the reliable
  evict.

## Characterization spike (2026-08-25)

`anc.dev` is a Free Website zone. `run_worker_first` is true. Workers Caching is not enabled in `wrangler.jsonc`. The
Wrangler API token can list the zone and cannot read Cache Rules (rulesets 10000). A break-glass Global API Key can. The
`http_request_cache_settings` phase had **no** entrypoint (no Cache Rules).

Post-266 `cf-cache-status: HIT` on negotiated HTML/markdown is **Static Assets**, not a zone HIT that skipped the
Worker.

Evidence:

- Asset-backed paths (`/`, `/about`, `/p1`, `/about.md` after warmup) return `HIT` plus Worker headers (`Vary`,
  `Cloudflare-CDN-Cache-Control: no-store`, no `s-maxage`). `/about.md` also returns an asset `ETag`. Cloudflare docs:
  Static Assets attach `CF-Cache-Status` for whether **the asset** was cached. `run_worker_first` still runs the Worker,
  which stamps `Vary`. That is why HIT and `Vary` coexist with `no-store`. Docs also say this header can be a false
  positive.
- Worker-generated paths (`/web`, `/web/anc.dev`, HTML/markdown 404) return **no** `cf-cache-status`. The Worker ran.
  Zone cache did not store the response (`no-store` doing its job).
- Path-keyed `/llms.txt` and `/skill.json` HIT with `s-maxage=86400` and no `Vary` (the SHORT_CACHE class).
- Negotiation still works under asset HIT: `/about` browser HTML body ≠ curl markdown body; curl UA and `Accept:
  text/markdown` match `/about.md`.

### Zone Cache Rule canary (created and deleted the same session)

Created a one-rule zone ruleset matching only `/about` and `/about/`: `cache: true`, `edge_ttl.override_origin` 120s,
Vary `accept=normalize` and `user-agent=passthrough`. Curled three browser HTML generations and two curl markdown
generations. Deleted the ruleset. Confirmed gone (entrypoint 10003).

Result: **no observable change.** Still asset `HIT`, asset `ETag`, `Vary: Accept, User-Agent`,
`Cloudflare-CDN-Cache-Control: no-store`, **no `Age`**. Bodies did not cross-serve. `/p1` looked the same.

Why: on a Custom Domain Worker, the Worker runs **before** the zone cache. Zone Cache Rules cannot skip
`run_worker_first`. The skip-Worker HIT the canvas wants is **Workers Caching** (`cache.enabled` in wrangler): a cache
in front of the Worker that honors the Worker's `Cache-Control` and `Vary`. Zone Cache Rules do not apply to that cache.

Workers Caching stores a variant per **exact** `Vary` header value (no UA class). `Vary: User-Agent` shards on every UA
string unless a gateway normalizes the request before the cached entrypoint. `no-store` / missing `s-maxage` keeps that
cache empty until the Worker stops sending `no-store`. Staging `*.workers.dev` **can** test this (the cache follows the
Worker). That canary needs a Worker deploy, not a Cache Rule.

What this means for the canvas: today's HIT does **not** skip Worker CPU, `applyHeaders`, or homepage R2 board inject.
Dropping `no-store` without Workers Caching does not restore canvas HIT. A Cache Rule-only fix does not sit in front of
this Worker.

### Workers Caching staging canary (deployed and rolled back the same session)

Short-lived staging-only deploy. `env.staging.cache.enabled = true`. Dropped `Cloudflare-CDN-Cache-Control: no-store` on
negotiated `/about` only. Stamped `X-Worker-Ran` (epoch ms) so a skip-Worker HIT is distinguishable from Static Assets
HIT. Deployed with wrangler **4.124.0** (`--containers-rollout=none`). Then-pinned repo wrangler **4.81.0** dry-run
accepted the `cache` key and did not enable Workers Caching (schema has no `cache` block). Rolled back to version
`f8448633-b094-4578-ba4d-105e7ef54b72`. Post-rollback `/about` is again asset `HIT` + `no-store` + `Vary`, no `Age`, no
`X-Worker-Ran`. Cloudflare Access service-token headers did not bypass the cache.

Result on `https://agentnative-site-staging.brettdavies.workers.dev/about`:

- Browser UA + `Accept: text/html`: first request `MISS` with `X-Worker-Ran: 1787691949457`; second and third `HIT` with
  `Age: 1` then `Age: 2`, **same** `X-Worker-Ran`, `Vary: Accept, User-Agent`, no `Cloudflare-CDN-Cache-Control`.
- Default curl: first request `MISS` with a **different** `X-Worker-Ran` (`1787691951917`); second and third `HIT` with
  `Age`, frozen stamp, `Vary: Accept, User-Agent`, `Content-Type: text/markdown`.
- HTML and markdown bodies did not cross-serve. Curl markdown body matched `/about.md`.
- Control `/p1` and explicit `/about.md` stayed `BYPASS` (`no-store` still set), no `X-Worker-Ran`.
- A second browser UA (Safari vs Chrome) was its own `MISS` then `HIT` with a new stamp. Same HTML body. Exact
  `User-Agent` values shard.
- Chrome UA + `Accept: */*` was a `MISS` (not the Chrome + `text/html` HIT) and still HTML. `Accept` exact values shard
  even when both variants are HTML.

A Workers Caching HIT **does** show `Vary`. Skip-Worker is real (`Age` + frozen `X-Worker-Ran`). The 2026-08-25 strip
was a zone-cache behavior, not a Workers Caching behavior.

### Workers Caching purge spike (deployed and rolled back the same session)

Second staging-only deploy (version `29acd80b-9386-4a00-b9f6-b816d7f55d21`). Same `cache.enabled` plus cacheable
`/about`, `/about.md`, and `/p1` with distinct `Cache-Tag` values (`canary-about`, `canary-about-md`, `canary-p1`).
Secret-gated `POST /_canary/purge` called `ctx.cache.purge()` (`WEB_RESCORE_SECRET`, staging host only). Rolled back to
`f8448633-b094-4578-ba4d-105e7ef54b72`. Post-rollback `/about` is `no-store` again; `/_canary/purge` is 404.

Unauthorized purge (Access token, no rescore secret) returned 401. Both authorized purges returned
`{"success":true,"errors":[]}`.

| After                                 | `/about` HTML+md | `/about?view=canary` | `/about.md` | `/p1` |
| ------------------------------------- | ---------------- | -------------------- | ----------- | ----- |
| Warm                                  | HIT              | HIT (own key)        | HIT         | HIT   |
| `purge({ tags: ["canary-about"] })`   | MISS             | MISS                 | HIT         | HIT   |
| Re-warm                               | HIT              | —                    | HIT         | HIT   |
| `purge({ pathPrefixes: ["/about"] })` | MISS             | MISS                 | MISS        | HIT   |

Tags invalidate every variant that carried the tag, including the query-string object, and leave other tags alone.
`pathPrefixes: ["/about"]` also invalidates `/about.md` because that path starts with `/about`. `/p1` survived both.
`/web?view=curated` is the same shape as `/about?view=canary`: a distinct cache object (query is in the key) that a
shared tag or a path prefix of `/web` would both invalidate.

HIT-min should tag the live-board URLs. Prefix `/` or `/web` over-purges (`/web.md`, `/web/<domain>`, `/web/scoring*` if
those were ever cached). HIT-1d bake-at-build can rely on the default version-in-cache-key (a new deploy starts empty).
Do not enable `cache.cross_version_cache`.

## Outstanding confirmations

Closed. Requirements-only unified plan: `docs/plans/2026-08-25-1613-feat-edge-hit-restore-plan.md`.

1. **Which cache produced the post-266 HIT?** Closed. Static Assets. Worker still runs. Zone cache is not storing
   negotiated HTML/markdown. Workers Caching is off. Zone Cache Rules cannot skip this Worker.
2. **Does a Workers Caching HIT still show `Vary`?** Closed. Staging `/about` HIT kept `Vary: Accept, User-Agent`,
   skipped the Worker, and did not cross-serve HTML vs markdown. A HIT that omits `Vary` is still a stop if production
   ever diverges from this.
3. **How the tiny agent-vs-browser class is represented** without listing raw `User-Agent` in the variant key. Closed
   enough to plan: verbatim UA shards (Chrome vs Safari each populated their own HIT). HIT still forwards client-visible
   `Vary: Accept, User-Agent`. The tiny class needs a gateway that normalizes UA before the cached entrypoint. That
   mechanism is planning, not another product fork.
4. **`Accept` exact-value variants.** Closed enough to plan: `Accept: */*` and `Accept: text/html` are distinct cache
   objects (Chrome + `*/*` missed the Chrome + `text/html` HIT and still served HTML via the UA heuristic). Curl + `*/*`
   is markdown. q-value explosion was not spiked; the same gateway should normalize `Accept`.
5. **Purge wiring for the HIT-min class.** Closed. `ctx.cache.purge({ tags })` invalidates tagged variants including
   query-string objects; other tags stay. `pathPrefixes: ["/about"]` over-purges `/about.md`. Zone purge does not apply.
   Free-tier purge limits apply to Workers Caching regardless of zone plan. `/web?view=curated` is a distinct object.
6. **Purge wiring for the HIT-1d class.** Closed. Workers Caching keys by Worker version by default (new deploy gets an
   empty cache). Canary rollback restored `no-store` immediately. Explicit deploy purge is only needed if
   `cache.cross_version_cache` is on; it should stay off.
7. **Where the skip-Worker canary runs.** Closed. Staging `*.workers.dev` proved Workers Caching. Production `anc.dev`
   is not required for the first proof. Zone Cache Rules are the wrong lever. Enabling `cache` requires wrangler **>=
   4.124** (repo pin was 4.81.0, which ignored the key; bumped to `^4.124.0`).
8. **Exact short TTL.** Closed. HIT-min is `max-age=300` (session-settled: user-directed — chosen over 60 seconds).
9. **`DESIGN.md` / header-contract update** is in scope as documentation of the new classes, not a separate product
   decision.

## Non-goals

- Moving `markdown-vary` off `GET /`.
- ESI or splitting the web board out of homepage HTML.
- Caching `/web/scoring*`, `POST /mcp`, `/api/score`, `/api/audit-web`.
- Accept-only negotiation (bare curl gets HTML).
- A Worker-owned second cache as the primary store.

## Next

Enrich `docs/plans/2026-08-25-1613-feat-edge-hit-restore-plan.md` with `ce-plan` (HOW sections). Do not implement from
the brainstorm file.
