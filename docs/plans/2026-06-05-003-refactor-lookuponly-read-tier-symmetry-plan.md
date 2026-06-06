---
title: 'refactor: handler.ts + score_cli adopt shared lookupOnly orchestrator (read-tier symmetry)'
status: completed
created: 2026-06-05
plan_type: refactor
depth: lightweight
related_plans:
  - docs/plans/2026-06-05-002-refactor-handler-runfresh-adoption-plan.md  # U5b — run-fresh tier symmetry, the precedent this plan mirrors
  - docs/plans/2026-06-05-001-feat-mcp-endpoint-plan.md  # origin: U3 shipped lookupOnly, U5a shipped runFreshOnly; the deferred lift lives in U5b's "Deferred to Follow-Up Work"
---

# refactor: handler.ts + score_cli adopt shared lookupOnly orchestrator (read-tier symmetry)

## Summary

Finish the read-tier symmetry the U5b refactor left half-done. `src/worker/score/orchestrate.ts` exposes `lookupOnly` as
the canonical read-tier entry point (registry first, R2 cache second, no fresh audit), but only one of three read-tier
consumers composes it today: the MCP `get_scorecard` tool at `src/worker/mcp/tools/scorecard-read.ts:104`. The other two
— the HTTP `/api/score` handler at `src/worker/score/handler.ts:386` and the MCP `score_cli` tool at
`src/worker/mcp/tools/scorecard-audit.ts:177` — still call `lookupScorecard` directly. The plan flips both to compose
`lookupOnly` so all three consumers route through one entry point, completing the symmetry contract AGENTS.md line 104
names alongside the run-fresh tier ("the two tools compose the same /api/score orchestration core, so cache semantics
never drift between MCP and the human form on /").

Wire shape stays byte-identical for every consumer. `lookupOnly` in orchestrate.ts is a thin identity-equivalent wrapper
around `lookupScorecard` (line 84: `return lookupScorecard(input, env, registryIndex, hintsIndex, opts);`), so the swap
is structurally a rename plus an import path change. No behavioral risk surface; existing test coverage for handler.ts
read tier (~3,360 lines of handler suite) and MCP `score_cli` (`tests/worker-mcp-audit.test.ts`) is the regression net.
Two units, one PR to `dev`, two commits.

## Problem Frame

U5b's "Deferred to Follow-Up Work" section named the handler.ts call site as the only outstanding read-tier asymmetry.
Recon for this plan surfaced a second consumer the U5b note overlooked: `scorecard-audit.ts:177` also calls
`lookupScorecard` directly — and the comment one line above (`scorecard-audit.ts:175`) already names `lookupOnly`,
evidence of stale-comment drift from the U5a planning where the agent intended to compose `lookupOnly` and the comment
shipped without the call swap.

The structural payoff is the same as U5b's run-fresh tier:

- One public entry point for the read tier, one for the run-fresh tier, one home for any future evolution (retry,
  cache-key shape, telemetry hooks) that should land identically on every consumer.
- The "MCP and the human form share an orchestration core" contract is enforced by structure on both tiers, not just the
  run-fresh tier.
- The next refactor in this neighborhood (telemetry-shape evolution, share-URL derivation rules, content-negotiation
  hooks) lands once instead of three times.

The risk is structurally bounded:

- `lookupOnly`'s signature and `LookupOnlyOptions` (`{ specVersion: string; skipCache?: boolean }`) match the call shape
  every existing consumer passes today.
- The branch-scoped URL skip in handler.ts (`isBranchScopedUrl` short-circuit at line 384-385) stays HTTP-tier-specific
  and continues to live in handler.ts; it is upstream of the lookup call, not inside it.
- The telemetry mutation `cache_pre_attempted = true` (handler.ts:382) also stays in handler.ts; it is upstream of the
  lookup call.

Mechanical refactor, structurally identity-equivalent. The plan exists for traceability and risk-isolation across two
test surfaces, not because the work is non-obvious.

## Requirements

- **R1. Behavioral parity.** Every `/api/score` and MCP `score_cli` response remains byte-identical to the pre-refactor
  baseline. The existing handler test suite (~3,360 lines) and the MCP audit test suite
  (`tests/worker-mcp-audit.test.ts`) stay green; no new test scenarios are required because `lookupOnly` is an
  identity-equivalent wrapper.
- **R2. Read-tier code-path symmetry.** All three read-tier consumers (`src/worker/score/handler.ts`,
  `src/worker/mcp/tools/scorecard-audit.ts`, `src/worker/mcp/tools/scorecard-read.ts`) compose `lookupOnly`. Zero direct
  calls to `lookupScorecard` remain outside `src/worker/score/orchestrate.ts` (which still imports `lookupScorecard`
  internally — that import is the implementation detail, not the public entry point).
- **R3. Dead-import cleanup.** After the swap, neither `handler.ts` nor `scorecard-audit.ts` imports `lookupScorecard`
  from `registry-lookup.ts`. TypeScript's unused-import diagnostic catches the floor; a manual `grep` confirms the
  ceiling.
- **R4. Stale-comment sweep.** Three stale prose references to `lookupScorecard` in `src/worker/score/handler.ts` (the
  module-header docstring at line 7, and the tier-2-policy comments at lines 372 and 375) are updated to name
  `lookupOnly` so the code and the comments agree. `src/worker/mcp/tools/scorecard-audit.ts:175` already names
  `lookupOnly` correctly (stale-comment-from-U5a-planning evidence noted in Problem Frame) and needs no change.

## Key Technical Decisions

### KTD-1. Two units, one PR to `dev`, two commits (U1 then U2)

The two call sites live in different test surfaces (handler.ts → `tests/score-handler*.test.ts`; scorecard-audit.ts →
`tests/worker-mcp-audit.test.ts`) and can land independently. Splitting into two commits gives each swap its own clean
diff and keeps the regression net visible per surface, mirroring U5b's two-commit shape. One PR ships both because the
unit of work is "read-tier symmetry across all consumers", and shipping one half would leave the structural argument
incomplete.

The order (U1 handler.ts → U2 scorecard-audit.ts) is by blast-radius descending: handler.ts is the public HTTP API and
the larger test surface; landing it first and re-running the full suite catches any surprise before the smaller MCP swap
touches the second test surface. The units have no inter-dependency; reverse order would also work.

### KTD-2. `lookupOnly` stays the public entry point; `lookupScorecard` stays the underlying implementation

`lookupOnly` was deliberately introduced in U3 of the MCP endpoint plan as the orchestrator-public symmetric counterpart
to `runFreshOnly`. `lookupScorecard` is the registry-lookup module's lower-level implementation, used internally by
`lookupOnly` and (after this plan) by no one else. The plan does NOT delete `lookupScorecard` or hide it behind a
private export — it is the canonical implementation of the registry-fast-path-plus-R2-cache-lookup decision, and
`lookupOnly` is its thin orchestrator-public wrapper.

`scorecard-read.ts` (the third read-tier consumer) already composes `lookupOnly` correctly (line 104); no change there.
The plan touches the two consumers that drifted, not the one that did not.

### KTD-3. Branch-scoped URL skip and `cache_pre_attempted` telemetry stay in handler.ts

`handler.ts:381-389` short-circuits the read-tier lookup for branch-scoped github URLs (`isBranchScopedUrl ? ({ kind:
'miss' } as const) : await lookupScorecard(...)`) and sets the `cache_pre_attempted` telemetry flag upstream of the
call. Both are HTTP-tier-specific: MCP consumers do not branch-scope URLs and do not emit `cache_pre_attempted`. Lifting
either into `lookupOnly` would force the MCP consumers to either ignore HTTP-tier-specific concepts or carry
HTTP-tier-specific code paths. The swap preserves the upstream-of-lookup structure: handler.ts does its skip, sets its
telemetry, and then calls `lookupOnly` instead of `lookupScorecard` for the non-skip path.

### KTD-4. No new tests are added

`lookupOnly` is structurally identity-equivalent to `lookupScorecard` (orchestrate.ts:84 forwards every argument
unchanged and returns the same `ScorecardLookupResult` union). The existing test coverage for both call sites (handler
suite ~3,360 lines, MCP audit suite ~495 lines, MCP get_scorecard suite covering `lookupOnly` via `scorecard-read.ts`)
cannot drift because the wrapper cannot drift the behavior. Adding new tests for "lookupOnly works the same as
lookupScorecard" would be tautological — the wrapper IS the equivalence.

This contrasts with U5b's U1, which added two pin tests because `runFreshOnly` was a meaningful behavioral consolidation
across seven envelope-classification branches with one thin coverage seam (`incomplete_response_contract.details` exact
strings). The read-tier swap has no such seam.

## Implementation Units

### U1. Swap handler.ts to compose `lookupOnly`

**Goal.** `src/worker/score/handler.ts` calls `lookupOnly` instead of `lookupScorecard` at its pre-discovery cache tier.
The branch-scoped URL skip and `cache_pre_attempted` telemetry mutation stay upstream of the call; only the lookup
expression itself changes. The import for `lookupScorecard` is removed from `registry-lookup`'s import block; an import
for `lookupOnly` joins the existing `runFreshOnly` import from `./orchestrate`. Stale prose comments at lines 372 and
375 are updated to name `lookupOnly`.

**Requirements:** R1, R2, R3, R4.

**Dependencies:** none.

**Files:**

- `src/worker/score/handler.ts` (modify — drops `lookupScorecard` from the `./registry-lookup` import group; adds
  `lookupOnly` alongside the existing `runFreshOnly` import from `./orchestrate`; the read-tier call site at line 386
  swaps `lookupScorecard(...)` → `lookupOnly(...)`; three stale prose references update to name `lookupOnly` — the
  module-header docstring at line 7, plus the tier-2-policy comments at lines 372 and 375. Approximate line numbers may
  drift by ±5 from current head; the verification grep is the floor.)
- `tests/score-handler.test.ts`, `tests/score-handler-branch-and-norelease.test.ts`,
  `tests/score-handler-share-url.test.ts`, `tests/score-handler-share-url-post-discovery.test.ts` (unchanged — the
  ~3,360-line read-tier coverage runs as the regression net; do not edit)

**Approach.** Mechanical. The call signature does not change — `lookupOnly`'s parameter list and `LookupOnlyOptions`
shape (`{ specVersion: string; skipCache?: boolean }`) match the existing `lookupScorecard` call at handler.ts:386-389
exactly. The TypeScript build is the floor (an unused-import diagnostic on `lookupScorecard`, plus the swap site
itself); a manual `grep` for `lookupScorecard` in handler.ts confirms zero remaining references.

**Patterns to follow.**

- `src/worker/mcp/tools/scorecard-read.ts:104` is the structural template — it already composes `lookupOnly` with the
  same call shape (minus the `skipCache` option, which is HTTP-tier-specific and stays in the handler call).
- `src/worker/score/orchestrate.ts:77-85` is the wrapper definition; reading it confirms the identity equivalence.
- The U5b refactor's two-commit landing pattern (U5b PR #172) is the local precedent for this plan's two-unit shape.

**Test scenarios.** The 3,360-line existing handler test suite is the regression net for U1. Specific assertions that
load-bear the read-tier behavior:

- `tests/score-handler.test.ts` § "registry fast-path" (lines 314-358) — POST `{input: "ripgrep"}` returns 200
  `registry_hit` with the response triad; GET variants for read-only paths. Confirms the curated branch of the lookup
  result handling.
- `tests/score-handler.test.ts` § "input validation" (lines 277-308) — validation rejects do not reach the lookup. No
  lookup change should affect these; included as a sanity check.
- `tests/score-handler-branch-and-norelease.test.ts` cache_pre tier assertions — round-1 hit on install-command, round-1
  miss + round-2 hit on github-url-without-hint. Confirms `lookupOnly` returns the same `kind: 'cached'` envelope
  `lookupScorecard` returned today.
- `tests/score-handler-branch-and-norelease.test.ts` branch-scoped URL coverage — the `isBranchScopedUrl` short-circuit
  at handler.ts:384-385 still bypasses the lookup entirely; assertions on branch-scoped behavior must stay green.
- `tests/score-handler-share-url.test.ts` and `tests/score-handler-share-url-post-discovery.test.ts` — share-URL
  derivation through cache_pre and cache_post tiers. The stale-derivation precedent from PR #100 (named in U5b's Risk 1)
  lives in this same handler; the share-URL test files are the canonical guard against the failure mode and must stay
  green.

**Test expectation: none added (U1).** Per KTD-4.

**Verification.**

- `bun test` returns the pre-refactor baseline pass count (884 post-U5b) with 0 failures.
- `bun run build` succeeds with no warnings.
- `bunx wrangler deploy --dry-run --env staging` succeeds.
- `grep -n "lookupScorecard" src/worker/score/handler.ts` returns zero matches (code AND comments — the stale-comment
  sweep is in scope).
- TypeScript's unused-import diagnostic reports zero remaining unused symbols.

---

### U2. Swap scorecard-audit.ts to compose `lookupOnly`

**Goal.** `src/worker/mcp/tools/scorecard-audit.ts` (the MCP `score_cli` tool) calls `lookupOnly` instead of
`lookupScorecard` at its registry+cache tier (line 177). The comment at line 175 already names `lookupOnly` — the swap
aligns the code with what the comment has been claiming since U5a. The import for `lookupScorecard` is removed from the
orchestrate import group; `lookupOnly` joins the existing `runFreshOnly` import.

**Requirements:** R1, R2, R3, R4.

**Dependencies:** none. (U1 is sequenced first by KTD-1 for blast-radius isolation, not because U2 depends on U1.)

**Files:**

- `src/worker/mcp/tools/scorecard-audit.ts` (modify — line 44 drops `lookupScorecard` from the orchestrate-import group
  and adds `lookupOnly`; line 177 swaps `lookupScorecard(...)` → `lookupOnly(...)`; line 175 comment already names
  `lookupOnly` — no change needed if the comment is accurate post-swap)
- `tests/worker-mcp-audit.test.ts` (unchanged — full MCP `score_cli` test surface runs as the regression net; do not
  edit)

**Approach.** Same mechanical shape as U1, smaller blast radius. The call at scorecard-audit.ts:177 passes `{
specVersion: SPEC_VERSION }` (no `skipCache`); `lookupOnly`'s `LookupOnlyOptions` makes `skipCache` optional, so the
call shape is identical.

**Patterns to follow.**

- U1's landing — same swap shape, applied here second. If U1 surfaced any subtlety, U2 reuses the resolution.
- `src/worker/mcp/tools/scorecard-read.ts:104` — the long-standing `lookupOnly` composition shape inside the MCP tool
  layer.

**Test scenarios.** `tests/worker-mcp-audit.test.ts` is the regression net for U2. Specific assertions that load-bear
the read-tier behavior on this surface:

- The `score_cli` registry-hit path — input that resolves to a curated registry entry should bounce at the lookup tier
  with `audited: false, source: 'registry'`. Confirms the curated branch of the new `lookupOnly` result handling.
- The `score_cli` cached-hit path — input whose R2 cache key resolves should bounce with `audited: false, source:
  'live-cache'`. Confirms the cached branch.
- The `score_cli` miss path — input that misses both tiers continues to the audit path (`MCP_AUDIT_LIMITER`, KV hourly
  budget, then `runFreshOnly`). Confirms that switching from `lookupScorecard` to `lookupOnly` does not change the miss
  kind, which is the trigger for the rate-limited audit path.

**Test expectation: none added (U2).** Per KTD-4.

**Verification.**

- `bun test` returns the pre-refactor baseline pass count with 0 failures.
- `bun run build` succeeds with no warnings.
- `bunx wrangler deploy --dry-run --env staging` succeeds.
- `grep -n "lookupScorecard" src/worker/mcp/tools/scorecard-audit.ts` returns zero matches.
- `grep -rn "lookupScorecard" src/` returns matches only inside `src/worker/score/orchestrate.ts` (where it is the
  internal implementation of `lookupOnly`) and `src/worker/score/registry-lookup.ts` (where it is exported as the
  module's API). Zero matches in handler.ts, scorecard-audit.ts, or scorecard-read.ts.

---

## Scope Boundaries

### In scope

- `src/worker/score/handler.ts` line 386 read-tier call swapped to `lookupOnly`.
- `src/worker/mcp/tools/scorecard-audit.ts` line 177 read-tier call swapped to `lookupOnly`.
- Stale prose comments in both files updated to name `lookupOnly` where they reference the call.
- Dead-import cleanup of `lookupScorecard` from both files.

### Outside this product's identity

- Any change to the `/api/score` wire contract or MCP `score_cli` tool contract. The whole point is byte-identical
  observable behavior; if a change would produce a wire diff, it does not belong in this plan.
- Any change to `src/worker/score/registry-lookup.ts` (the module that exports `lookupScorecard` as its public API).
  `lookupScorecard` is the implementation of the registry-fast-path-plus-R2-cache-lookup decision; this plan does not
  touch it.
- Any change to `src/worker/mcp/tools/scorecard-read.ts`. It already composes `lookupOnly` correctly; the plan
  reinforces the symmetry it already follows.
- Any new tests. KTD-4 documents why none are needed given the identity-equivalence of `lookupOnly`.

### Deferred to follow-up work

- **Capturing the two-phase orchestrator-extraction pattern as a `docs/solutions/` entry via `/ce-compound`.** The
  pattern (extract orchestrator + ship one consumer first; migrate the other consumers in a follow-up plan) recurred
  across U3/U5a/U5b/this plan. The user named it explicitly in the post-U5b summary; queued as a separate `/ce-compound`
  invocation after this plan ships.
- **Broader live-scoring orchestrator evolution** (telemetry-shape changes, retry middleware, cache-key shape
  revisions). Lands in `orchestrate.ts` once and surfaces on all three consumers because of the symmetry this plan
  completes. Out of scope here.

---

## Risks

### Risk 1: Hidden behavioral drift in `lookupOnly`

`lookupOnly` is documented as a thin wrapper around `lookupScorecard`, but if a future edit to `lookupOnly` introduced a
transformation (input mangling, return-value mapping, error swallowing), the swap would silently pick it up.

**Mitigation.** The wrapper is read-during-planning at `src/worker/score/orchestrate.ts:77-85` and is provably
identity-equivalent today (the body is a single `return lookupScorecard(input, env, registryIndex, hintsIndex, opts);`).
Future edits would need to honor the wrapper-is-identity contract; if they do not, the regression surface is the same
test suite this plan exercises. Risk is theoretical; no current mitigation needed beyond the existing test coverage.

### Risk 2: Stale-comment sweep overshoot

R4's stale-comment cleanup on `handler.ts` (lines 7, 372, 375) is the smallest possible prose change. If the agent
rewrites the surrounding paragraphs (which discuss tier-2 cache semantics, the policy intent of `cache_pre_attempted`,
the unified scorecard-lookup module-header overview, etc.), the diff bloats and the review surface widens.

**Mitigation.** Sweep is keyed on the literal token `lookupScorecard`. The surrounding prose stays as-is unless the
literal token swap renders a sentence ungrammatical (in which case the minimum correction applies). The diff stat should
show ≤10 lines changed per file across all swap and comment work combined.

### Risk 3: `grep` false positives from comment-only references in other files

`grep -rn "lookupScorecard" src/` may surface incidental mentions in docstrings or prose elsewhere in the codebase
(e.g., the `loadHintsIndex` doc comment, AGENTS.md fragments, or solution docs). The R3 verification grep is scoped to
handler.ts and scorecard-audit.ts specifically to avoid this.

**Mitigation.** The R2 verification grep (`grep -rn "lookupScorecard" src/`) excludes orchestrate.ts and
registry-lookup.ts by design; the only legitimate sites for the literal token after this plan are inside those two
files. Any other match is either a stale prose reference (sweep it) or a genuine code call (not expected, but if
surfaced, escalate to plan revision).

---

## Verification

The plan is implemented and ready to ship when:

1. The branch `refactor/lookuponly-read-tier-symmetry` (or equivalent conventional name;
   `feat/lookuponly-read-tier-symmetry` is also acceptable since the change advances the symmetry contract) carries two
   commits matching U1 and U2.
2. `bun test` reports the pre-refactor baseline pass count (884 post-U5b) with 0 failures.
3. `bun run build` succeeds with no warnings.
4. `bunx wrangler deploy --dry-run --env staging` succeeds.
5. `grep -n "lookupScorecard" src/worker/score/handler.ts` returns zero matches.
6. `grep -n "lookupScorecard" src/worker/mcp/tools/scorecard-audit.ts` returns zero matches.
7. `grep -rn "lookupScorecard" src/` returns matches only inside `src/worker/score/orchestrate.ts` and
   `src/worker/score/registry-lookup.ts`.
8. The PR opens against `dev` and CI passes on the standard `ci.yml` gate.

Production cutover rides the next `release/*` cherry-pick. No special operational steps; no env-var changes; no
migration; no rollout coordination. Same release shape as U5b PR #172.

---

## Sources & Research

### Origin

- The U5b plan:
  [`docs/plans/2026-06-05-002-refactor-handler-runfresh-adoption-plan.md`](./2026-06-05-002-refactor-handler-runfresh-adoption-plan.md).
  Its "Deferred to Follow-Up Work" subsection named the handler.ts call site as the outstanding read-tier asymmetry;
  this plan's recon expanded scope to also cover `scorecard-audit.ts` (the second drifted consumer the U5b note
  overlooked).
- The MCP endpoint plan:
  [`docs/plans/2026-06-05-001-feat-mcp-endpoint-plan.md`](./2026-06-05-001-feat-mcp-endpoint-plan.md). U3 shipped
  `lookupOnly` as the read-tier orchestrator entry point; this plan completes that decision's consumer rollout.

### Local research (Phase 1)

- Repo recon: read `src/worker/score/handler.ts:381-389` (the call site and its upstream branch-scope + telemetry
  context), `src/worker/score/orchestrate.ts:77-85` (the wrapper, provably identity-equivalent),
  `src/worker/mcp/tools/scorecard-audit.ts:170-205` (the second drifted call site plus its stale comment at line 175),
  and `src/worker/mcp/tools/scorecard-read.ts:91-118` (the existing correctly-symmetric consumer that serves as the
  structural template).
- Institutional learnings: `qmd query --collection solutions` surfaced one relevant precedent —
  [`stale-derivations-across-tier-migrations.md`](../solutions/architecture-patterns/stale-derivations-across-tier-migrations.md)
  (the same precedent U5b cited in its Risk 1). The byte-identical-verification preflight pattern applies in spirit to
  this refactor too, though the structural identity of `lookupOnly` makes the procedural diff less load-bearing here
  than it was for U5b.

### External research

- None. The refactor is local-pattern application; no external API surface, no library decision, no novel architecture.
  Strong local precedent (U5b's two-commit landing shape, scorecard-read.ts's existing `lookupOnly` composition) covers
  the design space.
