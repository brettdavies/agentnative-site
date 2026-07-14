---
title: "fix: Restore the live-scoring Sandbox DO two-phase egress lockdown"
type: fix
date: 2026-07-14
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
priority: high
---

# fix: Restore the live-scoring Sandbox DO two-phase egress lockdown

## Summary

`src/worker/score/do.ts` ships `override interceptHttps = false`. With the CF Sandbox SDK's HTTPS interception off,
container outbound HTTPS bypasses the named outbound handlers (`allowedInstall`, `noHttp`) entirely, so the two-phase
egress model is inert in production: the Phase-1 install hostname allowlist is unenforced and the Phase-2 `noHttp`
total-egress block is gone. The live-scoring path runs `anc audit` on arbitrary user-supplied binaries and install
commands, so the audit-time egress block is a load-bearing security invariant, and it is currently disabled on anc.dev.

Flip `interceptHttps` back to `true`, prove installs still succeed across every supported package manager on staging
(the reason it was disabled was registry 403s on the CF Worker IP pool), apply the documented mitigations if those 403s
return rather than re-disabling, and add a guard so the invariant cannot silently ship off again.

## Problem Frame

The flag was set `false` as a diagnostic in the U6 Sandbox DO install feature (#95) to isolate registry 403/timeout
patterns between the CF Worker IP pool (interception on) and the CF Container IP pool (interception off). The code
comment says "must revert before merge"; it was never reverted and has shipped in every release since, including to
production. The authoritative decision doc
(`docs/solutions/architecture-patterns/cf-sandbox-sdk-egress-intercept-vs-container-direct-2026-05-18.md`, severity
high) states plainly that production must keep interception on because the Phase-2 `noHttp` lockdown depends on it.

The complication: flipping it back may reintroduce the install-time 403s that motivated turning it off. The doc records
two concrete failures from U6 staging diagnostics: `bun add -g prettier` 403'd on the Worker IP pool (worked
container-direct), and `cargo binstall` 403'd on both modes for a separate IPv6/DNS reason. So a naive flip could break
install reliability for some package managers. This plan restores the security invariant while keeping install working,
falling back to documented mitigations rather than re-disabling.

## Requirements

- R1. `interceptHttps` is `true` on the `Sandbox` DO, so the SDK routes container HTTPS through the Worker fetch and the
  `allowedInstall` / `noHttp` outbound handlers fire again.
- R2. Phase-1 install egress is restricted to the per-PM `allowedHostnames` allowlist; a non-allowlisted host during
  install is blocked and emits the structured egress log line.
- R3. Phase-2 (`anc audit`) egress is fully blocked (`noHttp`) so an audited binary cannot reach the network.
- R4. Installs still succeed on staging for every supported package manager (the historical 403 surface), or a
  documented mitigation is applied so they do; the feature is not shipped with a known-broken PM.
- R5. A regression guard fails loudly if `interceptHttps` is ever set back to `false` (or the outbound handlers are
  unwired), so the invariant cannot silently ship disabled again.
- R6. The code comment on `interceptHttps` and the solution doc reflect the resolved state (interception on in
  production) rather than the stale "diagnostic / must revert" framing, and record any mitigation applied.

## Key Technical Decisions

- **KTD-1 (fix vs. re-architecture): flip the flag, keep the SDK egress model.** The two-phase handler design is correct
  and documented; the only defect is the diagnostic flag left on. Do not redesign egress. Restore interception and treat
  the 403 risk as a bounded install-reliability problem, not a reason to abandon Worker-mediated egress.
- **KTD-2 (mitigation ordering): prove first, mitigate only if needed.** Do not pre-build retry logic. Flip the flag,
  run the full-PM staging smoke, and only add per-PM handling for the PMs that actually 403 on the Worker IP pool. This
  keeps the change minimal and avoids speculative complexity (YAGNI), matching the doc's "keep intercept on, be aware
  the cost shows up in retry rates" guidance.
- **KTD-3 (never re-disable to fix a 403): the security invariant outranks install convenience.** If a PM cannot be made
  reliable under interception with reasonable retry/allowlist changes, surface it as a blocker for a deliberate,
  risk-accepted decision rather than silently reverting `interceptHttps`. Re-disabling is off the table as an implicit
  fix.
- **KTD-4 (guard shape): assert the invariant in a unit test, not just a comment.** A test that pins `new
  Sandbox(...).interceptHttps === true` (or asserts the outbound-handler map is wired for the intercept path) turns the
  invariant into CI-enforced state. The `interceptHttps` field is read at DO construction, so a construction or
  static-shape assertion is enough; it does not require the live container.

## Implementation Units

### U1. Restore interception and refresh the comment

- **Goal:** flip `interceptHttps` to `true` and rewrite the stale diagnostic comment to record present state. (R1, R6)
- **Dependencies:** none.
- **Files:** `src/worker/score/do.ts`.
- **Approach:** change `override interceptHttps = false` to `true`. Replace the "DIAGNOSTIC ... must revert before
  merge" comment with a present-state WHY: interception on routes container HTTPS through the Worker fetch so the
  two-phase outbound handlers (`allowedInstall` Phase 1 allowlist, `noHttp` Phase 2 block) enforce egress; link the
  decision doc. Follow the code-comments policy (present-state, no temporal narration).
- **Test scenarios:** covered by U2's guard (the field value is the behavior here). `Test expectation: none beyond U2 —
  single-line state change whose invariant U2 pins.`
- **Verification:** the field reads `true`; `bun run build` and `wrangler deploy --dry-run` stay clean.

### U2. Regression guard for the egress invariant

- **Goal:** a unit test that fails if interception is ever disabled or the outbound handlers are unwired. (R5)
- **Dependencies:** U1.
- **Files:** a new or existing worker test, e.g. `tests/worker-score-do.test.ts` (or extend the nearest existing DO
  test); confirm the actual home during implementation.
- **Approach:** assert `interceptHttps === true` on a constructed `Sandbox` (the class already exports handler shapes
  for test use via `Sandbox.outboundHandlers` / the `handlers` export), and assert the outbound-handler map contains
  `allowedInstall` and `noHttp`. Keep it construction-level (no live container). Name the test so a future flip reads as
  an obvious security regression in CI output.
- **Test scenarios:**
- Happy path: constructed `Sandbox.interceptHttps` is `true`.
- Invariant: `Sandbox.outboundHandlers` (or the wiring set at module load) exposes both `allowedInstall` and `noHttp`.
- Regression intent: flipping the source field to `false` makes this test fail (verify manually once during
    implementation, do not commit the flipped state).
- **Verification:** `bun test` includes the guard and it passes with U1 in place.

### U3. Full-PM install smoke on staging (verification unit)

- **Goal:** prove installs still succeed under interception across every supported package manager, catching any
  pool-specific 403 regression before promotion. (R2, R3, R4)
- **Dependencies:** U1 merged to dev and deployed to staging (interception only exercises on the live container path).
- **Files:** none (uses `scripts/release/preflight.sh do-smoke` / the DO-smoke recipe against staging). If the smoke
  matrix is worth persisting, extend the preflight do-smoke fixture map rather than adding a new script.
- **Approach:** after the staging deploy reaches `ready`, run a fresh non-registry DO smoke per package manager,
  covering the historical 403 surface explicitly: npm, pip, uv, cargo / cargo-binstall, bun, upstream Go, and
  direct-download. For each, confirm the audit returns a full scorecard (not `chain_resolved_install_failed` /
  `anc_audit_failed`). Watch the structured egress logs to confirm `allowedInstall` fired (allowlist enforced) during
  install and that Phase-2 egress was blocked.
- **Execution note:** this is smoke-first verification against the deployed staging Worker, not unit coverage; the bug
  class only reproduces on the live container path.
- **Test scenarios:**
- Each PM: fresh binary installs and scores end-to-end; `source` is a live audit; no install-failure error tier.
- Egress-log assertion: an `allowedInstall` log line appears during install; a blocked-egress line appears if the binary
    attempts network access during audit.
- Negative control: a non-allowlisted host during install is blocked (confirms the allowlist is live, not merely
    present).
- **Verification:** every PM in the matrix scores on staging under interception, with the egress handlers observably
  firing.

### U4. Per-PM mitigation for any 403 regression (conditional)

- **Goal:** if U3 shows a PM 403ing on the Worker IP pool, make it reliable under interception without re-disabling.
  (R4, KTD-2, KTD-3)
- **Dependencies:** U3 results.
- **Files:** `src/worker/score/sandbox-exec.ts` (per-PM install invocation / allowlist), possibly
  `src/worker/score/do.ts` (`allowedInstall` handler retry/pass-through).
- **Approach:** apply the documented mitigations narrowly to the failing PM: add missing allowlist hosts, add bounded
  retry on the pass-through `fetch(req)` for the transient pool-specific 403s, or pin the PM's metadata-fetch mode.
  Prefer the smallest change that makes U3 green. If no reasonable mitigation works, stop and surface it as a blocker
  for a risk-accepted decision (KTD-3) rather than re-disabling interception.
- **Test scenarios:**
- Unit: the retry/allowlist change behaves as intended for the mitigated PM (e.g. a simulated transient 403 is retried
    and succeeds; a hard 403 still fails loudly).
- Re-run U3 for the mitigated PM to green.
- **Verification:** the previously-failing PM scores on staging under interception; the mitigation is scoped to that PM.

### U5. Update the decision doc

- **Goal:** reconcile the solution doc to the resolved state. (R6)
- **Dependencies:** U3 (and U4 if a mitigation was applied).
- **Files:** `docs/solutions/architecture-patterns/cf-sandbox-sdk-egress-intercept-vs-container-direct-2026-05-18.md`.
- **Approach:** the doc's code sample already shows `interceptHttps = true` as correct; add a present-state note that
  production runs with interception on and record any per-PM mitigation applied (which PM, what was changed, why). Keep
  the diagnostic-flip guidance (it is still a valid debugging technique) but make clear the production posture is on.
  Commit in the `solutions-docs` repo per the solutions-repo workflow.
- **Test scenarios:** `Test expectation: none — documentation.`
- **Verification:** the doc no longer implies production may run with interception off.

## Scope Boundaries

- **In scope:** restoring `interceptHttps`, the CI guard, the full-PM staging smoke, minimal per-PM mitigation only for
  regressions U3 surfaces, and the doc reconciliation.
- **Out of scope / Deferred to Follow-Up Work:** a broader egress-observability or alerting layer; changing the
  allowlist model; the CF Containers IPv6/DNS `gai.conf` issue except where it directly blocks a PM in U3 (it has its
  own solution doc). Do not fold unrelated `do.ts` cleanup into this change.

## Risks & Dependencies

- **Install reliability regression (primary risk):** interception may reintroduce Worker-IP-pool 403s for bun /
  cargo-binstall. Mitigated by U3 (catch on staging before prod) and U4 (fix narrowly, never re-disable).
- **Latency:** Worker-mediated egress adds a fetch round-trip per container HTTPS request; install-heavy PMs pay more.
  Accepted for the security model per the decision doc; watch the DO budget in U3.
- **Verification only reproduces on the live path:** the guard (U2) pins state, but true behavior needs the staging
  container smoke (U3); unit tests cannot prove the 403 outcome.

## Verification Contract

- `interceptHttps === true` guarded by a passing unit test (U2); `bun test` green.
- Staging DO smoke green across npm, pip, uv, cargo/cargo-binstall, bun, Go, direct (U3), with `allowedInstall` observed
  firing and Phase-2 egress blocked.
- `bun run build` and `wrangler deploy --dry-run` (both envs) clean.
- Decision doc reconciled (U5).
- Ships via the standard flow: fix branch to dev (staging deploy), full-PM staging smoke, then release to main; the
  production DO smoke in postflight confirms interception on prod.

## Definition of Done

Production runs the live-scoring container with `interceptHttps = true`, the two-phase egress handlers enforce install
allowlisting and audit-time egress blocking, every supported package manager installs and scores on staging under
interception, a CI guard prevents silent re-disabling, and the decision doc reflects the resolved posture.

## Sources & Research

- `docs/solutions/architecture-patterns/cf-sandbox-sdk-egress-intercept-vs-container-direct-2026-05-18.md` — the
  authoritative decision (severity high; production must keep interception on; the two U6 failure examples and their
  mitigations).
- `docs/solutions/integration-issues/cf-containers-ipv6-hangs-force-ipv4-precedence-2026-05-18.md` — the companion
  IPv6/DNS resolver issue that intercept-off-as-diagnostic helped isolate (relevant if cargo/uv/go 403 in U3).
- `src/worker/score/do.ts` (`interceptHttps`, `allowedInstall`, `noHttp`, `Sandbox.outboundHandlers`),
  `src/worker/score/sandbox-exec.ts` (two-phase install with `allowedHostnames`).
- Origin of the flag: #95 (feat U6 Sandbox DO install + score with two-phase egress).
