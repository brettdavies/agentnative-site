---
title: 'feat: production live-DO smoke service-token bypass'
type: feat
status: proposed
date: 2026-06-01
origin: 'post-release retro on the 2026-06-01 live-scoring v3 + audit rename + spec/principles v0.5.0 release (PR #145, squash `08958bc`). Cache-purge step ran cleanly; the production live-DO smoke step in RELEASES-PREFLIGHT.md is structurally unfollowable with curl because production Turnstile validates real tokens. Manual browser submission is the only operator path today.'
pr: TBD
related:
  - 'RELEASES-PREFLIGHT.md (post-tag verification block)'
  - 'src/worker/score/handler.ts (gate ordering)'
  - 'src/worker/score/turnstile.ts (verifyTurnstile)'
  - 'docs/solutions/architecture-patterns/cf-worker-gate-ordering-before-cost-bearing-outbounds-2026-05-20.md'
---

# feat: production live-DO smoke service-token bypass

## Problem

The `RELEASES-PREFLIGHT.md` post-tag verification block names a production live-DO smoke that exercises a non-registry
binary against `anc.dev`. The staging recipe (`curl -d '{"input":"...","turnstile_token":"x"}'`) works because staging
binds Cloudflare's always-pass Turnstile pair (`1x0000...AA` sitekey + matching test secret), so `siteverify` validates
`"x"` trivially. Production binds real sitekey + real secret, so the same curl call returns `turnstile_failed`. The only
operator path today is manually opening `https://anc.dev/` in a browser, pasting the binary, watching the live run
complete. That works once for a human; it does not work for CI, for a scripted post-tag check, or for any future "smoke
as a Worker cron" pattern.

The pre-existing gap shipped silently three releases in a row (2026-05-19 cache release, 2026-05-29 audit rename
release, 2026-06-01 live-scoring v3 release). It was caught on the third release when curl's `turnstile_failed` response
surfaced. The shipped path is healthy in each case — the registry-fast-path + the staging live-DO smoke during preflight
together prove Worker health — but the checklist as written points at a step the operator cannot honestly check.

## Goal

Allow a trusted caller (CI runner, operator with the token, future Worker cron) to exercise the live-DO path on
production without rendering Turnstile. Keep Turnstile enforced for every untrusted POST. Keep rate-limit and the
kill-switch enforced for the bypassed path. Make every bypassed run observably distinct in Analytics Engine so bypass
traffic stays separable from user traffic.

## Non-goals

- Bypassing rate-limit or the kill-switch. Both stay enforced; the bypass replaces Turnstile only.
- Bypassing Turnstile on staging. Staging already has the always-pass test pair; no bypass is needed and adding one
  invites accidentally shipping bypass code that "works on staging" but masks a real test gap.
- A long-lived auth surface. The bypass is for smoke testing, not for partner API access. A long-lived API key pattern
  would warrant a separate full auth design.
- Replacing the manual browser path. Operators without the token (e.g., a fresh on-call following the runbook from
  scratch) still have the manual path as a fallback. The runbook documents both.

## Approach

A header-checked secret on the production Worker only. The handler short-circuits the Turnstile gate when the header
matches a constant-time-compared secret bound via `wrangler secret put`. The bypass slot inside the gate block sits
after kill-switch + rate-limit (cheaper gates first per the existing gate-ordering rule) and before the discovery
fan-out + DO dispatch. Telemetry tags every bypassed run so Analytics Engine can keep bypass traffic separable from user
traffic and so a leaked token shows up loudly in the dashboard rather than silently fanning out at cost.

### Token shape and storage

- Secret name: `SMOKE_SERVICE_TOKEN`. Set via `wrangler secret put SMOKE_SERVICE_TOKEN` on the production Worker only;
  staging stays unset and the bypass is a no-op there. The runbook documents the absence on staging deliberately.
- Token value: a random 32-byte URL-safe base64 string. Stored once in 1Password as `Cloudflare Worker - anc.dev
  SMOKE_SERVICE_TOKEN`. Rotated quarterly via a documented procedure (re-`wrangler secret put`, re-1Password edit).
  Consumers re-fetch on next run.
- Header name: `X-Anc-Smoke-Token`. Sent only over HTTPS to `anc.dev`; receiver enforces `request.url` starts with
  `https://` even though Worker requests are TLS-terminated upstream (defense in depth against a future regression).
- Comparison: `timingSafeEqual` against `env.SMOKE_SERVICE_TOKEN`. Length-mismatch case must short-circuit cleanly
  without leaking the comparison via timing.

### Handler integration

The bypass slot sits in `src/worker/score/handler.ts` inside the gate block at line ~478. Concrete shape:

```ts
// 4a. Kill switch (operator flip).
if (await isScoringDisabled(env)) { ... }

// 4b. SMOKE bypass — production-only. Skip Turnstile if a constant-time
// match against env.SMOKE_SERVICE_TOKEN succeeds. Rate-limit (4c) and
// the kill-switch (4a) above stay enforced. Telemetry tags the run so
// AE can separate smoke traffic from user traffic.
const smokeBypass = await checkSmokeBypass(env, request);
if (smokeBypass) {
  telemetry.is_smoke = true;
  // skip 4c Turnstile; fall through to 4d rate-limit + below
} else {
  // 4c. Turnstile siteverify.
  ...
}
```

`checkSmokeBypass` is a separate module (`src/worker/score/smoke-bypass.ts`) with the same shape discipline as
`kill-switch.ts`: pure function, no global state, swallows secret-absent cases as a no-op (returns `false`), pinned by
unit tests on every branch.

### Telemetry

`src/worker/score/telemetry.ts` adds one blob slot for `is_smoke` (or extends an existing one). The Analytics Engine
field schema documented in `docs/runbooks/live-scoring-analytics.md` gets a row update + a sample query that filters on
smoke vs user traffic.

Open question: do we add a new blob slot (`blob6`) or fold smoke into an existing slot (e.g., extend the `freshness`
enum from `"live" | "cache-hit" | "registry-hit"` to add `"live-smoke"`)? Folding is simpler but mixes a *who*
classifier into a *what* classifier. Cleaner: separate slot. Decide at implementation time; document the decision in the
unit's commit message.

### Smoke recipe update

`scripts/smoke-api-score.sh` already runs the registry-fast-path smoke on every deploy. Extend it with an opt-in
`--live` flag that:

1. Fetches `SMOKE_SERVICE_TOKEN` from 1Password via the helper at `~/.claude/skills/1password/scripts/read_field.sh`.
2. POSTs to `${BASE}/api/score` with `-d '{"input":"<binary>","turnstile_token":"x"}'` (the token is irrelevant; the
   bypass skips siteverify) and `-H "X-Anc-Smoke-Token: ${SMOKE_SERVICE_TOKEN}"`.
3. Asserts the same response triad the staging smoke asserts, plus `scorecard.kind != null` (a real live run, not a
   registry hit).

Same script runs against staging without the header — staging's always-pass pair makes the existing recipe work
unchanged.

### Runbook update

`RELEASES-PREFLIGHT.md` post-tag block names both paths (already partially done in this plan's accompanying docs PR).
Once the bypass ships, the curl recipe gets a concrete example with the `X-Anc-Smoke-Token` header.

## Threat model

The bypass eliminates one of three layered defenses on the live-DO path: kill-switch, rate-limit, Turnstile.

| Failure mode                                  | Consequence with bypass                                                           | Consequence without bypass                                                                                        |
| --------------------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Token leak via 1Password compromise           | Attacker can fan the live-DO path up to rate-limit cap per IP (30 req/min)        | Same attacker can fan curated + cache paths (already unmetered) but cannot drive the DO without solving Turnstile |
| Token leak via worker secret enumeration      | Same as above                                                                     | n/a (no token to leak)                                                                                            |
| Token leak via inadvertent commit / log       | Same as above                                                                     | n/a (no token to leak)                                                                                            |
| Operator runs smoke against prod accidentally | One live-DO run completes, emits telemetry tagged `is_smoke: true`, costs ~$0.001 | One Turnstile failure; no cost                                                                                    |

Mitigations the design bakes in:

- **Rate-limit + kill-switch stay enforced.** Token leak caps damage at the rate-limit budget (10 req/min/session + 30
  req/min/IP), not at the underlying DO cost ceiling.
- **AE telemetry tag.** Every bypassed run carries `is_smoke: true` (or equivalent). A leak shows up as a smoke-tagged
  fan-out in AE. Set an alert threshold ("> N smoke-tagged requests per hour from non-CI IPs" → page operator).
- **Production-only secret.** Staging stays untouched. A regression that "works on staging" cannot mask a real bypass on
  production because there is no staging code path to verify against.
- **Token rotation procedure.** Documented quarterly rotation. Each rotation invalidates any prior leak.
- **Operator-controlled deployment.** Token deployed via `wrangler secret put`, not via a CI workflow that could leak it
  through logs.

Residual risk: a token leak that gets used at line-rate against rate-limit will cost up to ~$N/hour in DO + container
budget (modeled with current `max_instances` cap of 3 in prod = ~3 concurrent live runs, capped). The kill-switch flip
is the recovery lever (the runbook documents the procedure today). Token rotation is the structural fix.

## Acceptance

- [ ] `wrangler secret put SMOKE_SERVICE_TOKEN` runs cleanly against production; staging stays unset.
- [ ] `checkSmokeBypass` module ships with unit tests covering: secret absent → no-op, token mismatch → no-op, token
  match → bypass returns true, length mismatch → no-op (timing-safe).
- [ ] Handler integration: bypass is checked between kill-switch and Turnstile; rate-limit still runs; telemetry tags
  the run as smoke; existing `score.tier` log line carries the smoke flag.
- [ ] Analytics Engine field-shape contract updated in `tests/score-telemetry.test.ts` and
  `docs/runbooks/live-scoring-analytics.md`.
- [ ] `scripts/smoke-api-score.sh --live` ships with an example invocation in `RELEASES-PREFLIGHT.md` and a 1Password
  item created at `Cloudflare Worker - anc.dev SMOKE_SERVICE_TOKEN`.
- [ ] Solutions doc added at
  `docs/solutions/architecture-patterns/cf-worker-bypass-gate-for-trusted-smoke-callers-<date>.md` capturing the
  bypass-gate rationale and the production-only-secret pattern.
- [ ] Threshold-based alert on the AE dataset for unexpected smoke-tagged traffic.

## Open questions

- New blob slot vs `freshness` enum extension for the smoke tag. Decide at implementation.
- Should the bypass apply to GET as well as POST `/api/score`? Today GET stops at the read-only tiers and never reaches
  the gate block; the bypass naturally applies to POST only. Document this explicitly.
- JWT-with-TTL pattern vs constant-time-compared secret. JWT is more rotation-friendly but adds dependencies and
  surface; the secret pattern matches the existing `TURNSTILE_SECRET` and `SESSION_HMAC_SECRET` discipline. Default to
  the secret pattern unless rotation cadence proves too painful.
- Where the smoke binary's R2 cache entry lives. Today every successful live run writes to `SCORE_CACHE`; smoke runs
  would too, which means the next user request for the same binary would serve from cache. Probably fine (smoke
  exercises the cache-write path) but worth confirming.

## Out of scope

- Generalizing the bypass to other gates (rate-limit, kill-switch).
- A multi-tenant API-key system for partner callers.
- Replacing the existing manual browser path in the runbook.
- Migrating the staging smoke recipe; staging keeps its always-pass Turnstile pair indefinitely.
