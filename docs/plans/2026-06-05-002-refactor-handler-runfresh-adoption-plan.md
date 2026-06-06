---
title: 'refactor: U5b — handler.ts adopts shared runFreshOnly orchestrator'
status: completed
created: 2026-06-05
plan_type: refactor
depth: standard
related_plans:
  - docs/plans/2026-06-05-001-feat-mcp-endpoint-plan.md  # U5 split origin; status: completed
related_repos:
  - brettdavies/agentnative-cli  # vendored spec source of truth, unchanged here
---

# refactor: U5b — handler.ts adopts shared runFreshOnly orchestrator

## Summary

Complete the U5 split that the MCP endpoint plan deferred at planning time. `src/worker/score/handler.ts` currently runs
its own inline fresh-audit block (resolveSpec → DO dispatch via `getRandom(env.SCORE)` → variant-specific response
shaping) even though the same logic shipped in U5a as `runFreshOnly` in `src/worker/score/orchestrate.ts` and has been
powering the MCP `score_cli` tool in production-shaped staging traffic since 2026-06-05. U5b deletes the inline copy and
routes the handler through the shared orchestrator, completing the symmetry the MCP plan and AGENTS.md line 104 both
name as load-bearing: "The two tools compose the same `/api/score` orchestration core, so cache semantics never drift
between MCP and the human form on `/`."

Two units, one PR to `dev`. U1 closes the one known thin coverage seam (test-first pin for the
`incomplete_response_contract` `details` strings) so U2's migration has a complete safety net. U2 is the atomic swap:
`handler.ts` calls `runFreshOnly` and `switch`es on `RunFreshResult.kind`, the three duplicated DO classification
helpers (`isStubError`, `isDoSuccess`, `isDoError`) are deleted in favor of `orchestrate.ts`'s versions, dead imports
go. The existing 3,360-line bun test suite stays green; no externally observable behavior changes.

---

## Problem Frame

The MCP endpoint plan's U5 originally bundled three concerns: extract the shared orchestrator, ship the new MCP
`score_cli` tool against it, and migrate the existing HTTP `/api/score` handler to use it too. At the U5 planning split,
Brett asked "Split: ship score_cli + orchestrator now, handler refactor next" because the handler's 3,360-line test
coverage surface is the regression risk and warrants its own plan — bundling it with the orchestrator extraction would
have multiplied the blast radius if anything went wrong.

U5a shipped (PR #168, 2026-06-05): `runFreshOnly` exists, `score_cli` composes it, the orchestrator's own test surface
is green, and the three DO classification helpers were intentionally mirrored byte-for-byte from `handler.ts` into
`orchestrate.ts` so U5b could later delete the handler-side copies without behavior risk. The handler itself stayed on
its inline block. U5b is the second half of that planned split.

The work is bounded:

- One source file changes meaningfully (`src/worker/score/handler.ts`); one source file gets minor surface tweaks
  (`src/worker/score/orchestrate.ts` if the lifted helpers need export adjustments).
- One test file gains two new pin assertions for the `incomplete_response_contract.details` strings.
- No wire shape changes. `/api/score` returns byte-identical responses for every input class.
- No new dependencies. No env-var changes. No migration. No rollout.

The risk is concentrated at the handoff seam between `runFreshOnly`'s discriminated `RunFreshResult` union (7 variants)
and `handleScoreInner`'s existing per-variant response shaping (telemetry recording, share-URL generation, JSON/markdown
content negotiation, `Set-Cookie` threading). The stale-derivation precedent at
[`docs/solutions/architecture-patterns/stale-derivations-across-tier-migrations.md`](../solutions/architecture-patterns/stale-derivations-across-tier-migrations.md)
is the named hazard: PR #100 hit this exact handler in 2026-05 when binary resolution moved from DO to handler and the
share-URL derivation silently returned `null` for an entire input class. The tests passed.

---

## Requirements

- **R1. Behavioral parity.** Every `/api/score` response — for every input class the test suite exercises — remains
  byte-identical to the pre-refactor baseline. Telemetry payload values, shape, and emit order remain identical
  (including `cache_post_attempted` distribution across error paths and `binary` / `pm` / `resolved_step` attribution on
  every spec-resolved request, per KTD-4 and KTD-7). The 3,360-line bun suite stays green.
- **R2. Code-path symmetry.** Both `/api/score` and MCP `score_cli` compose the same `runFreshOnly` orchestrator. The
  symmetry contract in AGENTS.md line 104 ("The two tools compose the same `/api/score` orchestration core, so cache
  semantics never drift between MCP and the human form on `/`") is no longer aspirational; it is enforced by structure.
- **R3. Helper consolidation.** `isStubError`, `isDoSuccess`, and `isDoError` exist exactly once in the codebase. STAR
  principle: single truth, authoritative record. The handler-local copies (handler.ts lines 884, 903, 911) are gone.
- **R4. Thin-seam coverage.** The one known coverage gap — the `incomplete_response_contract` `details` string is
  asserted on code (`error_incomplete_response_contract`) but not on the exact string (`"DO returned non-JSON"` vs. `"DO
  returned unrecognized envelope shape"`) — is pinned with two new bun unit assertions before U2 lands. This is the only
  new test; nothing else is added.
- **R5. Dead code removal.** Once the inline block and helpers are gone, the imports they pulled in (`getRandom`,
  `Container` type, `cache` if no longer referenced elsewhere, `MAX_INSTANCES`) get removed in the same commit.
  TypeScript's unused-import diagnostics are the floor; a manual sweep confirms.

---

## Key Technical Decisions

### KTD-1. Single PR to `dev`, two commits (U1 then U2)

The user-confirmed migration shape from Phase 0.7 scoping. The orchestrator is already proven (U5a tests green, MCP
`score_cli` has been hitting it in staging since 2026-06-05 with `MCP_ENABLED="true"`); the handler test suite is the
safety net. Incremental multi-PR (extract method-by-method across 2-3 PRs) would multiply ceremony — two PRs of CI
ceremony, two rounds of approval — without reducing risk because the migration is structurally atomic: handler.ts either
calls `runFreshOnly` or it doesn't. There is no useful intermediate state.

Two commits inside the PR is the unit boundary, not a separate PR. U1 lands first so U2's safety net is complete at the
moment of the swap.

### KTD-2. Trust the existing 3,360-line suite as continuous characterization; supplement only at the one thin seam

The user-confirmed coverage stance from Phase 0.7. Adding new characterization tests for behavior already covered by the
suite would be redundant ceremony. The thin seam (`incomplete_response_contract.details` exact strings) gets two pin
tests in U1; everything else rides on the existing assertions.

Backed by the byte-identical-verification pattern documented at
[`docs/solutions/best-practices/build-module-srp-dry-refactor-20260421.md`](../solutions/best-practices/build-module-srp-dry-refactor-20260421.md).
The implementation execution loop runs a canonical-input matrix diff as a procedural safety net during U2: capture
representative response envelopes from `handler.ts` pre-edit, run the same inputs post-edit, diff. Cheap, deterministic,
catches the silent-omission-for-an-input-class failure class that the stale-derivations precedent (PR #100, same
handler) showed unit tests can miss. This is procedural during U2, not a committed test artifact — the existing suite
plus the U1 pin tests are the committed safety net.

### KTD-3. Lift the three DO classification helpers to a single home in `orchestrate.ts`; delete `handler.ts`'s copies

STAR principle from the global instructions. The qmd-learnings search found no prior decision endorsing
duplication-for-blast-radius-isolation in this codebase; the only adjacent precedent
([`docs/solutions/integration-issues/cloudflare-workers-do-mock-must-mirror-binding-shape-2026-05-15.md`](../solutions/integration-issues/cloudflare-workers-do-mock-must-mirror-binding-shape-2026-05-15.md))
reinforces that test mocks have to match production envelope shape regardless of where the helpers live, so the
duplication offered no real isolation benefit. Repo recon confirms the two copies are byte-identical except for one
section comment in `handler.ts`. Lift-and-delete is the clean end state. The handler imports `isStubError`,
`isDoSuccess`, `isDoError` from `orchestrate.ts` (the lifted home) instead of declaring them locally.

### KTD-4. Telemetry `cache_post_attempted` flag is captured inside the per-variant switch arms, not before the orchestrator call

The seam the repo recon surfaced, resolved jointly with KTD-7. Today `handler.ts` line 639 sets
`telemetry.cache_post_attempted = true` BEFORE attempting the post-discovery cache lookup, whenever the skip gate holds
(`spec.pm !== 'git-clone' && !skipCache`). The flag therefore stays `true` even when the request later bounces on
`do_error`, `sandbox_unavailable`, `sandbox_stub_until_u6`, or `incomplete_response_contract` — every path that crossed
the skip gate emits `cache_post_attempted=true`, only `resolution_error` (and git-clone / skip-cache requests) emit
`false`. R1 (byte-identical telemetry) requires the post-refactor handler to reproduce that distribution.

Resolution: with KTD-7 extending `RunFreshResult` to carry `spec` on every variant where the skip gate was crossed
(`cache_post_hit`, `fresh`, `do_error`, `sandbox_unavailable`, `sandbox_stub_until_u6`, `incomplete_response_contract`),
the handler computes `telemetry.cache_post_attempted = result.spec.pm !== 'git-clone' && !skipCache` inside every one of
those arms. The `resolution_error` arm leaves the flag at its initial `false` (no spec was derived; no cache attempt
happened). The `1538` test in `score-handler-branch-and-norelease.test.ts` is the load-bearing assertion: it expects
`cache_post_attempted=true` in the `cache_post_hit` path, and that stays true post-refactor.

### KTD-5. `shareUrlForSpec` stays in `handler.ts`

The helper is HTTP-only: MCP returns the URL inline in the scorecard payload, but the `/api/score` form derives a
shareable URL for the cached result and threads it into `shapeScoreSuccess`. `orchestrate.ts` deliberately does NOT
import `shareUrlForSpec` (verified in U5a). The handler retains the call inside its `cache_post_hit` and `fresh` switch
arms. No change to share-URL behavior.

### KTD-6. The `tier='error_X'` telemetry strings are preserved byte-identical

Five error tiers participate in the variant switch:

- `error_${resolution.error}` (i.e. `error_chain_no_resolve`, `error_install_unsupported`, `error_invalid_url_path` —
  the three members of `resolve-spec.ts`'s `resolution.error` union; `brew_only` and `go_no_binary` live in
  `resolution.details` as `pm=...` and surface through the `error_install_unsupported` tier)
- `error_sandbox_unavailable`
- `error_sandbox_stub_until_u6`
- `error_${doPayload.error}`
- `error_incomplete_response_contract`

Every test that asserts a tier string asserts the literal — drift breaks the assertion. The refactor preserves each
string exactly; the switch arms produce the same `tier` value the inline block produces today. Telemetry mutation
happens BEFORE response construction inside each arm so the outer `try/finally` emits the final state.

### KTD-7. `RunFreshResult` extends to carry `spec` and `resolved_step` on every variant where the skip gate was crossed

The orchestrator's current `RunFreshResult` shape (post-U5a) carries `spec` and `resolved_step` only on the
`cache_post_hit`, `fresh`, and `do_error` variants — the three paths where the orchestrator already needed spec
information to produce its output. The `sandbox_unavailable`, `sandbox_stub_until_u6`, and
`incomplete_response_contract` variants currently carry no `spec`, which is fine for the MCP `score_cli` consumer (it
returns a typed error to the agent without telemetry attribution) but breaks the handler's pre-refactor telemetry
contract. Today `handler.ts:609-612` sets `telemetry.binary`, `telemetry.pm`, and `telemetry.resolved_step` from the
resolved spec immediately after `resolveSpec` succeeds — so every error path that follows a successful spec resolution
(including sandbox errors and contract failures) emits a `recordScoreEvent` row carrying the resolved binary name,
package manager, and resolved step in the Analytics Engine `writeDataPoint` payload. Operators query that AE row for
tool attribution (`which tools hit sandbox_unavailable most often?`); a post-refactor `null` on those fields breaks the
query without any HTTP-wire signal, which the byte-identical preflight (KTD-2) and the existing 3,360-line bun suite
cannot catch.

Resolution: extend `RunFreshResult`'s `sandbox_unavailable`, `sandbox_stub_until_u6`, and `incomplete_response_contract`
variants to carry `spec` and `resolved_step` (both optional in the type, present whenever the orchestrator passed the
skip gate before the DO call failed). The MCP `score_cli` consumer in `src/worker/mcp/tools/scorecard-audit.ts` already
ignores these fields on those variants; the extension is purely additive at the orchestrator surface. The handler reads
`result.spec.binary`, `result.spec.pm`, and `result.resolved_step` inside each spec-carrying arm and sets the three
telemetry fields, preserving the AE-row payload byte-identical to today's behavior. Same root cause as KTD-4's
`cache_post_attempted` seam, fixed in the same surface change.

`tests/worker-score-orchestrate.test.ts` gains assertions covering the new fields on `sandbox_unavailable` and
`sandbox_stub_until_u6` (the `incomplete_response_contract` variant already gets one assertion from U1's pin tests once
spec is present). The handler's existing 3,360-line suite continues to pass without changes — the AE row is asserted
indirectly via the existing tier-log assertions, and the binary/pm fields are not pinned today (which is itself the
silent-omission shape KTD-2's byte-identical preflight cannot catch on its own).

---

## Implementation Units

### U1. Pin `incomplete_response_contract.details` strings before the migration

**Goal.** Close the one known thin coverage seam so U2's atomic swap has a complete safety net. The
`incomplete_response_contract` envelope's exact `details` string (`"DO returned non-JSON"` for `reason:
'non_json_body'`, `"DO returned unrecognized envelope shape"` for `reason: 'unrecognized_envelope'`) is not currently
asserted as an exact-string match in any handler test; only the wrapping `error` code is asserted. The refactor's switch
arm could drift the string without any current test catching it.

**Requirements:** R4.

**Dependencies:** none.

**Files:**

- `tests/score-handler.test.ts` (modify — add 2 new test cases inside the existing `POST pipeline error paths` describe
  block at line ~364; mirror the surrounding mock-DO pattern)

**Approach.** Two tests, each posting an input that forces the DO branch and stubbing the DO to return the malformed
shape for the targeted reason. The first DO returns plain text (triggers `non_json_body`); the second DO returns valid
JSON with an unrecognized envelope (triggers `unrecognized_envelope`). Both assert the response status (500), the
`error` code (`incomplete_response_contract`), AND the exact `details` string. This is the only new test added by U5b;
everything else relies on the existing 3,360-line suite.

**Execution note.** Test-first — the assertions fail today (the current handler emits the strings but no test pins
them). Verify red, then commit. The strings are the contract.

**Patterns to follow.**

- The `POST pipeline error paths` describe block in `tests/score-handler.test.ts` lines 364-455 (mock DO fetch override
  pattern, request shape, response assertion shape).
- `tests/worker-score-orchestrate.test.ts` `runFreshOnly: DO dispatch` block for the DO-mock structure if the handler
  test lacks a direct precedent.

**Test scenarios.**

- **Pin `non_json_body`**: POST `/api/score` with an input that forces the DO branch (e.g. a known-no-registry GitHub
  URL). Stub `env.SCORE.idFromName(...).get(...).fetch(...)` to return `new Response('not json', { status: 200 })`.
  Assert response status 500, `body.error === 'incomplete_response_contract'`, `body.details === 'DO returned
  non-JSON'`.
- **Pin `unrecognized_envelope`**: same input shape. Stub the DO fetch to return `new Response(JSON.stringify({
  unexpected: 'shape' }), { status: 200, headers: { 'Content-Type': 'application/json' } })`. Assert response status
  500, `body.error === 'incomplete_response_contract'`, `body.details === 'DO returned unrecognized envelope shape'`.

**Verification.** Both new tests fail when the assertion is flipped to `not.toBe(...)`; pass with the current handler;
the suite total goes from 882 to 884 with 0 failures.

---

### U2. Replace handler.ts inline block with `runFreshOnly`; delete duplicated helpers

**Goal.** The atomic swap. `src/worker/score/handler.ts` calls `runFreshOnly` instead of running its own inline copy of
the same logic, switches on `RunFreshResult.kind` to drive telemetry mutation and response shaping, and drops the three
duplicated DO classification helpers plus the imports they required. The 3,360-line existing test suite and U1's 2 new
pin tests all stay green. No wire behavior change.

**Requirements:** R1, R2, R3, R5.

**Dependencies:** U1.

**Files:**

- `src/worker/score/handler.ts` (modify — replace lines 602-769 of the current handler with one `runFreshOnly` call plus
  a `switch (result.kind)`; delete `isStubError`, `isDoSuccess`, `isDoError` local definitions at lines ~884-915; remove
  now-dead imports for `getRandom`, the `Container` type, `MAX_INSTANCES` constant, and `cache` if unused elsewhere; add
  an import for `runFreshOnly` + the three classification helpers from `./orchestrate`)
- `src/worker/score/orchestrate.ts` (modify — per KTD-7, extend the `RunFreshResult` union so the `sandbox_unavailable`,
  `sandbox_stub_until_u6`, and `incomplete_response_contract` variants carry optional `spec` and `resolved_step` fields
  populated whenever the orchestrator passed the skip gate before the DO call failed; add `export` to `isStubError`,
  `isDoSuccess`, and `isDoError` so `handler.ts` can import them; the MCP `score_cli` consumer at
  `src/worker/mcp/tools/scorecard-audit.ts` ignores the new optional fields and does not need a change)
- `tests/worker-score-orchestrate.test.ts` (modify — extend the existing `runFreshOnly: sandbox_unavailable` and
  `runFreshOnly: DO dispatch` assertions to confirm `result.spec` and `result.resolved_step` are populated on the
  no-spec error variants when the orchestrator reached them after a successful `resolveSpec`; mirror the assertion shape
  the `do_error` arm already carries)
- `tests/score-handler.test.ts`, `tests/score-handler-branch-and-norelease.test.ts`,
  `tests/score-handler-share-url.test.ts`, `tests/score-handler-share-url-post-discovery.test.ts` (unchanged — the 3,360
  lines run as the regression net; do not edit any of these)

**Approach.** The replacement call site is inside `handleScoreInner`, immediately after the pre-orchestrator flow ends
(handler.ts line ~601, after `lookupScorecard` and the metered gates have run, after `resolveSpec` would have been the
next step). The call shape is:

```text
const result = await runFreshOnly(validated, env, hintsIndex, {
  specVersion: SPEC_VERSION,
  inputHash,
  skipCachePost: skipCache,
});
switch (result.kind) {
  case 'cache_post_hit': ...
  case 'fresh': ...
  case 'resolution_error': ...
  case 'sandbox_unavailable': ...
  case 'sandbox_stub_until_u6': ...
  case 'do_error': ...
  case 'incomplete_response_contract': ...
}
```

(Directional guidance, not literal — the implementer threads `telemetry`, `setCookie`, `preference`, `request`, and the
existing `shapeScoreSuccess` / `shapeScoreError` / `shapeWithPreference` / `resolutionErrorToResponse` / `mapDoError`
calls into each arm to reproduce today's wire shape.)

**Variant → arm shape** (the seam map from repo recon):

Every spec-carrying arm (every `result.kind` other than `resolution_error`) sets the four spec-derived telemetry fields
in the same shape today's handler sets them right after `resolveSpec` returns: `telemetry.binary = result.spec.binary`,
`telemetry.pm = result.spec.pm`, `telemetry.resolved_step = result.resolved_step ?? null`, and
`telemetry.cache_post_attempted = result.spec.pm !== 'git-clone' && !skipCache`. This is the KTD-4 + KTD-7 contract:
every variant where the orchestrator passed the skip gate before bouncing produces the same AE row attribution today's
inline block does.

- `cache_post_hit` — apply the four spec-derived fields above, then set `telemetry.cache_post_hit=true,
  tier='cache_post', freshness='cache-hit'`; derive `shareUrl = shareUrlForSpec(result.spec)`; return
  `shapeWithPreference(shapeScoreSuccess(result.scorecard, result.anc_version, 'cache-hit', shareUrl), preference,
  request)` with `setCookie` threaded.
- `fresh` — apply the four spec-derived fields, then set `telemetry.tier='live', freshness='live',
  install_ms=result.install_ms, anc_audit_ms=result.anc_audit_ms`; derive `shareUrl`; return shaped success with
  `setCookie`.
- `resolution_error` — no spec is available (resolveSpec failed). Set `telemetry.tier='error_'+result.error`;
  `telemetry.cache_post_attempted` stays at its initial `false`; return `resolutionErrorToResponse(result.error,
  result.details)` with `setCookie` (the existing `resolutionErrorToResponse` helper stays unchanged in handler.ts; its
  pm-extraction regex at line 924 keeps working since the `details` shape is unchanged).
- `sandbox_unavailable` — apply the four spec-derived fields when `result.spec` is present (KTD-7 ensures it is whenever
  the orchestrator reached the env.SCORE check, which is the only path that produces this variant); set
  `telemetry.tier='error_sandbox_unavailable'`; return typed 503 with `setCookie`.
- `sandbox_stub_until_u6` — apply the four spec-derived fields per KTD-7; set
  `telemetry.tier='error_sandbox_stub_until_u6'`; return typed 503 with `setCookie`.
- `do_error` — apply the four spec-derived fields (already exposed on this variant pre-KTD-7); set
  `telemetry.tier='error_'+result.doPayload.error`; return `mapDoError(result.doPayload)` with `setCookie` (`mapDoError`
  already takes `{ error, details }`; destructure `result.doPayload` on the way in).
- `incomplete_response_contract` — apply the four spec-derived fields per KTD-7 (this variant only fires after the DO
  has been dispatched, so spec is always populated). `switch (result.reason)`: `case 'non_json_body'` emits the `'DO
  returned non-JSON'` details, `case 'unrecognized_envelope'` emits `'DO returned unrecognized envelope shape'`; both
  set `telemetry.tier='error_incomplete_response_contract'` and return a 500 with `setCookie` (per the centralized
  `statusForError` mapping in `src/worker/score/response-shape.ts:110-112`, already pinned by
  `tests/score-response-shape.test.ts:65`). U1's pin tests catch any drift on the strings.

**Procedural safety net during execution.** Before editing handler.ts, capture response envelopes from the running local
dev (`bun run dev`) for a canonical input matrix: cached/live × success/error × with/without registry hint × share_url
null and non-null (eight inputs minimum, ten ideal). After editing, run the same inputs and diff. Zero substantive
deltas. Formatting-only deltas are acceptable. This is the byte-identical-verification pattern from
[`docs/solutions/best-practices/build-module-srp-dry-refactor-20260421.md`](../solutions/best-practices/build-module-srp-dry-refactor-20260421.md);
the artifact is procedural (a local diff during the implementation loop), not a committed test.

**Patterns to follow.**

- `src/worker/mcp/tools/scorecard-audit.ts` lines 236-334 is the structural template for the `switch (result.kind)`
  shape — the MCP tool already does this lift for `score_cli`, just mapping into `CallToolResult` instead of HTTP
  responses. The variant-to-action mapping is the same; the response shape differs. Use it as a literal reference.
- `handler.ts`'s existing response helpers (`shapeWithPreference`, `shapeScoreSuccess`, `shapeScoreError`,
  `resolutionErrorToResponse`, `mapDoError`, `shareUrlForSpec`) stay intact and get called from inside the new switch
  arms.
- AGENTS.md "Cost gate: `score_cli` never bypasses the cache" — the contract this refactor enforces structurally.

**Test scenarios.** The 3,360-line existing handler test suite is the regression net for U2. Specific assertions serving
as load-bearing checks for the seams:

- `tests/score-handler-branch-and-norelease.test.ts:1538` — the four cache-flag telemetry assertions
  (`cache_pre_attempted`, `cache_pre_hit`, `cache_post_attempted`, `cache_post_hit`). Confirms KTD-4 lands correctly.
- `tests/score-handler-branch-and-norelease.test.ts:1317` — round-1 miss + round-2 hit → cached return, DO never
  dispatched, `tier='cache_post'`. Confirms `cache_post_hit` arm.
- `tests/score-handler.test.ts:407` — missing `env.SCORE` → 503 `sandbox_unavailable`. Confirms that arm.
- `tests/score-handler.test.ts:392` — DO stub envelope passthrough → 503 `sandbox_stub_until_u6`. Confirms that arm.
- `tests/score-handler.test.ts:420` and the broader R2-cache-tier describe at 571 — DO returns valid envelope → 200,
  share_url + triad correct. Confirms `fresh` arm.
- `tests/score-handler-branch-and-norelease.test.ts:321, 867, 880, 1244, 1260` — `resolution_error` variants
  (`pm=brew_only` and `pm=go_no_binary` surfacing via `error_install_unsupported`; `chain_no_resolve`). Confirms
  `resolutionErrorToResponse` composition still works.
- `tests/score-handler-branch-and-norelease.test.ts:350` — `do_error` variant (DO returns
  `chain_resolved_no_binary_produced`). Confirms `mapDoError` composition still works. The label `resolution_error` in
  earlier drafts was incorrect: discovery resolved successfully and the DO was dispatched; the error surfaces from the
  DO, not from `resolveSpec`.
- `tests/score-handler.test.ts` `POST pipeline error paths` (lines 364-455) — `do_error` and
  `incomplete_response_contract` paths. U1's two new tests pin the previously-unpinned `details` strings inside this
  block.
- `tests/worker-score-orchestrate.test.ts` — orchestrator-level coverage stays green (it doesn't move; handler.ts just
  starts calling the already-tested function).

**Test expectation: none added (U2).** The U1 pin tests are the only new tests across U5b. U2 verifies via the existing
suite plus U1's additions, totaling 884 expected after merge.

**Verification.**

- `bun test` returns 884+ pass / 0 fail (882 baseline + 2 from U1 + any orchestrate.test.ts assertion adds).
- `bun run build` succeeds with no warnings.
- `bun x wrangler deploy --dry-run --env staging` succeeds with no warnings.
- `src/worker/score/handler.ts` line count drops by ~140-160 lines (the deleted inline block, the three helper
  definitions, the dead imports).
- `src/worker/score/orchestrate.ts` adds the `spec` and `resolved_step` optional fields to the three previously-no-spec
  `RunFreshResult` variants (KTD-7); MCP `score_cli` consumer in `scorecard-audit.ts` is unchanged because it ignores
  these fields on error variants.
- TypeScript's unused-import diagnostic reports zero remaining unused symbols.
- A `grep -n "isStubError\|isDoSuccess\|isDoError" src/worker/score/handler.ts` returns zero matches.
- A `grep -n "getRandom\|MAX_INSTANCES" src/worker/score/handler.ts` returns zero matches.
- The local canonical-input matrix diff (procedural, per KTD-2) shows zero substantive deltas pre vs post on the
  HTTP-wire side. The AE-row side rides on the `tests/worker-score-orchestrate.test.ts` extension plus the existing
  handler tier-log assertions.

---

## Scope Boundaries

### In scope

- `src/worker/score/handler.ts` inline fresh-audit block replaced by `runFreshOnly` call.
- The three DO classification helpers consolidated to one home in `orchestrate.ts`.
- Two new pin tests for `incomplete_response_contract.details` strings in `tests/score-handler.test.ts`.
- Dead-import cleanup in `handler.ts`.

### Outside this product's identity

- Any change to the `/api/score` wire contract. The whole point is byte-identical observable behavior; if a change would
  produce a wire diff, it does not belong in U5b.
- Any change to the MCP `score_cli` tool. It already composes `runFreshOnly`; U5b changes none of that.

### Deferred to follow-up work

- **Lifting `lookupScorecard` to compose `lookupOnly` for full read-tier symmetry.** The read tier already has
  `lookupOnly` in `orchestrate.ts` (shipped in U3 of the MCP plan), but `handler.ts` still calls `lookupScorecard`
  directly instead of composing `lookupOnly`. Same shape of refactor as U5b but for the read tier; deserves its own plan
  because the read tier has different test coverage and different cache semantics.
- **Capturing the two-phase orchestrator-extraction pattern as a solutions doc.** The qmd-learnings search confirmed
  this is a genuine gap — U5a/U5b is the first documented split of this shape in the agentnative ecosystem, and the
  pattern (extract orchestrator + ship one consumer first; migrate other consumers in a follow-up plan) will recur. Run
  `/ce-compound` post-merge to capture the pattern, the rationale (test-coverage blast-radius isolation), and the
  byte-identical-verification preflight as the supporting discipline.
- **Broader live-scoring refactor** (orchestrator boundary tuning, retry logic, race-condition guards, telemetry shape
  evolution). U5b is bounded to the structural symmetry; behavior evolution earns its own plan.

---

## Risks

### Risk 1: Silent omission for an input class (the stale-derivations failure mode)

The named precedent at
[`docs/solutions/architecture-patterns/stale-derivations-across-tier-migrations.md`](../solutions/architecture-patterns/stale-derivations-across-tier-migrations.md)
hit this exact handler in PR #100. Share-URL derivation kept reading a pre-migration input shape and silently returned
`null` for an input class. Tests passed; the bug shipped.

**Mitigation.** Three layers cover this risk together: (1) The procedural byte-identical preflight in U2 (KTD-2)
captures HTTP-wire response envelope diffs. (2) KTD-7's `RunFreshResult` variant extension ensures every spec-resolved
arm carries `spec` and `resolved_step`, so the handler preserves `telemetry.binary` / `telemetry.pm` /
`telemetry.resolved_step` byte-identical on every variant other than `resolution_error` (where today's handler also
leaves them at their defaults because `resolveSpec` never returned). (3) KTD-4 routes `cache_post_attempted` through the
same spec-carrying arms, preserving the flag's distribution across success and DO-failure paths. The eight-to-ten input
matrix in KTD-2 covers the wire-shape side; the orchestrator unit tests at `tests/worker-score-orchestrate.test.ts`
cover the telemetry-side surface change for the no-spec arms.

### Risk 2: Telemetry emit-ordering drift and AE-row value preservation

`handleScore` wraps `handleScoreInner` in `try/finally` (handler.ts lines 293-305) and emits the telemetry row from the
finally block. Per-variant `telemetry.*` mutations move from inline statements (the current handler.ts lines 642-644,
739-742, 685, 725, 604, 708, 734, 760) into switch arms. Two failure modes participate. **Emit ordering**: if an arm
constructs the response before mutating telemetry, the finally block sees the wrong state. **AE-row value drift**: if
the handler can't read spec on the `sandbox_unavailable` / `sandbox_stub_until_u6` / `incomplete_response_contract`
arms, the Analytics Engine `writeDataPoint` row for those errors loses tool/pm/resolved_step attribution that operators
query for "which tools hit sandbox errors most often"; the byte-identical preflight (KTD-2) cannot catch this because
the drift is in the AE payload, not the HTTP response.

**Mitigation.** KTD-6 names the emit-ordering discipline: mutate telemetry before constructing the response in every
arm. The `1538` test in `score-handler-branch-and-norelease.test.ts` asserts the cache-flag set explicitly — emit-order
drift breaks the test. KTD-7 names the value-preservation discipline: extend `RunFreshResult` to carry `spec` and
`resolved_step` on every variant where the orchestrator passed the skip gate so the handler can reproduce today's AE
attribution. `tests/worker-score-orchestrate.test.ts` gains assertions for the new fields on the previously-no-spec
variants.

### Risk 3: Dead-import cleanup overshoot

After deleting the inline block and helpers, `getRandom`, the `Container` type, `MAX_INSTANCES`, and possibly `cache`
become unused. TypeScript flags unused imports at build time, but if `cache` is still referenced elsewhere in the file
(for example by a code path the repo recon didn't enumerate), the agent may delete a live import.

**Mitigation.** Before deletion, run `grep -n "\\bcache\\." src/worker/score/handler.ts` to find every usage and confirm
the only references are inside the inline block being removed. Same check for `getRandom` and `MAX_INSTANCES`. Build
runs as the final guard.

### Risk 4: DO mock fidelity drift

The
[`cloudflare-workers-do-mock-must-mirror-binding-shape-2026-05-15`](../solutions/integration-issues/cloudflare-workers-do-mock-must-mirror-binding-shape-2026-05-15.md)
precedent surfaced from qmd-learnings: handler tests use hand-rolled DO mocks; mock drift only surfaces on first deploy.

**Mitigation.** The refactor changes no test file other than `tests/score-handler.test.ts` (U1's additions only), so
every existing DO mock stays exactly as-is. The lifted classification helpers are byte-identical to the deleted local
copies, so mock fidelity is preserved — the helpers' behavior doesn't change, only their home. No new mock paths are
created.

### Risk 5: Wire-shape drift on `incomplete_response_contract.details` strings

Today the two `details` strings (`"DO returned non-JSON"` and `"DO returned unrecognized envelope shape"`) are not
asserted in any test as exact-string matches. The refactor's switch arm could emit drifted strings without any current
test catching it.

**Mitigation.** U1 lands first. Its two pin tests assert the exact strings; U2's switch arm has to emit them verbatim or
the suite is red.

---

## Documentation Plan

No consumer-facing documentation changes are required by U5b. The relevant disclosures already shipped in U8 of the MCP
endpoint plan:

- `AGENTS.md` line 104: the "two tools compose the same `/api/score` orchestration core" contract. U5b enforces it
  structurally; no edit needed.
- `RELEASES-RATIONALE.md` § "MCP endpoint rate limits and cost gates": the cache-never-bypassed rule and its
  regression-guard pointer at `tests/worker-mcp-audit.test.ts`. U5b reinforces the rule by collapsing the second inline
  copy of the orchestration; the rationale text doesn't change.
- `content/mcp.md` § "Cost control": same rule, same docs.

If U5b later changes `handler.ts`'s observable behavior (it should not, per R1), AGENTS.md and `RELEASES.md` would need
updates. Plan-time expectation is no doc edits.

The two-phase orchestrator-extraction pattern is the only documentation gap (see Deferred to Follow-Up Work); capture
via `/ce-compound` post-merge, not as part of this plan.

---

## Verification

The plan is implemented and ready to ship when:

1. The branch `feat/handler-runfresh-adoption` (or equivalent conventional name; `refactor/handler-runfresh-adoption` is
   also acceptable since the change is structurally a refactor) carries two commits matching U1 and U2.
2. `bun test` reports 884 pass / 0 fail (882 baseline + 2 from U1).
3. `bun run build` succeeds with no warnings.
4. `bun x wrangler deploy --dry-run --env staging` succeeds.
5. `src/worker/score/handler.ts` line count is 140-160 lines lower than the pre-refactor baseline (1074 → ~915-935).
6. `grep -n "isStubError\\|isDoSuccess\\|isDoError" src/worker/score/handler.ts` returns zero matches.
7. `grep -n "getRandom" src/worker/score/handler.ts` returns zero matches.
8. `grep -n "MAX_INSTANCES" src/worker/score/handler.ts` returns zero matches.
9. The procedural canonical-input matrix diff (per KTD-2, run during U2's implementation loop) showed zero substantive
   deltas pre vs post.
10. The PR opens against `dev` and CI passes on the standard `ci.yml` gate.

The release-time verification (production cutover) is outside this plan; the refactor ships to staging via the standard
push-to-dev deploy and rides the next `release/*` cherry-pick to production. No special operational steps.

---

## Sources & Research

### Origin

- The MCP endpoint plan:
  [`docs/plans/2026-06-05-001-feat-mcp-endpoint-plan.md`](./2026-06-05-001-feat-mcp-endpoint-plan.md). U5b was
  explicitly deferred at U5 plan-split time; the plan's "Deferred to Follow-Up Work" subsection names this plan's scope
  (handler.ts refactor onto `runFreshOnly`).

### Local research (Phase 1)

- Repo recon: `ce-repo-research-analyst` mapped the inline block boundaries (handler.ts lines 602-769 inside
  `handleScoreInner`), the per-variant response-mapping seams, the helper byte-equality, the test surface coverage per
  variant, and AGENTS.md line 104 as the published symmetry contract. The repo recon also flagged the telemetry
  `cache_post_attempted` seam and the `incomplete_response_contract.details` string coverage gap.
- Institutional learnings: `qmd-learnings-researcher` surfaced two load-bearing precedents from `docs/solutions/`:
  [`stale-derivations-across-tier-migrations.md`](../solutions/architecture-patterns/stale-derivations-across-tier-migrations.md)
  (the named failure mode — same handler, same neighborhood) and
  [`cloudflare-workers-do-mock-must-mirror-binding-shape-2026-05-15.md`](../solutions/integration-issues/cloudflare-workers-do-mock-must-mirror-binding-shape-2026-05-15.md)
  (DO mock fidelity discipline applicable to the helper lift). The byte-identical-verification pattern at
  [`build-module-srp-dry-refactor-20260421.md`](../solutions/best-practices/build-module-srp-dry-refactor-20260421.md)
  is the named procedural countermeasure carried forward as KTD-2.
- Gaps surfaced (not load-bearing for U5b, but recorded): no prior solutions doc names the two-phase
  orchestrator-extraction pattern explicitly; no prior doc endorses "trust the existing tests" as a refactor stance
  without supporting discipline; no carve-out for direct-to-dev on low-blast-radius refactors. Standard
  `feat/*`-or-`refactor/*` → PR → squash-to-dev flow applies.

### External research

- None. Phase 1.2 routed to skip: strong local patterns (the orchestrator is already proven in U5a + MCP staging
  traffic), no API/security/migration/external-contract surfaces, the symmetry contract is already published in
  AGENTS.md, and the MCP `score_cli` switch shape (`src/worker/mcp/tools/scorecard-audit.ts`) is the local structural
  template.

### Cross-repo references

- AGENTS.md line 104 (the symmetry contract).
- `src/worker/mcp/tools/scorecard-audit.ts` lines 236-334 (the local structural template for the variant switch).
- The four handler test files plus `tests/worker-score-orchestrate.test.ts` (the 3,360-line regression net plus the
  orchestrator's own coverage).
