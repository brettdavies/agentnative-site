---
artifact_contract: ce-unified-plan/v1
execution: code
product_contract_source: ce-plan-bootstrap
title: "Scorecard og:video - Plan"
type: feat
status: active
prs: ["#461"]
date: 2026-10-26
topic: scorecard-og-video
---

# Scorecard og:video - Plan

## Goal Capsule

- **Objective:** A scorecard link shared in iMessage or Discord plays a short clip that counts up to the real score and ends on the same card every other platform shows as the still image.
- **Means:** a separate render Worker, fed by a queue, draws every card PNG and clip with the Cloudflare Media Transformations binding (KTD1, KTD2).
- **Authority:** Product Contract requirements win on behavior, Key Technical Decisions win on mechanism, and units override neither.
- **Execution profile:** code. Card-face and storage fixes (U1, U2) land inside PR #461. Everything else lands in one PR stacked on #461. #461 does not merge before that stacked PR. Both merge to `dev` only after Brett approves the batch.
- **Stop conditions:**
  - On staging, the Media binding refuses per-frame-palette GIF input or 1200x630 output. Stop and report: the encoder choice is void.
  - The design shortlist needs a card face the key grammar cannot express (KTD4). Stop and amend KTD4 before building on it.
  - Render CPU measured on staging exceeds the render Worker's `limits.cpu_ms` at the default motion. Stop and re-size before enabling the switch.
- **Who finishes:** the agentnative-site session builds, verifies on staging, and hands both PRs to Brett for merge approval. No agentnative-cli change is needed.

---

## Product Contract

### Summary

Every finished scorecard gets a ~3.5 s MP4 that holds the final card, drains the score to zero, climbs back with an ease-out, and holds. Scorecard pages name the clip in `og:video` once it exists. A standalone render Worker draws both the PNG card and the clip from a queue, so no clip ever renders on a page or crawler request. Website cards show the audit date and CLI cards the tool version, and every visible change mints a new card URL.

### Problem Frame

PR #461 gives every scorecard a 1200x630 PNG card, but a shared link still reads as a static image. The score is the result someone shares, and motion is what makes it register in a chat thread. Of the six priority platforms, only iMessage autoplays `og:video` and only Discord plays it on click. X, LinkedIn, Slack, and Bluesky read `og:image` only, so the PNG stays the card everywhere else. A device test on 2026-10-26 confirmed that a Media Transformations MP4 autoplays in iMessage and plays in Discord with `og:type` `article` and the `og:video` tag set.

Two constraints shape the work. A cold render takes 10 to 12 s, above Discord's 10 s fetch budget, so clips must exist before anyone fetches them. The binding is billed per output second after its beta, so a render must never be something a request can trigger.

### Requirements

**Coverage**

- R1. Every finished scorecard gets a clip: live website and CLI audits, the curated CLI registry, and the curated (seeded) websites. Pending, unscored, and missing targets get none.
- R2. The clip holds the final card, drains the score to zero, climbs back with an ease-out to the real score, and holds. It runs about 3.5 s at 1200x630 with no audio. Its first and last frames show the same card as the PNG; equality is visual, since H.264 is lossy.

**Triggers and cost**

- R3. A clip renders when its audit finishes. Curated cards also render after each deploy and each weekly rescore when their clip is missing or more than 21 days old.
- R4. No clip render or Media binding call starts from a page view, a crawler fetch, or any public request. A crawler fetch of a card that is not yet stored draws that one PNG on demand through the render Worker.
- R5. An operator switch stops new renders without a deploy. Existing clips keep being named and served while it is off.
- R6. Clips expire with the `og/` 30-day lifecycle rule. A live-audited site nobody re-audits loses its clip after 30 days, and its page falls back to the still card.

**Pages and serving**

- R7. A scorecard page names its clip (`og:video`, `og:video:secure_url`, `og:video:type`, `og:video:width`, `og:video:height`) only when the clip for the page's current card exists. `og:image` and `og:type` stay as they are.
- R8. When a clip lands, the scorecard page's edge copy is cleared so the next fetch names it. This includes curated CLI pages.
- R9. The clip URL answers `GET`, `HEAD`, and byte-range requests with `206`, and is cached immutable.

**Card face**

- R10. Website cards show the audit date (`YYYY-MM-DD`, UTC) and CLI cards show the tool version where the spec version is today. The spec version moves to the image description.
- R11. Any change to what a card shows produces a new card URL: score, date or tool version, spec version, or template version.
- R12. Card layout and the motion's color and digit treatment stay swappable pending the design shortlist. Until it lands: the #461 layout, color locked to the final score band, and fixed digit slots.

### Key Decisions

- **One pipeline for every clip, on the Media Transformations binding.** (session-settled: user-directed, chosen over ffmpeg libx264 in CI for curated clips: card logos are found only at runtime, so a CI encoder would rebuild the lookup with a CI secret and a cache.) Governs R1, R3.
- **The binding's MP4 ships as returned.** (session-settled: user-directed, chosen over an ffmpeg faststart encode: both files played in iMessage and Discord in the 2026-10-26 device test.) Governs R2, R9.
- **Curated websites are in scope.** (session-settled: user-directed, added to the confirmed scope.) Governs R1.
- **Date on website cards, tool version on CLI cards.** (session-settled: user-approved, chosen over keeping the spec version on the face, with the weekly re-render of every seeded site shown as the cost.) Governs R10, R11.
- **No sweep over all stored audits.** (session-settled: user-approved, chosen over re-rendering every stored audit before expiry.) Governs R6.
- **www and apex fold at the audit, in a separate plan.** (session-settled: user-directed, chosen over a render-time display check: `www.python.org` should become `python.org` for the whole audit, so boards never carry both.) Cards draw whatever target the audit stored.

### Scope Boundaries

- X player card (`twitter:player`): needs per-domain approval and an iframe page. Not built.
- Audio, animated GIF previews, and an animated `og:image`: no platform in the priority list plays them. Not built.
- Clips on pages other than scorecards. Not built.
- Considered and not built: a dead-letter queue. A failed render recovers on the next audit (live) or the next pass (curated), and every failure is logged. A sustained failure rate in the `og.render` logs would change this call.
- Considered and not built: queue-level dedupe. The render checks for a fresh clip before any binding call, so a duplicate message costs one R2 `head`.

#### Deferred to Follow-Up Work

- www/apex fold at audit level, with the matching change in the agentnative-cli web-audit port.
- Applying the design shortlist (layout, motion color, digits): a template-version bump under KTD4 plus the visual review the repo requires.

### Success Criteria

- A link to a site audited a minute earlier, pasted into iMessage, autoplays the clip. The same link in Discord plays it on click.
- The live `og-cards` smoke passes on staging with its clip assertions, and the curated pass leaves no curated scorecard without a fresh clip.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **A separate render Worker owns all drawing.** `anc-og-render` (staging `anc-og-render-staging`) draws the PNG, looks up the logo, renders frames, encodes the GIF, and calls the binding. The site Worker keeps data loading, card keys, public routes, page tags, and queue jobs. (session-settled: user-directed, chosen over a queue consumer inside the site Worker. One isolate serves concurrent requests on a single thread and shares 128 MB, so seconds of rendering there would stall page requests: https://developers.cloudflare.com/workers/reference/how-workers-works/ and https://developers.cloudflare.com/workers/platform/limits/#memory.) The `CONTEXT_DEV_API_KEY` secret, resvg-wasm, and the card fonts leave the site Worker.
- KTD2. **Two queues and one service binding, with no cycle.**
  - The site produces to `og-render`, and the render Worker consumes it.
  - Queues are account-wide and named once, so staging uses `og-render-staging` and `og-rendered-staging` while production uses `og-render` and `og-rendered`. The per-environment render Workers (`anc-og-render`, `anc-og-render-staging`) do not isolate a queue they both name.
  - The render Worker produces to `og-rendered`, and the site consumes it to purge page tags. Purge only works inside the site's `Cached` entrypoint (`src/worker/audit-web/hit-min-purge.ts`).
  - The site calls the render Worker over a service binding only to draw an on-demand PNG. That RPC applies the same template-version check as the queue: on a mismatch it returns a typed skew outcome, which the PNG route serves as its existing `503` without storing.

  Deploy order: create the queues once, deploy the render Worker, then deploy the site Worker (https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/#deployment).
- KTD3. **Card inputs travel in the message.** The site builds them with `loadScoreOgSubject` at enqueue time, because it holds `ASSETS`, the registry, and the records. The message carries the target, lane, card key, card fields, logo pages, and scored-at instant. The render Worker never reads site records.
- KTD4. **Card key grammar: `s<pct>-v<spec>-<edition>-r<template>`.**
  - The edition is `d<YYYYMMDD>` for web (UTC, from `scored_at`).
  - For CLI it is `t<tool version>`, sanitized to the key alphabet and hashed when it does not fit.
  - For a branch target it is `g<short source sha>`.
  - `r<template>` is one constant in `src/shared/score-og.ts`, bumped on any layout or motion change.

  One shared function computes the key, and the page, both routes, the render pass, and the build all call it. This replaces #461's `s<pct>-v<spec>`. #461 is unreleased, so only staging objects carry old keys, and the lifecycle rule clears them.
- KTD5. **Clips get their own prefix, and pruning never deletes newer work.**
  - PNGs stay at `og/score/<sha256(target)>/<key>.png`. Clips go to `og/clip/<sha256(target)>/<key>.mp4`.
  - Both carry `customMetadata` `{target, key, scored_at, template, logo}`, where `logo` is the logo source (`homepage`, `brand`, or `tile`). A stored-card response emits it as `x-anc-card-logo`, so a stored card says where its logo came from.
  - A store prunes only siblings whose `scored_at` is older than its own. Two renders finishing out of order then cannot delete the newer card (#461's `storeCard` deletes every other key).
  - One render job writes the PNG and the clip together.
- KTD6. **A logo lookup that timed out is not stored as a miss.** Only a definitive miss is stored. Otherwise a slow homepage locks the fallback tile in for 30 days (`src/worker/og/find-logo.ts`). The render path also gets a longer budget than #461's crawler path, since it is off the request path. An on-demand PNG whose logo lookup timed out is served with the short `hit-min` cache class and is not stored. Only a PNG drawn after a definitive logo outcome is stored and served immutable, so a crawler can never pin the tile under a URL the clip draws with a logo.
- KTD7. **Frames come from one pure function; encoding follows the spike's settings.**
  - `scoreOgFrames(card, motion)` returns per-frame card states, and the card renderer draws a state.
  - `motion` holds the frame counts, the easing, the color mode, and the digit mode, so the shortlist swaps values, not code (R12).
  - Frame 0 and the last frame are exactly the final card's SVG.
  - The GIF uses a per-frame palette. One palette from the final card renders mid-climb bands grey.
  - The binding call is `transform({width: 1200, height: 630})` then `output({mode: 'video', audio: false})`; without explicit size the binding returns 686x360.
  - `gifenc` is the encoder (MIT, no dependencies; the spike used 1.0.3).
  - The frame loop yields to the event loop after each frame, so an on-demand PNG request that lands in the same isolate waits about one frame instead of the whole render.
- KTD8. **Live renders hook where each scorecard is written; curated renders get their own pass.**
  - Live triggers:
    - web requests: after `cachePut` writes in `src/worker/audit-web/core.ts`, through a queue-then-flush helper shaped like `queueHitMinPurge`;
    - the rescore Workflow: a step after each saved audit;
    - live CLI: after `writeCacheBestEffort` writes in `src/worker/score/do.ts`.
  - The curated pass is its own secret-authed endpoint, called by `deploy.yml` after each deploy and by the weekly cron. It is not a step of the rescore Workflow, because a deploy that joins a running rescore instance would skip the new deploy's keys.
  - The pass reads the registry and the seeds itself. It runs one R2 `head` per curated target, about 150 per pass. It enqueues when the clip is missing or was uploaded more than 21 days ago, in `sendBatch` calls of at most 100 messages and 256 KB each (the Queues per-call cap).
- KTD9. **The switch is the `OG_VIDEO_ENABLED` secret on the site Worker in both environments.** It is read as `=== 'true'`, so unset means off and the feature ships dark. Off stops every enqueue: audit hooks and the curated pass. Pages keep naming existing clips. It must be a secret, never a var (CF API 10053; `tests/wrangler-config.test.ts` guards the shape).
- KTD10. **Pages check for the clip with one R2 `head` per page miss.** The page computes the current key with the shared function and emits the `og:video` block only when the head succeeds.
  - Worker-rendered pages get the block through the live shell's placeholders.
  - Curated CLI pages are static assets. The Worker injects the block when serving them, and they gain a `Cache-Tag: cli:<slug>` so the `og-rendered` consumer can purge them.
  - The clip URL uses the same base as `og:image` (`CANONICAL_SITE_URL`).
- KTD11. **The clip route serves R2 directly and never renders.** `/og/clip/<target>/<key>.mp4` answers `GET` and `HEAD` with the whole object as a `200`. It sends `content-type: video/mp4`, `accept-ranges: bytes`, `x-robots-tag: noindex`, and the PNG's immutable cache class. A missing clip is a `404`. A stale key gets a `301` to the current key only when that clip exists. Range requests are answered by Workers Caching on the `Cached` entrypoint: it strips `Range`, stores the full `200`, and returns `206` or `416` itself, cold cache included. A `206` built by the Worker would be uncacheable (https://developers.cloudflare.com/workers/cache/configuration/#range-requests). An MP4 whose `moov` box sits after `mdat` needs that `206`, which the live smoke asserts.
- KTD12. **Telemetry goes through the emitter.** The render Worker logs through `src/worker/telemetry/log.ts` under a new `og.render` scope: outcome, lane, logo source, duration bucket, and binding error code. Nothing render-related enters the scorecard.

### High-Level Technical Design

Components and data flow:

```mermaid
flowchart TB
  A[Audit finishes: web core, rescore step, Sandbox DO] -->|enqueue: target, card inputs, key| Q1[(og-render queue)]
  P[Curated pass: deploy hook + weekly cron] -->|missing or older than 21 days| Q1
  Q1 --> R[anc-og-render: queue consumer]
  R --> L[Logo lookup with R2 cache]
  R --> F[Frames, per-frame GIF, Media binding]
  R --> S[(R2: og/score PNG + og/clip MP4)]
  R -->|target, lane, key| Q2[(og-rendered queue)]
  Q2 --> C[Site consumer: purge page tags]
  G[Crawler fetches PNG not yet stored] --> X[Site PNG route]
  X -->|service binding: draw one card| R
  V[Scorecard page] -->|R2 head clip for current key| S
```

Lifecycle per target and key:

```mermaid
stateDiagram-v2
  [*] --> Finished: audit stored or curated build
  Finished --> Queued: audit hook or curated pass
  Finished --> PngOnly: crawler fetches PNG first (on-demand draw)
  PngOnly --> Queued
  Queued --> Stored: render writes PNG + clip, purge
  Queued --> PngOnly: binding error or retries exhausted
  Queued --> Skipped: clip already fresh or template differs
  Stored --> Superseded: newer audit writes a new key
  Superseded --> Queued
  Stored --> Expired: 30 days after upload
  Expired --> Queued: curated pass only
```

Render job, in order (directional):

```text
on og-render message:
  if message.key template != this Worker's template: ack, skip   # deploy skew
  if clip(message.key) exists and uploaded < 21 days ago: ack, skip
  logo  = stored logo, else homepage icon, else brand logo (longer budget; no stored miss on timeout)
  png   = draw(final card)
  gif   = for each frame state in scoreOgFrames(card, motion): draw, quantize, append
  mp4   = media.input(gif).transform(1200x630).output(video, no audio)
  store png and mp4 with scored_at metadata; prune only older siblings
  send og-rendered {target, lane, key}
```

### Implementation Constraints

- No TypeScript `any`, including in the render Worker and in tests.
- Every structured log goes through `emitLog`, and a new scope is added to the `LogScope` union.
- Each env block of the render Worker's config declares its own bindings. The staging block sets `routes: []` and `triggers: { crons: [] }` explicitly, because those keys inherit and a custom domain moves silently.
- New code comments carry no plan or KTD identifiers.
- Card visuals change only through `/typeset` and `/design-review`, with a light/dark browser check of every page that shows a card (`AGENTS.md` Visual fidelity).

### Risks & Dependencies

| Risk | Mitigation |
| --- | --- |
| The Media binding is in open beta, and its docs list GIF input as "may work but untested" in one place | The spike converted per-frame GIFs in a deployed Worker on 2026-10-26. The staging smoke (U9) asserts a playable MP4 on every run, and the switch ships dark. |
| Billing starts after the beta: $0.50 per 1,000 output seconds, about $0.002 per clip | Renders come only from audits (already rate limited) and the curated pass (about 150 targets). The switch stops all of them. |
| A share in the first seconds after an audit gets the still card, and iMessage keeps that preview | Accepted. The page names the clip as soon as the `og-rendered` purge lands, about 10 to 20 s after the audit. |
| Deploy skew between the render Worker and the site Worker | The render skips a message whose template version differs from its own, and the next audit or pass re-enqueues it. The on-demand RPC returns a skew outcome the PNG route serves as `503` without storing. Template skips log under their own outcome, so a stuck skew shows. |
| Measured render cost: warm 5.7 to 7.1 s wall (4.2 to 5.3 s CPU), cold 10 to 12 s | The render Worker sets `limits.cpu_ms` from the staging measurement. The consumer caps batch size and concurrency. |

### Deferred to Implementation

- Queue batch size, concurrency, retry count, and retry delay, from staging measurements.
- The exact hash used when a tool version does not fit the key alphabet.
- Whether the on-demand PNG RPC passes card inputs or a target the render Worker resolves; it should pass inputs, per KTD3.

---

## Implementation Units

### U1. Card key grammar and card edition

- **Goal:** The card face shows the date or tool version, and every visible change mints a new key.
- **Requirements:** R10, R11, R12; KTD4.
- **Dependencies:** none. Lands inside PR #461.
- **Files:**
  - `src/shared/score-og.ts`
  - `src/worker/og/subject.ts`
  - `src/worker/og/route.ts`
  - `src/worker/audit/result.ts`
  - `src/build/08-scorecards-emit.mjs`
  - `src/build/registry-index.mjs`
  - `tests/score-og.test.ts`
  - `tests/score-og-route.test.ts`
  - `tests/audit-result-route.test.ts`
  - `tests/build.test.ts`
- **Approach:**
  1. Add an edition field to the card: a date, a tool version, or a branch SHA. Draw it in the footer where the spec version is today, and move the spec version into the image description.
  2. Replace `scoreOgKey` with one function over the subject that emits the KTD4 grammar. Extend `KEY_RE` and the path parser to match.
  3. Feed the edition from each lane's record: web `scored_at`, live CLI `tool_version`, curated scorecard version, branch `source_sha`.
  4. Add the template-version constant.
- **Patterns to follow:** `scoreOgKey` and `parseScoreOgPath` in `src/shared/score-og.ts`. `shortDate` in `src/shared/result-spine.ts` for the UTC date.
- **Test scenarios:**
  - A web subject scored 2026-10-26T23:30Z at 80% under spec 0.6.0 keys to `s80-v0.6.0-d20261026-r<template>`, and its footer reads the date.
  - A curated CLI at version 15.1.0 keys with `t15.1.0`, and its footer reads the version.
  - A tool version containing `+` or spaces is sanitized or hashed into the key alphabet and still parses back.
  - Key agreement across the page, the PNG route, and the build for each lane fixture: web, seed, live CLI, curated, alias, branch, pending, unscored.
  - A same-score re-audit on a later date produces a different key.
  - Pending and unscored keys are unchanged and never immutable.
  - The image description names the spec version.
- **Verification:** For every lane, the page's `og:image` URL, the route's canonical key, and the build's key are equal. A footer showing a date or version is confirmed in a light/dark browser check.

### U2. Logo timeouts and safe pruning

- **Goal:** A slow homepage cannot lock in the fallback tile, and an out-of-order store cannot delete a newer card.
- **Requirements:** R11; KTD5, KTD6.
- **Dependencies:** none. Lands inside PR #461.
- **Files:**
  - `src/worker/og/find-logo.ts`
  - `src/worker/og/logo.ts`
  - `src/worker/og/brand-logo.ts`
  - `src/worker/og/store.ts`
  - `tests/score-og-find-logo.test.ts`
  - `tests/score-og-route.test.ts`
- **Approach:**
  1. Return a distinct "timed out" outcome from the homepage and brand lookups, and store a miss only for a definitive outcome.
  2. Stamp `scored_at` in stored card metadata.
  3. Prune only siblings whose `scored_at` is older than the stored one's.
- **Execution note:** Write the out-of-order store test first and watch it fail against #461's prune before changing it.
- **Test scenarios:**
  - A homepage fetch that exceeds the budget yields the tile and stores nothing under `og/logo/`.
  - A definitive miss (no icon, brand returns nothing) is stored with `miss: '1'`.
  - Storing key k1 (older `scored_at`) after key k2 leaves k2 in place.
  - Storing k2 after k1 removes k1.
- **Verification:** The new store test fails on #461's `storeCard` and passes after the change.

### U3. Motion frames

- **Goal:** One pure function yields the clip's frame states, with the final card at both ends.
- **Requirements:** R2, R12; KTD7.
- **Dependencies:** U1.
- **Files:**
  - `src/shared/score-og-motion.ts`
  - `src/shared/score-og.ts`
  - `tests/score-og-motion.test.ts`
- **Approach:**
  1. Define a motion value: hold, drain, climb, and hold frame counts, plus easing, color mode, and digit mode.
  2. `scoreOgFrames(card, motion)` maps it to per-frame display states.
  3. The card renderer accepts a frame state and draws the displayed number, meter, and band.
  4. The default motion is the spike's: 15 hold, 9 linear drain, 66 ease-out-cubic climb, 15 hold, at 30 fps. Color is locked to the final band, and digits sit in fixed slots.
- **Test scenarios:**
  - Frame 0 and the last frame render byte-identical SVG to the final card.
  - The climb is monotonic and decelerates (each step no larger than the one before).
  - The frame count equals the motion's total.
  - With color locked, every frame uses the final band's color.
  - Pending and unscored cards yield no frames.
  - A 0% card holds at zero without a drain.
- **Verification:** The motion tests pass and the default motion yields 105 frames.

### U4. Render Worker

- **Goal:** `anc-og-render` turns queued card inputs into a stored PNG and clip, and draws one PNG on request.
- **Requirements:** R1, R2, R4; KTD1, KTD2, KTD3, KTD5, KTD6, KTD7, KTD12.
- **Dependencies:** U1, U2, U3.
- **Files:**
  - `src/og-render/index.ts` (queue handler and RPC entrypoint)
  - `src/og-render/render-job.ts`
  - `src/og-render/gif.ts`
  - `src/og-render/wrangler.jsonc`
  - `src/worker/og/render.ts`, `src/worker/og/fonts.ts`, `src/worker/og/logo.ts`, `src/worker/og/brand-logo.ts`, `src/worker/og/find-logo.ts`, `src/worker/og/resvg-wasm-module.ts`, `src/worker/og/fonts/*` (moved into the render Worker's module graph)
  - `src/worker/telemetry/log.ts`
  - `package.json`
  - `tests/og-render-job.test.ts`
  - `tests/og-render-gif.test.ts`
- **Approach:**
  1. Queue handler, per message:
     - skip on a template-version mismatch;
     - skip when a fresh clip exists;
     - find the logo;
     - draw the PNG and the frames;
     - encode the GIF;
     - call the binding;
     - store both objects with metadata;
     - send `og-rendered`.
  2. Ack each message on success or skip. Let the queue retry on a binding or R2 error.
  3. The RPC entrypoint draws one PNG from card inputs and returns its bytes with its logo outcome. It stores the PNG only after a definitive logo outcome, and it returns a typed skew outcome when the inputs' template version differs from its own.
  4. Fonts and resvg-wasm bundle into this Worker and leave the site's.
  5. Its config carries `compatibility_flags` `nodejs_compat` (the log emitter's request context imports `node:async_hooks`) and `global_fetch_strictly_public` (the logo fetches run under it in the site today).
- **Patterns to follow:**
  - #461's `findLogo` / `storeCard` for R2 access.
  - The og-cards fixture Worker's config for a second Worker in this repo.
  - The spike's encode loop: per-frame `quantize`/`applyPalette`, and a frame delay pattern that averages 30 fps.
- **Test scenarios:**
  - A message for a scored web target stores a PNG and an MP4 under the KTD5 keys, with `scored_at` metadata, and sends one `og-rendered` message. Uses a fake Media binding that records its input stream and options.
  - The binding receives `transform({width: 1200, height: 630})` and `output({mode: 'video', audio: false})`.
  - A message whose clip already exists and is 3 days old is acked without a binding call.
  - A message whose clip is 25 days old renders again.
  - A message with a different template version is acked without rendering.
  - A binding error leaves the PNG stored, sends no `og-rendered`, and retries the message.
  - A logo-lookup timeout renders with the tile and stores no logo miss.
  - The GIF encoder emits 105 frames with per-frame palettes, and the first frame decodes to the final card's pixels.
  - The RPC entrypoint returns PNG bytes for card inputs and stores them under the card key.
  - The RPC entrypoint does not store a PNG whose logo lookup timed out, and reports that outcome.
  - The RPC entrypoint returns the skew outcome for inputs carrying another template version, and logs it under its own `og.render` outcome.
  - Every outcome emits one `og.render` record through the emitter.
- **Verification:** Unit tests pass with fakes, and `wrangler deploy --dry-run` succeeds for both environments of the render Worker's config.

### U5. Site Worker wiring

- **Goal:** The site produces render jobs, serves clips, purges pages when clips land, and draws no images itself.
- **Requirements:** R4, R5, R8, R9; KTD2, KTD9, KTD11.
- **Dependencies:** U4.
- **Files:**
  - `src/worker/og/route.ts`
  - `src/worker/og/clip-route.ts`
  - `src/worker/og/enqueue.ts`
  - `src/worker/og/rendered-consumer.ts`
  - `src/worker/index.ts`
  - `src/worker/headers.ts`
  - `wrangler.jsonc`
  - `tests/score-og-route.test.ts`
  - `tests/score-og-clip-route.test.ts`
  - `tests/og-enqueue.test.ts`
  - `tests/wrangler-config.test.ts`
- **Approach:**
  1. The PNG route reads the stored card, else calls the render Worker's RPC. Preserved behaviour: 301 to the canonical key, alias target, and query-free path; 404 on a malformed path, unknown key grammar, or missing subject; 503 with `retry-after: 30` when R2 cannot be read; pending and unscored served `hit-min` and never stored; finished keys immutable; `x-robots-tag: noindex` on every PNG; `x-anc-card` on every PNG response, with `x-anc-card-logo` on drawn and stored cards alike. When the RPC fails or times out, the route serves the site default card (`/og-image.png` from `ASSETS`) with the `hit-min` cache class, stores nothing, and logs a distinct `score.og` outcome.
  2. The clip route follows KTD11.
  3. The enqueue helper builds the message from `loadScoreOgSubject` and sends it only for finished keys with the switch on.
  4. The `queue()` handler purges the target's page tag through the `Cached` entrypoint.
  5. Add to `wrangler.jsonc` in both environments: the `og-render` producer, the `og-rendered` consumer, and the `RENDER` service binding. Remove `CONTEXT_DEV_API_KEY` from the site's types.
- **Test scenarios:**
  - The PNG route serves a stored card without an RPC call, with `x-anc-card: stored` and `x-anc-card-logo` read from its metadata.
  - Every preserved behaviour in step 1 keeps a test, rewritten against an RPC fake: the 301 cases, the 404 cases, the 503 with `retry-after`, pending and unscored never stored, and immutable finished keys.
  - A missing card calls the RPC once, and the response is immutable.
  - An RPC failure or timeout serves the default card from `ASSETS` with `hit-min`, stores nothing, and logs the fallback outcome.
  - An RPC skew outcome yields 503 and stores nothing.
  - An on-demand draw whose logo lookup timed out is served `hit-min` and is not stored.
  - A clip `GET` returns 200 `video/mp4` with `accept-ranges: bytes` and the full body, including when the request carries `Range`.
  - A clip `HEAD` returns headers without a body.
  - A missing clip returns 404 and is not edge-cached.
  - A stale key returns 301 when the current key's clip exists, and 404 otherwise.
  - With `OG_VIDEO_ENABLED` unset, no message is sent. With `'true'`, one message is sent for a finished key and none for a pending one.
  - An `og-rendered` message purges `web:<host>` for a web target and `cli:<slug>` for a CLI target.
  - Config parity: both envs declare the queues and the service binding. `OG_VIDEO_ENABLED` appears in no `vars` block.
- **Verification:** The site bundle no longer contains resvg-wasm or the card fonts. The route and config tests pass.

### U6. Render triggers

- **Goal:** Every finished scorecard enqueues once, and curated cards stay fresh.
- **Requirements:** R1, R3, R4, R5; KTD8.
- **Dependencies:** U5.
- **Files:**
  - `src/worker/audit-web/core.ts`
  - `src/worker/audit-web/hit-min-purge.ts`
  - `src/worker/audit-web/rescore-workflow.ts`
  - `src/worker/audit-web/rescore-trigger.ts`
  - `src/worker/score/do.ts`
  - `src/worker/og/curated-pass.ts`
  - `src/worker/index.ts`
  - `.github/workflows/deploy.yml`
  - `tests/web-audit-rescore-workflow.test.ts`
  - `tests/score-do-cache-write.test.ts`
  - `tests/og-curated-pass.test.ts`
- **Approach:**
  1. Request-time web audits queue a render beside `queueHitMinPurge` and flush it with the purge.
  2. The rescore Workflow adds a step after a saved audit.
  3. The Sandbox DO enqueues after `wrote`; its env type gains the producer binding.
  4. The curated pass reads `registry-index.json` and the seeds, computes each key, and heads each clip. It sends the missing and stale ones in `sendBatch` calls of at most 100 messages and 256 KB each.
  5. The pass is served at a secret-authed endpoint reusing `requireRescoreAuth`, which `src/worker/audit-web/rescore-trigger.ts` exports for it (it is module-private today). It is called from `scheduled()` on the weekly cron and from a new `deploy.yml` step after the rescore trigger in both jobs, with the same retry and Access-header shape.
- **Test scenarios:**
  - A completed web audit through the endpoint enqueues once. A held or incomplete run enqueues nothing.
  - MCP `audit_website` enqueues through the same hook.
  - The rescore step enqueues for a `saved` outcome and not for `skipped`.
  - The DO enqueues after a successful write and not after a failed one.
  - The pass enqueues a curated target with no clip and one with a 22-day-old clip, but not one with a 2-day-old clip.
  - The pass sends nothing with the switch off.
  - 151 stale targets produce two `sendBatch` calls, neither over 100 messages, and all 151 are enqueued.
  - The pass endpoint rejects a missing or wrong secret.
- **Verification:** Trigger tests pass. On staging, a deploy enqueues every curated target on the first pass and nearly none on an immediate second pass.

### U7. Page tags

- **Goal:** Pages name the clip exactly when it exists.
- **Requirements:** R7, R8; KTD10.
- **Dependencies:** U5.
- **Files:**
  - `src/build/shell.mjs`
  - `src/worker/shell-template.ts`
  - `src/worker/audit/result.ts`
  - `src/worker/headers.ts`
  - `tests/audit-result-route.test.ts`
  - `tests/build.test.ts`
- **Approach:**
  1. Add `og:video` placeholders to the live shell, filled only when the clip head succeeds.
  2. For curated pages, inject the same block into the asset HTML after the head, and add `Cache-Tag: cli:<slug>` to their responses.
  3. R2 trouble during the head omits the block and never fails the page.
- **Test scenarios:**
  - A web page with a stored clip emits all five `og:video` tags with the clip URL on the canonical base. Without the clip it emits none and keeps `og:image`.
  - A curated page gains the block when the clip exists, and its response carries `Cache-Tag: cli:<slug>`.
  - Pending and unscored pages never emit the block.
  - An R2 error during the head yields a 200 page with no block.
  - `og:type` stays `article`.
- **Verification:** Page tests pass. A staging fetch with `Accept: text/html` shows the block once the clip renders.

### U8. Deploy, config, and docs

- **Goal:** Both Workers deploy in the right order with the right bindings, and the docs describe the result.
- **Requirements:** R5, R6; KTD1, KTD2, KTD9.
- **Dependencies:** U4, U5, U6.
- **Files:**
  - `.github/workflows/deploy.yml`
  - `src/og-render/wrangler.jsonc`
  - `RELEASES.md`
  - `AGENTS.md`
  - `DESIGN.md`
  - `knip.json`
  - `package.json`
  - `scripts/og/smoke.sh`
  - `tests/wrangler-config.test.ts`
- **Approach:**
  1. `deploy.yml` deploys the render Worker before the site in both jobs.
  2. `RELEASES.md` gains:
     - the one-time `wrangler queues create` commands for both environments, run before the stacked PR merges, since the first `dev` deploy after the merge fails without them;
     - the one-time secret commands: `wrangler secret put CONTEXT_DEV_API_KEY` against the render Worker's config for production and `--env staging`, sourced from the 1Password item `Context.dev API Key` and run after the render Worker's first deploy, then `wrangler secret delete CONTEXT_DEV_API_KEY` on the site Worker in both environments;
    - the existing line that calls the key a secret on both Workers, rewritten to name the render Worker only;
     - the switch flip;
     - a note that the `og/` lifecycle rule now also covers clips.
  3. `AGENTS.md` lists six kill switches.
  4. `DESIGN.md` §4.13 covers the clip, the key grammar, and the render Worker.
  5. `knip.json` lists the render Worker entry.
  6. The `dev` script in `package.json` runs both configs in one session (`wrangler dev -c wrangler.jsonc -c src/og-render/wrangler.jsonc --env staging --local --port 8787`), so the site's service binding resolves locally. The local `CONTEXT_DEV_API_KEY` moves to the render Worker's staging `.dev.vars`, and `scripts/og/smoke.sh` and the Local dev section of `AGENTS.md` say so.
- **Test scenarios:**
  - The render Worker config's staging block sets `routes: []`, `triggers.crons: []`, and `workers_dev: false`.
  - Both blocks declare `media`, `SCORE_CACHE`, and both queues.
  - The site config's `RENDER` binding names the matching render Worker per environment.
  - Staging and production name different queues in both configs, and each queue has exactly one consumer.
- **Verification:** Config tests pass. A staging deploy from `dev` shows both Workers' `triggers` blocks with no custom domains on the render Worker.

### U9. Live verification

- **Goal:** The release preflight proves a real clip renders, serves, and is named, end to end on staging.
- **Requirements:** R1, R2, R7, R8, R9; success criteria.
- **Dependencies:** U4 to U8.
- **Files:**
  - `tests/e2e/og-cards.e2e.ts`
  - `scripts/og/smoke.sh`
  - `RELEASES-PREFLIGHT.md`
- **Approach:**
  1. The first card fetch accepts `x-anc-card` `drawn` or `stored` and still asserts the fixture's logo tier through `x-anc-card-logo`. After the PNG assertions, poll the page (`Accept: text/html`, at most 60 s) until `og:video` appears.
  2. Then fetch the clip by path from the base under test. Staging pages advertise anc.dev URLs, so the path is taken from the tag and the host from the base.
  3. Local runs skip the clip assertions, because the binding has no local mode.
  4. Record three staging measurements in the PR: on-demand PNG latency for a request issued while a render is in flight, the same latency for the first on-demand draw after the render Worker deploys (cold start), and the render Worker's memory per invocation from Workers metrics.
- **Test scenarios:**
  - The page names `og:video` within 60 s of the audit.
  - The clip returns 200 `video/mp4`.
  - The clip's `ftyp` box is present and its track header reads 1200x630.
  - `Range: bytes=-1000` returns 206 with the matching `Content-Range`.
  - A second fetch returns identical bytes.
- **Verification:** `scripts/release/preflight.sh e2e` passes against staging with the switch on. A freshly audited link plays in iMessage and in Discord.

---

## Verification Contract

| Gate | Command or check | Applies to |
| --- | --- | --- |
| Lint | `bun run lint` (biome, markdownlint, knip) | every unit |
| Types | `bun run typecheck` | every unit |
| Build then tests | `bun run build` before `bun test` (`tests/regression.test.ts` reads `dist/`) | every unit |
| Config dry run | `bunx wrangler deploy --dry-run` for the site config and the render Worker config, both environments | U4, U5, U8 |
| Visual | light and dark browser check of a website card and a CLI card through `bun run dev` | U1 |
| Live | `scripts/release/preflight.sh e2e` against staging with `OG_VIDEO_ENABLED` set | U9 |
| Device | paste a freshly audited scorecard link into iMessage and Discord | U9 |

## Definition of Done

- Every unit's verification holds, and the gates above pass.
- `OG_VIDEO_ENABLED` is set on staging, and the staging smoke passes with the clip assertions. Production enables only with the release that ships the stacked PR.
- The site bundle carries no resvg-wasm or card fonts.
- `wrangler secret list` shows `CONTEXT_DEV_API_KEY` on both render Worker environments and on neither site Worker environment.
- PR #461 carries U1 and U2. The stacked PR carries U3 to U9. Neither body leaves follow-up items.
- No experimental or abandoned code from the build remains in either diff.

---

## Eng review (2026-10-27)

Target: this plan at `7d92626` on `dev`, checked against the PR #461 branch (`unverified/scorecard-og-images-bb05`, `63d71f4`).

### Scope record

feature answers: none proposed, every unit maps to a settled requirement; structure: A, Original arrangement (D1, answered 2026-10-27); accepted scope: U1 to U9 as written; pending remedies: none.

## Decision ledger

### F1: `requireRescoreAuth` is module-private

Finding: 1, INFORMATIONAL, confidence 9/10, `src/worker/audit-web/rescore-trigger.ts:77` (`async function requireRescoreAuth(request: Request, secret: string | undefined)`), eng review.
Plan baseline: U6 step 5 reused `requireRescoreAuth` with no export step.
Runtime evidence: the function is declared without `export`.
Correction: U6 step 5 now says the module exports it, and U6 lists `src/worker/audit-web/rescore-trigger.ts`. Factual correction, no behavior change, so no question.
State: approved
Actual answer: none needed (factual correction)
Accepted scope: export `requireRescoreAuth` for the curated-pass endpoint.
History: none.

### F3: queue creation precedes the stacked PR's merge

Finding: 3, INFORMATIONAL, confidence 7/10, plan KTD2 ("Deploy order: create the queues once, deploy the render Worker, then deploy the site Worker"), eng review.
Plan baseline: U8 listed the queue-create commands without saying when they run.
Runtime evidence: `wrangler deploy` rejects a config whose queue binding names a queue that does not exist (consumer and producer bindings resolve at deploy).
Correction: U8 now says the commands run before the stacked PR merges. Ordering clarification of KTD2, no behavior change, so no question.
State: approved
Actual answer: none needed (factual correction)
Accepted scope: run the one-time queue creation before merging the stacked PR.
History: none.

### R2: per-environment queue names

Finding: 1, CRITICAL, confidence 9/10, plan KTD2 (`og-render`, `og-rendered`) and U8 ("the one-time `wrangler queues create` commands for both environments"), eng review.
Plan baseline: KTD2 names two queues with no environment suffix; U8 creates queues "for both environments".
Runtime evidence: a Cloudflare queue has exactly one consumer Worker (https://developers.cloudflare.com/queues/get-started/); `wrangler.jsonc` keeps staging bindings in `env.staging` with suffixed resource names (`anc-score-cache-staging`).
Comparison grid:

| Choice | Current | A | B |
| --- | --- | --- | --- |
| R2 staging queue names | unspecified | `og-render-staging`, `og-rendered-staging`; config test asserts the two envs differ | unchanged (unsuffixed names in both envs) |
| R3 on-demand PNG fallback | pending | pending | pending |
| R4 PNG route and smoke regression contract | pending | pending | pending |

Question D2:
D2 (eng review): give staging its own queue names
Project/branch/task: agentnative-site og:video plan (dev), stacked on #461.
ELI10: The plan names two queues, og-render and og-rendered, but never says staging gets its own. A queue has exactly one consumer Worker. If staging and production share a queue name, staging audits would be rendered by production's Worker, or the deploys would fight over who consumes it. Every other staging resource in wrangler.jsonc already carries a -staging suffix.
Stakes if we pick wrong: staging renders leak into production storage and logs, or a deploy fails with a consumer conflict.
Recommendation: A because it matches the existing -staging convention and a config test keeps the two apart.
Completeness: A=10/10, B=3/10
Pros / cons:
A) Suffixed staging queues (recommended)
  ✅ og-render-staging and og-rendered-staging mirror anc-score-cache-staging
  ✅ A wrangler-config test fails if the two environments ever share a queue
  ❌ Four queues to create once instead of two (two extra wrangler commands)
B) Leave as written
  ✅ No change to the plan text or the config tests
  ❌ Leaves the cross-environment collision to whoever writes the config
Net: two extra one-time commands buy hard separation between staging and production.
Header: Queue names
Options:
A) Suffixed staging queues (Recommended)
Staging uses og-render-staging and og-rendered-staging, production og-render and og-rendered. tests/wrangler-config.test.ts asserts the two environments name different queues. (human: ~10 min / CC: ~2 min)
B) Leave as written
Keep the unsuffixed names in KTD2 and U8 and leave per-environment naming to implementation. (human: none / CC: none)

State: approved
Actual answer: A, Suffixed staging queues (D2, answered 2026-10-27, "1"; asked whether per-environment render Workers already isolate the queues: they do not, because queues are account-wide and named once)
Accepted scope: KTD2 names `og-render-staging` and `og-rendered-staging` for staging and `og-render` and `og-rendered` for production; U8 adds a config test that the environments name different queues with one consumer each.
History: none.

### R3: on-demand PNG when the render Worker fails

Finding: 2, INFORMATIONAL, confidence 8/10, plan U5 test scenario ("An RPC failure yields 500 with the existing log outcome") and `src/worker/og/route.ts:131` (`return text(request, 500, 'scorecard image failed\n');`), eng review.
Plan baseline: U5 keeps #461's 500 on a drawing failure, but drawing moves out of the site into the render Worker (KTD1).
Runtime evidence: #461 draws in the site isolate, so its 500 only follows a local render error. After KTD1 the same 500 follows any render Worker outage or RPC error, for every card that is not yet stored. The site already ships a default card at `/og-image.png` (`src/shared/og-card.ts:5`, `public/og-image.png`).
Comparison grid:

| Choice | Current | A | B |
| --- | --- | --- | --- |
| R2 staging queue names | approved (D2: A) | approved (D2: A) | approved (D2: A) |
| R3 PNG route on RPC failure | 500, not stored | serve the site default card from `ASSETS` with `hit-min`, not stored, logged as its own outcome | 500, not stored (as planned) |
| R4 PNG route and smoke regression contract | pending | pending | pending |

Question D3:
D3 (eng review): what a crawler gets when the render Worker is down
Project/branch/task: agentnative-site og:video plan (dev), stacked on #461.
ELI10: Today #461 draws cards inside the site, so a missing card only fails if drawing itself breaks. The plan moves drawing to the render Worker. If that Worker is down or errors, every scorecard whose card is not stored yet returns a 500 for its og:image, and the link preview shows no picture. The site already has a default card image it could serve instead, with a short cache, so the real card replaces it once drawing works again.
Stakes if we pick wrong: during a render Worker outage, shared links show a broken or missing image instead of the generic anc.dev card.
Recommendation: A because a short-cached default card keeps previews intact during an outage and never pins a wrong image.
Completeness: A=9/10, B=6/10
Pros / cons:
A) Default card fallback (recommended)
  ✅ Link previews still show the anc.dev card while the render Worker is unavailable
  ✅ hit-min caching and no store mean the real card takes over within five minutes of recovery
  ❌ One more branch in the PNG route plus its test and log outcome
B) Keep the 500
  ✅ No new code path; failures stay loud in the route's error log
  ❌ Previews shared during an outage have no image, and crawlers cache that miss their own way
Net: a small fallback trades a few lines for previews that degrade to a generic card instead of breaking.
Header: PNG fallback
Options:
A) Default card fallback (Recommended)
On an RPC failure or timeout, the PNG route serves /og-image.png from ASSETS with the hit-min cache class, stores nothing, and logs a distinct score.og outcome. U5 gains a test for it. (human: ~1 hour / CC: ~10 min)
B) Keep the 500
Leave U5 as written: an RPC failure returns 500 and stores nothing. (human: none / CC: none)

State: approved
Actual answer: A, Default card fallback (D3, answered 2026-10-27)
Accepted scope: U5 step 1 serves `/og-image.png` from `ASSETS` with `hit-min`, stores nothing, and logs a distinct `score.og` outcome when the render RPC fails or times out; the U5 test scenario covers it.
History: none.

### F4: render Worker compatibility flags

Finding: 4, INFORMATIONAL, confidence 9/10, `src/worker/telemetry/request-context.ts:7` (`import { AsyncLocalStorage } from 'node:async_hooks';`) and `wrangler.jsonc:21` (`"compatibility_flags": ["nodejs_compat", "global_fetch_strictly_public", "enable_request_signal"]`), eng review.
Plan baseline: U4 named the render Worker's config file without its compatibility flags.
Runtime evidence: the emitter the render Worker imports needs `nodejs_compat`; the logo fetches it takes over run under `global_fetch_strictly_public` in the site.
Correction: U4 step 5 sets both flags. Factual correction, no behavior choice, so no question.
State: approved
Actual answer: none needed (factual correction)
Accepted scope: the render Worker config carries `nodejs_compat` and `global_fetch_strictly_public`.
History: none.

### R4: PNG route and live smoke regression contract

Finding: 5, CRITICAL (regression rule), confidence 9/10, `tests/e2e/og-cards.e2e.ts:70-71` (`expect(first.headers()['x-anc-card']).toBe('drawn');` and `expect(first.headers()['x-anc-card-logo']).toBe(EXPECTED_LOGO[kind]);`) with `src/worker/og/store.ts:26` (`customMetadata: { target, key }`), eng review.
Plan baseline: U5 keeps the route's 301, 404 and 503 behaviour; U9 extends the og-cards smoke with clip assertions. Neither says what happens to the smoke's first-fetch assertions.
Runtime evidence: once the render job stores the PNG right after an audit (U4, U6), the smoke's first card fetch usually reads `x-anc-card: stored`, and stored responses carry no `x-anc-card-logo`, so the D17 logo-tier check fails or can no longer run.
Comparison grid:

| Choice | Current | A | B |
| --- | --- | --- | --- |
| R2 staging queue names | approved (D2: A) | approved (D2: A) | approved (D2: A) |
| R3 PNG route on RPC failure | approved (D3: A) | approved (D3: A) | approved (D3: A) |
| R4 logo tier on stored cards | absent | stored card metadata records the logo source and stored responses emit `x-anc-card-logo` | absent |
| R4 smoke first-fetch assertion | `drawn` only | `drawn` or `stored`, logo tier still asserted | `drawn` or `stored`, logo tier assertion dropped |
| R4 preserved route behaviour | U5 partial list | full list below, tests rewritten against an RPC fake | full list below, tests rewritten against an RPC fake |

Preserved route behaviour in both options: 301 to the canonical key, alias target, and query-free path; 404 on a malformed path, unknown key grammar, or missing subject; 503 with `retry-after: 30` when R2 cannot be read; pending and unscored served `hit-min` and never stored; finished keys immutable; `x-robots-tag: noindex` on every PNG; `x-anc-card` on every PNG response.

Question D4:
D4 (eng review): keep the live smoke's logo check working after pre-rendering
Project/branch/task: agentnative-site og:video plan (dev), stacked on #461.
ELI10: The live smoke you approved (D17) checks that the first card fetch was freshly drawn and names the logo it used: the homepage icon, context.dev's brand logo, or the tile. With og:video, the render job draws and stores the card seconds after the audit, so the smoke's first fetch usually gets the stored copy. Stored copies don't say which logo they used, so the logo check would fail or have to go. Recording the logo source on the stored card keeps the check alive.
Stakes if we pick wrong: the release preflight goes red on every run, or the check that proves the logo fallback works quietly disappears.
Recommendation: A because one metadata field keeps the D17 logo proof and makes stored cards self-describing.
Completeness: A=10/10, B=6/10
Pros / cons:
A) Logo source on stored cards (recommended)
  ✅ The smoke still proves the homepage, brand and tile tiers on every release
  ✅ Any stored card can be inspected for where its logo came from via one response header
  ❌ One more metadata field written at store time and read on the stored path
B) Drop the logo-tier check
  ✅ No change to stored metadata or response headers
  ❌ The live proof that the brand fallback works is gone, leaving only unit tests with fakes
Net: one metadata field preserves the only live proof of the logo fallback.
Header: Smoke contract
Options:
A) Logo source on stored cards (Recommended)
Stored PNGs record the logo source in customMetadata and stored responses emit x-anc-card-logo. The smoke accepts drawn or stored on the first fetch and still asserts the tier. Route tests are rewritten against an RPC fake for the full preserved behaviour list. (human: ~2 hours / CC: ~15 min)
B) Drop the logo-tier check
The smoke accepts drawn or stored and no longer asserts the logo tier. Route tests are rewritten against an RPC fake for the same preserved behaviour list. (human: ~1 hour / CC: ~10 min)

State: approved
Actual answer: A, Logo source on stored cards (D4, answered 2026-10-27)
Accepted scope: KTD5 stored metadata adds `logo`; stored responses emit `x-anc-card-logo`; U5 step 1 lists the preserved route behaviour and its tests are rewritten against an RPC fake; U9's first fetch accepts `drawn` or `stored` and still asserts the logo tier.
History: none.

### R5: measure on-demand PNG latency from a cold render Worker

Finding: 6, INFORMATIONAL, confidence 8/10, plan U9 step 4 ("on-demand PNG latency for a request issued while a render is in flight") and the spike's measured cold cost (wasm on a fresh isolate adds 3 to 4 s of CPU on the first one or two requests), eng review.
Plan baseline: U9 measures on-demand latency only while a render is in flight.
Runtime evidence: #461 draws in the site's warm isolates; after KTD1 the on-demand draw lands on render Worker isolates, which carry less traffic and start cold more often. Cold latency is unmeasured.
Comparison grid:

| Choice | Current | A | B |
| --- | --- | --- | --- |
| R2 staging queue names | approved (D2: A) | approved (D2: A) | approved (D2: A) |
| R3 PNG route on RPC failure | approved (D3: A) | approved (D3: A) | approved (D3: A) |
| R4 PNG route and smoke contract | approved (D4: A) | approved (D4: A) | approved (D4: A) |
| R5 on-demand latency measurement | during a render only | during a render, plus the first on-demand draw after a render Worker deploy | during a render only |

Question D5:
D5 (eng review): also measure the on-demand card from a cold render Worker
Project/branch/task: agentnative-site og:video plan (dev), stacked on #461.
ELI10: When a crawler asks for a card that isn't stored yet, the site asks the render Worker to draw it. The render Worker gets little traffic, so it often starts cold, and the spike measured 3 to 4 s of extra work on a cold start to load the image renderer. Discord gives a whole preview about 10 s. The plan measures this path only while another render is running. One more fetch right after a deploy would show the cold case.
Stakes if we pick wrong: a slow cold path goes unnoticed until crawlers time out on cards that were not pre-rendered.
Recommendation: A because one extra timed fetch after the staging deploy settles the cold-start question with real numbers.
Completeness: A=9/10, B=7/10
Pros / cons:
A) Measure the cold case too (recommended)
  ✅ The PR records cold and warm on-demand latency side by side, from staging
  ✅ If the cold case nears the crawler budget, it shows before production enables
  ❌ One more measurement step in U9 and one more number in the PR body
B) Warm case only
  ✅ U9 stays as written, with one latency number to record
  ❌ The likeliest slow case, a cold render Worker, stays unmeasured
Net: one extra fetch after a deploy turns an estimate into a measurement.
Header: Cold start
Options:
A) Measure the cold case too (Recommended)
U9 step 4 also records the first on-demand draw after the render Worker deploys to staging, next to the in-flight-render number. (human: ~15 min / CC: ~2 min)
B) Warm case only
Keep U9 step 4 as written: measure on-demand latency only while a render is in flight. (human: none / CC: none)

State: approved
Actual answer: A, Measure the cold case too (D5, answered 2026-10-27)
Accepted scope: U9 step 4 records the first on-demand draw after a render Worker deploy alongside the in-flight-render latency and memory.
History: none.

Approval readiness: PASS. Checked F1, F3, F4 (factual corrections, no question needed), R2 (D2: A), R3 (D3: A), R4 (D4: A), R5 (D5: A); structure D1: A.

## Eng review output

### NOT in scope

- X player card (`twitter:player`): needs per-domain approval and an iframe page; no priority platform plays `og:video` through it.
- Audio, animated GIF previews, an animated `og:image`: no priority platform plays them.
- Clips on pages other than scorecards: the request covers scorecards only.
- A dead-letter queue: failed renders recover on the next audit or curated pass and every failure is logged.
- Queue-level dedupe: the render checks for a fresh clip before any binding call.
- A sweep that re-renders every stored audit before expiry: settled by the owner (R6).
- The www and apex fold: its own plan, coordinated with the CLI port (owner decision D25).
- Applying the design shortlist: arrives as a template-version bump once the owner picks layout, color and digits.

### What already exists

| Need | Existing piece | Reuse or rebuild |
| --- | --- | --- |
| Card drawing, fonts, resvg-wasm | PR #461 `src/worker/og/render.ts`, `fonts.ts`, `resvg-wasm-module.ts` | Reused; moved into the render Worker's module graph |
| Logo lookup and its R2 cache | PR #461 `find-logo.ts`, `logo.ts`, `brand-logo.ts` | Reused; timeout handling fixed (U2) |
| Card store and prune | PR #461 `store.ts` | Reused; prune narrowed to older `scored_at` (U2) |
| Subject loading per lane | PR #461 `subject.ts` | Reused by the enqueue helper (KTD3) |
| Page cache purge | `src/worker/audit-web/hit-min-purge.ts` through the `Cached` entrypoint | Reused by the `og-rendered` consumer |
| Post-deploy hook and weekly cron | `deploy.yml` rescore step, `scheduled()` in `src/worker/index.ts` | Pattern reused for the curated pass; not coupled to the rescore Workflow (KTD8) |
| Secret-authed trigger | `requireRescoreAuth` in `rescore-trigger.ts` | Reused once exported (F1) |
| Default card | `public/og-image.png` (`SITE_OG_IMAGE_PATH`) | Reused as the RPC failure fallback (D3) |
| Live card smoke | `scripts/og/smoke.sh`, `tests/e2e/og-cards.e2e.ts`, `preflight.sh e2e` | Extended with clip assertions (U9, D4) |
| Range requests | Workers Caching on the `Cached` entrypoint | Reused instead of Worker-built 206s (KTD11) |

### Diagrams

```text
audit finishes ─────┐                      ┌──────────── deploy hook + weekly cron
 (web core, rescore │                      │              curated pass: R2 head per target,
  step, Sandbox DO) │                      │              missing or older than 21 days
                    ▼                      ▼
              enqueue helper ──► [ og-render(-staging) queue ] (sendBatch <= 100)
              (site: subject,                │
               key, switch)                  ▼
                                   anc-og-render(-staging) queue job
                                   ├─ skip: template differs | clip fresh
                                   ├─ logo: stored > homepage > brand (no timeout miss)
                                   ├─ PNG + 105 frames (yield per frame) > GIF > Media binding
                                   └─ R2: og/score PNG + og/clip MP4 {scored_at, template, logo}
                                              │
                                              ▼
                                   [ og-rendered(-staging) queue ] ─► site consumer: purge page tag

crawler ─► /og/score/.../<key>.png ─► stored? ─yes─► 200 immutable, x-anc-card: stored, x-anc-card-logo
                                        │no
                                        ▼
                                   RPC drawCard ─ok, logo definitive─► store + 200 immutable (drawn)
                                        ├─ logo timed out ─► 200 hit-min, not stored
                                        ├─ template skew ─► 503, not stored
                                        └─ RPC fails ─► /og-image.png, hit-min, not stored

page ─► R2 head og/clip/<sha>/<key>.mp4 ─found─► og:video block    clip route ─► 200 full; edge slices Range to 206
```

Per target and key: `finished -> queued -> stored -> superseded (new key) | expired (30 days, curated pass re-renders)`, with `queued -> png-only` on a binding failure and `queued -> skipped` on a fresh clip or template skew. Inline diagram worth adding in code: the render job's skip and store order in `src/og-render/render-job.ts`.

### Failure modes

| New path | Realistic failure | Handling and test | User sees |
| --- | --- | --- | --- |
| Queue job | Media binding error or beta outage | PNG stored, clip skipped, retried then logged `og.render` (U4 test) | Still card, no error |
| Queue job | Retries exhausted | Message dropped, logged; next audit or pass retries | Still card |
| On-demand PNG | Render Worker down | Default card, `hit-min`, not stored (D3, U5 test) | Generic anc.dev card |
| On-demand PNG | Logo lookup timeout | `hit-min`, not stored (U2/U5 tests) | Tile card briefly |
| Deploy skew | Template versions differ | Job skipped, RPC 503 not stored, logged (U4/U5 tests) | Still card or no image briefly |
| Clip-ready purge | Purge call fails | Page refreshes at its TTL (300 s live, 1 day curated); success path tested (U5) | `og:video` appears late |
| Curated pass | Over 100 messages | Chunked `sendBatch` (U6 test) | none |
| Curated pass | Endpoint fails in CI | `curl -sSf --retry` fails the deploy step | Red deploy run |
| Clip route | Cold-cache Range | Edge cache slices the full 200 (U9 e2e) | none |
| Queues | Staging and production share a name | Suffixed names, config test (D2, U8) | none |

Critical gaps (no test, no handling, silent): 0.

### Worktree parallelization strategy

| Step | Modules touched | Depends on |
| --- | --- | --- |
| U1 card key and edition | `src/shared`, `src/worker/og`, `src/build`, `src/worker/audit` | none |
| U2 logo timeout, safe prune | `src/worker/og` | U1 |
| U3 motion frames | `src/shared` | U1 |
| U4 render Worker | `src/og-render`, `src/worker/og` (moved), `src/worker/telemetry` | U1, U2, U3 |
| U5 site wiring | `src/worker/og`, `src/worker`, config | U4 |
| U6 triggers | `src/worker/audit-web`, `src/worker/score`, `src/worker/og`, `.github/workflows` | U5 |
| U7 page tags | `src/build`, `src/worker/audit`, `src/worker` | U5 |
| U8 deploy, config, docs | config, `.github/workflows`, docs | U4, U5, U6 |
| U9 live verification | `tests/e2e`, `scripts/og`, docs | U4 to U8 |

Lane A: U1 then U2 (PR #461). Lane B: U3, parallel with U2 after U1. Lane C: U4, U5, then U6 and U7 in parallel, then U8, then U9 (stacked PR). Execution order: U1; launch U2 and U3; merge; U4; U5; launch U6 and U7; merge; U8; U9. Conflict flags: `src/worker/og` is shared by U2, U4 and U5, so those run in sequence; U6 and U7 both touch `src/worker/index.ts` and need a coordinated merge.

## Implementation Tasks

Synthesized from this review's findings. Each task derives from a specific finding above.

- [ ] **T1 (P1, human: ~1h / CC: ~5min)**: config: name staging queues `og-render-staging` and `og-rendered-staging`, assert env separation
  - Surfaced by: Architecture, finding 1 (R2, D2)
  - Files: `wrangler.jsonc`, `src/og-render/wrangler.jsonc`, `tests/wrangler-config.test.ts`
  - Verify: `bun test tests/wrangler-config.test.ts`
- [ ] **T2 (P1, human: ~3h / CC: ~15min)**: og store and route: record the logo source on stored cards, emit it on stored responses, rewrite route tests on an RPC fake, keep the smoke's tier check
  - Surfaced by: Tests, regression rule (R4, D4)
  - Files: `src/worker/og/store.ts`, `src/worker/og/route.ts`, `src/og-render/render-job.ts`, `tests/score-og-route.test.ts`, `tests/e2e/og-cards.e2e.ts`
  - Verify: `bun test tests/score-og-route.test.ts`; `scripts/release/preflight.sh e2e` on staging
- [ ] **T3 (P2, human: ~1h / CC: ~10min)**: PNG route: serve the default card on RPC failure
  - Surfaced by: Architecture, finding 2 (R3, D3)
  - Files: `src/worker/og/route.ts`, `tests/score-og-route.test.ts`
  - Verify: `bun test tests/score-og-route.test.ts`
- [ ] **T4 (P2, human: ~20min / CC: ~2min)**: live verification: record cold-start on-demand latency
  - Surfaced by: Performance, finding 1 (R5, D5)
  - Files: `tests/e2e/og-cards.e2e.ts`, PR body
  - Verify: the PR records cold and warm latency from staging
- [ ] **T5 (P2, human: ~10min / CC: ~1min)**: audit-web: export `requireRescoreAuth`
  - Surfaced by: Scope Challenge (F1)
  - Files: `src/worker/audit-web/rescore-trigger.ts`
  - Verify: `bun run typecheck`
- [ ] **T6 (P2, human: ~10min / CC: ~1min)**: render Worker config: `nodejs_compat` and `global_fetch_strictly_public`
  - Surfaced by: Code Quality, finding 1 (F4)
  - Files: `src/og-render/wrangler.jsonc`
  - Verify: `bunx wrangler deploy --dry-run --config src/og-render/wrangler.jsonc`
- [ ] **T7 (P2, human: ~10min / CC: ~1min)**: RELEASES.md: create the queues before the stacked PR merges
  - Surfaced by: Architecture, finding 3 (F3)
  - Files: `RELEASES.md`
  - Verify: the queue-create step precedes the merge in the release notes

Effort assumption: features about 30x and tests about 50x faster with CC than a human team.

### Unresolved decisions

None.

### Completion summary

- Step 0: Scope Challenge: scope accepted as-is (no cuts proposed; structure D1: A)
- Reality rows: 7/7 applicable rows emitted (`PLAN_REALITY: phase=eng rows=7/7 missing=none unverified=1 verdict=complete`), 1 unverified premise (binding GIF input and 1200x630 output, proven by the spike and asserted live in U9)
- Architecture Review: 3 issues found
- Code Quality Review: 2 issues found
- Test Review: diagram produced, 1 gap identified (regression contract, resolved by D4)
- Performance Review: 3 issues found
- NOT in scope: written
- What already exists: written
- TODOS.md updates: 0 items proposed (the two follow-ups are the www/apex plan and the design shortlist, both already tracked)
- Failure modes: 0 critical gaps flagged
- Unresolved decisions: 0 in this review
- Outside voice: codex, disabled (`codex_reviews` is disabled in gstack config)
- Parallelization: 3 lanes, 2 parallel points (U2 with U3, U6 with U7) / 6 sequential steps
- Lake Score: 2/4 (D2 and D4 picked the 10/10 option; D3 and D5 picked 9/10 options, the highest offered)

### Suppressed findings

- (confidence 4/10) A permanently failing binding input is retried up to the queue's retry count. Bounded by the deferred retry setting; failed operations are likely unbilled. No change.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | not run | none |
| Outside Review | codex via `/plan-eng-review` | Independent 2nd opinion | 1 | disabled | none (`codex_reviews` disabled) |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 6 | issues_open | 9 issues, 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 2 | stale (other plans, 2026-09) | none for this plan |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | not run | none |

- **OUTSIDE COVERAGE:** codex, plan-review phase, disabled by gstack config; no outside findings.
- **VERDICT:** Eng Review ISSUES OPEN in name only: all 9 issues are resolved in the plan (D2 to D5 and three factual corrections), 0 unresolved, 0 critical gaps. Ready to implement after the DX review.

NO UNRESOLVED DECISIONS

