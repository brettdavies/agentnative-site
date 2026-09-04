---
artifact_contract: ce-unified-plan/v1
artifact_readiness: requirements-only
execution: code
product_contract_source: ce-plan-bootstrap
title: "Telemetry session identity - Plan"
type: feat
date: 2026-09-01
topic: telemetry-session-identity
---

# Telemetry session identity - Plan

## Goal Capsule

- **Objective:** An operator can follow one visitor's path through anc.dev within a single sitting — which page they
  landed on, what they read next, where they stopped — without the site holding anything that identifies them or that
  survives the sitting.
- **Authority:** R-IDs win on required behavior.
- **Execution profile:** Blocked on open questions. This artifact is `requirements-only` on purpose: four design
  questions below have to be answered before implementation units can be written, and three of them were only discovered
  by review. OQ4 is answered; OQ1 to OQ3 remain open.
- **Stop conditions:** Do not begin implementation while any Open Question is unresolved. Two of them can invalidate the
  whole approach.
- **Depends on:** `docs/plans/2026-09-01-0042-refactor-structured-log-emitter-plan.md` — specifically its `page.request`
  record (U10) and its platform-key finding (U6). Both are on `dev` (#330 `77814f9`, #331 `fbeff01`); the finding is
  recorded in `docs/runbooks/sitewide-analytics.md` § Live-layer field index.
- **Parent view:** `docs/plans/2026-09-01-1732-feat-sitewide-telemetry-plan.md` owns the sitewide contract these
  journeys serve; its R5 governs what any record or export may carry.
- **Execution order:** filename timestamps do not encode execution order. This plan runs last in the telemetry family —
  after the parent's config-wins and lake milestones — and remains blocked on OQ1 to OQ3 until then.

---

## Product Contract

### Summary

Add a bounded session identity to page telemetry so a visitor's requests can be grouped within a window and never across
one. The mechanism is a salted, one-way derivation over request attributes that are never themselves stored.

### Problem Frame

Page analytics without journeys answers "what is popular" but not "how is the site read." For a documentation site whose
whole thesis is that structure should be traversable, whether readers actually traverse it is the interesting question —
and `PRODUCT.md` stakes the agent-facing half of that thesis explicitly on "structure predictable across versions."

An earlier draft folded this into the emitter refactor. Review found three of that plan's four P0s in this half, so it
was split out: the emitter fix had no unresolved design questions and this does.

### Key Decisions

- **Split from the emitter plan** (session-settled: user-directed — chosen over shipping both together, and over
  deferring session identity entirely). The emitter half had no P0s that were not editorial; this half needed a record
  that did not exist, sat on the wrong side of an RPC boundary, and rested on a privacy claim that did not survive
  review.
- **Journeys are within-window only.** Cross-window linkage is not a deferred feature; it is the property being
  deliberately given up.

### Requirements

- R1. Page-serving records carry a session identifier that groups one visitor's requests within a bounded window.
- R2. The identifier cannot be linked across windows by anyone without the derivation secret.
- R3. No IP address and no User-Agent is stored in any record the site writes.
- R4. `mcp.request` and `score.tier` carry no session identifier, so their documented field sets stay exact.
- R5. Deriving the identifier adds no measurable latency to the cache-hit path.
- R6. The privacy posture — what is derived, what is discarded, what an operator can and cannot do — is stated where a
  visitor can read it.

### Success Criteria

- Filtering to one identifier and ordering by timestamp returns a coherent path through the site.
- The same visitor in a later window is a different identifier.
- A published k-anonymity check shows session tuples are not routinely unique, or the work stops.

### Scope Boundaries

- **Not sequence precompute.** Event index within a session and is-entry both need cross-request state. They belong to
  the sitewide-analytics brainstorm, where the cost of a hot-path lookup can be weighed against the value.
- **Not aggregate journey analysis.** The Workers Observability Query Builder offers filter, group-by, order-by, and
  aggregate functions only — no sequence or funnel operators. One session's path is readable; "most common three-page
  journeys" is not expressible and no amount of session design changes that.

### Open Questions — OQ1 to OQ3 blocking, OQ4 answered

- **OQ1. Does the existing session identity already answer this?** `src/worker/score/session.ts` issues a signed
  `__Host-anc-session` cookie carrying a `sid`, established after a Turnstile solve and already used to key
  `SCORE_LIMITER`. It is PII-free and already exists. Nobody asked whether it should be the grouping key instead of
  deriving a new one from IP and User-Agent. If it can serve, most of this plan disappears. If it cannot — because it is
  only issued on the scoring flow and not on ordinary page reads — that reason should be written down rather than
  rediscovered.
- **OQ2. How does the identifier cross the RPC boundary, or does it need to?** The gateway is where the real User-Agent
  still exists and the only code that runs on a cache HIT, so derivation belongs there. But `src/worker/index.ts:990`
  dispatches over `ctx.exports.Cached.fetch`, and `AsyncLocalStorage` does not survive that hop — verified on workerd.
  Cloudflare documents caller-supplied `ctx.props` on loopback bindings for exactly this, which would preserve
  derive-once-at-the-outermost-point. The alternative is emitting the session-bearing record at the gateway and never
  needing the crossing. The answer decides the shape.
- **OQ3. Where does the async derivation land?** Web Crypto HMAC is promise-based — the repo's own `sign()` in
  `src/worker/score/session.ts:86` awaits `importKey` then `sign` — so the nested construction is four awaited
  `crypto.subtle` calls. Placing them at the gateway puts crypto ahead of the cache dispatch on every request including
  static assets, which contradicts R5. Memoising a promise and deriving lazily at first use is the obvious answer; it
  needs confirming rather than assuming.
- **OQ4. Does a platform key already carry the client IP?** The Worker's telemetry records carry ~114 platform-populated
  `$metadata`/`$workers` keys. If any holds the client address, then a session identifier lands in the same indexed
  record as the address it was derived to avoid, and R3 is void no matter how careful the derivation is. The emitter
  plan's U6 answers this as a side effect; this plan must not start before it does. The same audit extends to the
  Logpush export envelope: the sitewide plan's R5 forbids the export reintroducing what the records exclude. **Answered
  (emitter plan U6, #331):** yes, on the platform's own records. The invocation records (`$metadata.type:
  cf-worker-event`, one per request) index and populate `$workers.event.request.headers.cf-connecting-ip`, `x-real-ip`,
  `x-forwarded-for`, `user-agent`, and the `cf` geolocation fields for the live layer's seven days; the Worker's console
  records (`$metadata.type: cf-worker`) carry none of them, so R3 holds for every record the site writes. Consequences
  for the derivation: a session key must never be joined to an invocation record by request id, and the Logpush
  allowlist's exclusion of the `Event` envelope is what keeps the address out of the lake (the parent's export audit
  confirms it per delivery). Record: `docs/runbooks/sitewide-analytics.md` § Live-layer field index.

### Sources

- `docs/runbooks/sitewide-analytics.md` § Live-layer field index — the platform-key audit behind OQ4's answer.

- Verified on workerd, 2026-09-01: an `AsyncLocalStorage` store set in `default.fetch` reads `null` inside
  `Cached.fetch`; the direct-construction fallback propagates it. Every worker test passes `{} as ExecutionContext`,
  which selects that fallback — so a wrong placement passes the suite.
- `src/worker/score/session.ts:20,30,83,86` — the existing `__Host-anc-session` cookie, `SessionConfigError`, and an
  async HMAC `sign()` helper already in the Worker.
- `src/worker/accept.ts:190-196` — `applyUaClass` deletes the User-Agent for HTML clients and rewrites it to `curl/` for
  markdown clients, before the inner Worker runs.
- `wrangler.jsonc:32-36` — `Cached` is the cache-enabled skip-Worker HIT target; only the gateway runs on a hit.
- Workers Logs retention is 7 days; the Query Builder is filter, group-by, order-by, and aggregate functions only.

---

## Planning Contract

### Design position, stated honestly

A clock-derived salt — `HMAC(HMAC(secret, floor(now / window)), ip + user_agent)` — was proposed and described as
unlinkable "by construction." **That claim is false and is recorded here so it is not made again.** The secret persists
and the window index is public, so anyone holding the secret can recompute any past or future window's salt. Candidate
IP and User-Agent pairs are enumerable — one subnet crossed with a few thousand common UA strings sweeps in milliseconds
— so a secret-holder can both relink a visitor across windows and confirm that a given address visited during a chosen
window.

The construction this borrows from (Plausible, Fathom) generates a **random** salt per window and destroys it at
rotation. That is what buys the property. The clock-derived variant trades it away for statelessness.

So the real choice is:

|                               | Random salt, destroyed at rotation | Clock-derived salt |
| ----------------------------- | ---------------------------------- | ------------------ |
| Unlinkable to a secret-holder | yes                                | **no**             |
| Needs stored state            | yes                                | no                 |
| Rotation                      | explicit                           | automatic          |

Either is defensible. Only one of them is what the earlier draft claimed. Whichever is chosen, the guarantee must be
written as "unlinkable to anyone without the secret," and secret-rotation cadence becomes the lever that bounds how far
back keys stay recomputable.

Four further findings to carry into implementation:

- **Epoch-aligned windows leak by timing.** Every visitor rotates at the same instant, so at single-digit requests per
  minute two key-streams that abut precisely at :00 or :30 can be rejoined by adjacency with no secret at all. A
  per-visitor window offset derived from the same inputs removes the tell without adding state.
- **Do not truncate.** At a few thousand sessions per window against 2³², the birthday bound is roughly 0.1% — enough to
  corrupt journeys, nowhere near enough to blur identity. Real blurring needs 12–16 bits, which destroys the journey
  entirely. Truncation and journey fidelity are the same dial pointed in opposite directions.
- **Tumbling windows split sessions.** A visitor arriving shortly before a boundary appears as two unlinkable keys. The
  split rate at realistic session lengths is far larger than the collision rate used to argue against truncation, so
  both fidelity questions should be argued to the same standard.
- **Derivation reads only the platform-trusted address, and IPv6 reduces to a routing prefix.** Client-supplied
  forwarded-for headers are spoofable and never feed the key; `CF-Connecting-IP` is the only trustworthy source. An IPv6
  address must reduce to its routing prefix (a /64 by default) before keying — a single /64 holder otherwise mints
  unlimited fresh identities, and a visitor's rotating interface identifiers split one sitting into many keys.

### Naming and secret handling

The repo already has `src/worker/score/session.ts` and `SESSION_HMAC_SECRET`, which fails fast on absence. A telemetry
session that degrades to null on a missing secret is the opposite posture, so it should not share a name.
`TELEMETRY_SESSION_SALT` in `src/worker/telemetry/session-key.ts` keeps the two distinguishable for an operator rotating
secrets. Secrets are not declared in `wrangler.jsonc` in this repo — `wrangler secret put` against a declared var name
returns Cloudflare API 10053, and `tests/wrangler-config.test.ts` guards it.

---

## Implementation Units

Not yet written. OQ1 to OQ3 are blocking, and OQ1 and OQ2 can change the shape enough that units written now would be
discarded. Answer them, then enrich this plan to `implementation-ready`.

---

## Definition of Done

Not applicable while `artifact_readiness: requirements-only`. The next step is answering the Open Questions, not
building.
