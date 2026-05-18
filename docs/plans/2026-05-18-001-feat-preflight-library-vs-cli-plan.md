---
title: 'feat: Pre-flight library-vs-CLI detection for live-scoring install-command inputs'
type: feat
status: active
date: 2026-05-18
origin: U6 follow-up (no upstream brainstorm doc; tactical scope captured in chat handoff from the U6 PM-coverage session, 2026-05-18)
---

# feat: Pre-flight library-vs-CLI detection (U6 follow-up)

> **Triage note.** This plan exists to TRIAGE the UX-vs-wastefulness trade-off and capture an implementation path IF
> the user decides to build. The recommendation in Key Technical Decisions is **defer until telemetry justifies it**.
> The plan does NOT presume "yes, build it." Implementation Units are still defined so the build path is clear when
> the decision rolls back to "yes."

---

## Summary

U6's live-scoring path currently uses a **reactive** library-vs-CLI check: when a user posts `pip install requests` or
`npm install -g lodash` or `cargo binstall <library-only-crate>`, the orchestration provisions a Sandbox DO, runs the
install (5-15 s), and only then discovers via `which <binary>` that the package was a library with no command-line entry
point. The user gets a `chain_resolved_no_binary_produced` bounce after spending container time + egress that could have
been avoided. The Step 3 distributions helpers in `src/worker/score/discover-binary.ts` already make the same
`bin_names` / `bin` / `console_scripts` checks for github-URL inputs — pre-flight would extend that pattern to
install-command inputs.

This plan triages whether the polish (sharper error, ~5-15 s faster bounce, ~$0.0001-0.0005 saved per library request)
is worth the implementation cost (~2-3 hours), the new code surface (~200-400 lines), the per-CLI-request latency tax
(~200-500 ms pre-flight API call paid by every install-command POST, CLI or library), and the ongoing API-drift
maintenance burden (pypi added the `.metadata` fast-path that broke us; crates.io rotated to sparse index — pre-flight
code tracks upstream API contracts forever after).

Recommendation lands in Key Technical Decisions below.

---

## Problem Frame

**Today's behavior.** A user posts `pip install requests` to `/api/score`. The handler validates, mints a session,
passes rate-limit, dispatches to the Sandbox DO. The DO:

1. `resolveSpec(input)` — for install-command input, returns the parsed spec directly (no API check).
2. `sandbox-exec.score(sandbox, spec)` — Phase 1 egress, runs `pip install --break-system-packages requests`. Takes
   ~5-10 s including pypi dep resolution and wheel download.
3. `which requests` — fails (requests is a library with no console_scripts entry).
4. Bounce: `chain_resolved_no_binary_produced binary=requests` (502).

**Cost of the bounce:** ~5-15 s of container compute + egress + the user waiting + a bounced error envelope that doesn't
explain *why* (the message says "we installed it but no command-line entry point appeared" which is honest but not
sharp).

**What pre-flight could change.** Add a step between (1) and (2) that queries the relevant package registry's metadata
API (pypi.org / crates.io / registry.npmjs.org) and checks whether the package declares a CLI entry. If not, bounce
immediately with a new error code `chain_resolved_library_not_cli` and a sharper message ("requests is a Python library,
not a CLI — anc only scores binaries with a help interface"). Total time: ~200-500 ms (one API call) vs ~5-15 s (full
install + which gate).

**Per-PM applicability.** Not every PM has a queryable registry API:

| PM        | Registry API                                     | CLI-vs-library field                                |
| --------- | ------------------------------------------------ | --------------------------------------------------- |
| pip / uv  | `pypi.org/pypi/<pkg>/json`                       | `info.entry_points.console_scripts` non-empty       |
| cargo     | `crates.io/api/v1/crates/<pkg>/<ver>`            | `version.bin_names` non-empty array                 |
| npm / bun | `registry.npmjs.org/<pkg>/latest`                | `bin` field present (string or non-empty object)    |
| go        | (no central manifest — would need to clone repo) | stays reactive                                      |
| direct    | (URL is the user's intent — trust it)            | stays reactive                                      |
| brew      | Routed through discovery chain (already)         | discovery's existing Step 3 already does this check |

So pre-flight covers pip/uv/cargo/npm/bun, leaving go + direct on the reactive path.

---

## Scope Boundaries

**In scope (if built):**

- Pre-flight metadata check before container exec for pip / uv / cargo / npm / bun install-command inputs.
- New error code `chain_resolved_library_not_cli` with sharp PM-specific message.
- Shared registry-fetch helpers with `src/worker/score/discover-binary.ts` Step 3 distributions (no duplication).
- Test coverage: per-PM happy (CLI) + library (entry-points missing) paths.

**Out of scope:**

- go and direct PMs stay reactive (no central manifest / user-pasted URL = trust intent).
- U8 bounce-state-CTA UI rendering for the new error code — separate follow-up unit on U8 (the CTA table in U8's plan
  body needs a fourth row).
- Caching pre-flight results (each request hits the registry API fresh; same caching tier as Step 3 distributions, which
  is none today).
- Heuristic library detection for github URLs already covered by Step 3.

### Deferred to Follow-Up Work

- Pre-flight for go (would require cloning the repo or scraping pkg.go.dev — far more expensive than the install itself;
  defer indefinitely unless go-library inputs become a measurable bounce class).
- Telemetry on library-input rate (the trigger that would justify building this — see Key Technical Decisions below).

---

## Context & Research

### Relevant Code and Patterns

- **`src/worker/score/do.ts:resolveSpec()` (~line 166)** — natural hook point. Pre-flight runs after spec resolution but
  before `sandbox-exec.score()` dispatch. Returns `{ok: false, error: 'chain_resolved_library_not_cli'}` on library hit;
  otherwise passes through to existing flow.
- **`src/worker/score/discover-binary.ts:step3_distributions()` (~line 223)** — already makes the same fetches for
  github-URL inputs. Per-registry helpers (`crates.io/api/v1/crates/.../bin_names`, `registry.npmjs.org/.../bin`,
  `pypi.org/.../console_scripts`) are the exact shape pre-flight needs. Refactor: extract per-PM "is-cli" predicates
  into shared helpers callable from both Step 3 and the new pre-flight module.
- **`src/worker/score/response-shape.ts`** — `ScoreError` union; add `chain_resolved_library_not_cli` variant + map to a
  status code (502, same class as other resolved-but-uninstallable bounces).
- **`src/worker/score/handler.ts:mapDoError()`** — needs the new code mapped to the user-facing error envelope. New
  ScoreError variant flows through automatically once added to the union.

### Institutional Learnings

- **`docs/solutions/integration-issues/wrangler-routes-inheritance-staging-custom-domain-drift-2026-05-15.md`** —
  pattern: external API contracts (CF, pypi, crates.io) shift without notice. Pre-flight code that depends on those
  contracts is fragile by construction.
- **U6 PR-coverage findings (this session, 2026-05-18)** — already observed two upstream-API shifts this year:
- PyPI's `.metadata` fast-path returned 403 from CF egress IPs for certain wheels (Bug M, current PR).
- cargo's sparse index rotation moved metadata to `index.crates.io` (Bug H, current PR).

Pre-flight inherits both as ongoing maintenance commitments.

### External References

- [PyPI JSON API](https://warehouse.pypa.io/api-reference/json.html) — `info.entry_points` shape.
- [crates.io API](https://crates.io/data-access) — `version.bin_names` field documentation.
- [npm registry API](https://github.com/npm/registry/blob/master/docs/REGISTRY-API.md) — `bin` field semantics.

---

## Key Technical Decisions

### Triage: is pre-flight worth building?

**Aggregate wall-clock savings.** Assume Show HN steady-state of 100 POSTs per hour with the following mix:

- 70% github-URL or registry-slug inputs → no install-command pre-flight relevance, current path unchanged.
- 27% install-command inputs that resolve to CLIs → CLI happy path. Pre-flight ADDS 200-500 ms per request before the
  install runs. Net: SLOWER by ~270 ms × 27 = ~7 s per 100 POSTs.
- 3% install-command inputs that resolve to libraries → library bounce. Pre-flight saves ~5-15 s (the install we no
  longer run). Net: ~30 s saved per 100 POSTs (10 s avg × 3 inputs).

**Net per 100 POSTs:** ~30 s saved on the 3% library bounces, ~7 s added to the 27% CLI installs. **Net wall-clock
savings: ~23 s per 100 POSTs, ~14 s per hour, ~5.6 min per day** at the assumed traffic.

The savings is real but small. The bigger wins are qualitative:

- **Sharper error messages.** "X is a Python library, not a CLI" beats "we installed it but no command-line entry point
  appeared." Users learn faster why their input failed.
- **Catching obvious user errors before egress.** A user who pastes `pip install rich` (a Python LIBRARY) gets a helpful
  bounce in 500 ms instead of an opaque one in 10 s.

**Container cost savings.** Negligible at expected traffic (~$0.0001-0.0005 per saved library install × 3-5/hr =
$0.0003-0.0025/hr saved = under $2/mo even at 10x the assumed traffic). Not a budget motivator.

**Implementation cost.** ~2-3 hours agent time. Three PMs × ~30-45 min each + new error code wiring + tests +
shared-helper refactor of Step 3.

**Ongoing maintenance.** ~200-400 lines of pre-flight code that tracks upstream API contracts. Drift is a real risk:
this session already documented two API-contract shifts (pypi `.metadata`, crates.io sparse index) that needed code
changes. Pre-flight code adds permanent surface area.

**Latency tax on CLI installs.** Every install-command POST pays ~200-500 ms of pre-flight regardless of outcome. CLI
installs (the common case) get NO benefit but pay the cost. Library bounces (rare) get the savings. At 27% CLI vs 3%
library, the latency tax outweighs the bounce savings by ~9x.

**Recommendation: DEFER until telemetry justifies it.** Build a lightweight telemetry pass first (Workers Analytics
Engine write per POST with input.kind + outcome + duration) to measure the actual library-input rate. Reconsider
pre-flight only if:

- Library-input rate exceeds 10% of install-command traffic (vs the assumed 3%), AND
- User complaints about slow library bounces surface in feedback, OR
- A specific high-traffic library input (e.g. `pip install requests` from a misclick or tutorial copy-paste) becomes
  visible in operational logs.

The implementation path below is defined so the build is clear IF the trigger fires — but the build is conditional, not
assumed.

### Alternative Approaches Considered

**Alt 1: Pre-flight only.** Reject every library input via the registry API check; never run the install for libraries.
Adds ~200-500 ms to every CLI install (the common case) for a savings on the library case (rare). Net small. Adds
maintenance surface. Recommended only if telemetry shows libraries are >10% of traffic.

**Alt 2: Reactive only (current state).** Library inputs run the install then bounce on the `which` gate. Wastes ~5-15 s
per library bounce. Simpler code, no API-drift surface, no latency tax on CLIs. Current default.

**Alt 3: Hybrid (pre-flight on cache hit, reactive on miss).** Maintain a small KV cache of "pkg X is a library" results
from prior bounces. Pre-flight checks cache first (~1 ms); if hit AND the result is "library", bounce immediately.
Otherwise fall through to reactive install. Net: zero added latency on the common case (KV cache miss); fast bounce on
the second time a library is requested. Adds cache management complexity and a stale-entry risk (packages add CLI
binaries in new versions; cached "library" result becomes wrong).

**Alt 4: Pre-flight with reactive fallback.** Pre-flight runs synchronously; if the API call fails / times out / is
inconclusive, fall through to reactive install. Belt-and-suspenders but doubles the latency on every install-command
POST. Probably never the right default — costs CLIs to maybe save libraries.

**Picked:** None right now. Build NONE of these until telemetry justifies. If telemetry justifies, Alt 1 (pre-flight
only) is the simplest and cleanest path.

### New Error Code: `chain_resolved_library_not_cli`

If pre-flight is built, add a fourth variant to the `chain_resolved_*` bounce class (currently three per gate F4 in the
U6 plan):

- `chain_no_resolve` — "we couldn't find a pre-built binary"
- `chain_resolved_install_failed` — "found an install path, but it didn't run"
- `chain_resolved_no_binary_produced` — "installed cleanly but no command-line entry point appeared"
- `chain_resolved_library_not_cli` — NEW: "this is a library, not a CLI" (pre-flight bounce)

The fourth row needs U8 bounce-state-CTA copy — a separate follow-up unit on U8's plan body.

### Status Code Mapping

`chain_resolved_library_not_cli` → 502 (same class as other resolved-but-uninstallable bounces). This keeps the HTTP
class consistent with the existing bounce family; the differentiation happens via the error envelope, not the status
code.

---

## Implementation Units

> **All units below are conditional on the triage outcome (Key Technical Decisions §1) flipping to "yes, build it."**
> If telemetry shows pre-flight is justified, units execute in dependency order. Otherwise this section is reference
> material for a future revisit.

### U1. Extract per-PM is-cli predicates from discover-binary.ts Step 3

**Goal:** Refactor the `bin_names` / `bin` / `console_scripts` checks in `step3_distributions()` into named per-PM
helpers callable from both Step 3 (existing) and the new pre-flight module (U2). No behavior change at this unit; the
test suite for `score-discover-binary.test.ts` must pass unchanged.

**Requirements:** Foundation for U2, U3, U4. Avoids duplicating registry-fetch logic.

**Dependencies:** None.

**Files:**

- Modify: `src/worker/score/discover-binary.ts` — extract `cratesIsCli(crateName, deadline)`, `npmIsCli(pkgName,
  deadline)`, `pypiIsCli(pkgName, deadline)` named helpers (each returns `{isCli: boolean; reason?: string}`). Step 3's
  tightness checks call into these helpers instead of inlining the fetches.
- Modify: `tests/score-discover-binary.test.ts` — no test additions required; behavior preserved. If the refactor is
  clean, existing tests pass without modification.

**Approach:**

Pull the per-PM logic out of `step3_distributions()` into module-level functions. Each helper takes a package name and a
deadline; returns `{isCli, reason?}`. Step 3's existing per-PM `*Tight` logic calls the helper; pre-flight (U2) calls
the helper. Shared fetch + same field-check.

**Patterns to follow:**

- `src/worker/score/discover-binary.ts:step3_distributions()` (current per-registry inline logic)

**Test scenarios:**

- All existing `tests/score-discover-binary.test.ts` Step 3 tests pass unchanged (behavior-preservation refactor).
- New helper-level tests:
- `cratesIsCli('ripgrep', deadline)` → `{isCli: true}` (mocked crates response with bin_names).
- `cratesIsCli('serde', deadline)` → `{isCli: false, reason: 'crate_is_library_only'}` (mocked crates response with
  empty bin_names).
- `npmIsCli('typescript', deadline)` → `{isCli: true}` (mocked npm response with bin field).
- `npmIsCli('lodash', deadline)` → `{isCli: false, reason: 'no_bin_field'}` (mocked npm response without bin).
- `pypiIsCli('black', deadline)` → `{isCli: true}` (mocked pypi response with console_scripts).
- `pypiIsCli('requests', deadline)` → `{isCli: false, reason: 'no_console_scripts'}`.
- Each helper returns `{isCli: false, reason: 'api_unreachable'}` when the fetch times out (deadline exceeded).

**Verification:** Step 3 tests still pass. Helper signatures are stable and reused by U2.

---

### U2. Pre-flight check in do.ts:resolveSpec for pip / uv / cargo / npm / bun

**Goal:** Before dispatching to `sandbox-exec.score()`, query the relevant PM registry API for install-command inputs
and return `chain_resolved_library_not_cli` if the package is a library.

**Requirements:** Reduces library-input wall-clock from ~5-15 s to ~200-500 ms; produces a sharper error envelope.

**Dependencies:** U1.

**Files:**

- Modify: `src/worker/score/do.ts` — add pre-flight branch in `resolveSpec()`. For `kind: 'install-command'` and `pm in
  [pip, cargo-binstall, npm, bun]` (uv inputs already parse as pm=pip per U4 parse-install), call the U1 helper. If
  `isCli: false`, return `{ok: false, error: 'chain_resolved_library_not_cli', details: 'pm=<pm> pkg=<pkg>
  reason=<helper.reason>'}`.
- Modify: `src/worker/score/sandbox-exec.ts` — add `chain_resolved_library_not_cli` to the `ScoreErrorCode` union.
- Test: `tests/score-do.test.ts` — add pre-flight test cases.

**Approach:**

Insert pre-flight in `resolveSpec()` between input parsing and the spec return. For supported PMs, fetch the package's
registry metadata via U1's helpers. If the metadata says "no CLI entry," short-circuit with the new error code. If the
metadata fetch fails (timeout, API error), fall through to the existing path (reactive `which` still catches libraries;
no regression).

**Patterns to follow:**

- `src/worker/score/discover-binary.ts:discoverBinary()` — same fetch + timeout discipline.
- The Step 3 distributions priority + fallback shape.

**Test scenarios:**

- **Happy path (cargo CLI):** input `cargo binstall ripgrep`; pre-flight finds bin_names → `{ok: true, value: spec}`;
  flow continues to install.
- **Happy path (pip CLI):** input `pip install black`; pre-flight finds console_scripts → continues.
- **Bounce (cargo library):** input `cargo binstall serde`; pre-flight finds empty bin_names → returns `{ok: false,
  error: 'chain_resolved_library_not_cli'}`.
- **Bounce (npm library):** input `npm install -g lodash`; pre-flight finds no bin field → returns library bounce.
- **Bounce (pip library):** input `pip install requests`; pre-flight finds no console_scripts → returns library bounce.
- **API failure passthrough:** pypi/crates/npm API returns 5xx or times out; pre-flight returns `{isCli: false, reason:
  'api_unreachable'}`; resolveSpec falls through to the existing reactive path (no regression — reactive `which` still
  catches libraries).
- **go input passes through:** input `go install github.com/foo/bar@latest`; pre-flight has no entry for pm=go;
  resolveSpec returns the spec unchanged → reactive path.
- **direct input passes through:** input is a github URL; pre-flight has no entry for pm=direct; flow unchanged.

**Verification:** Library inputs bounce in ~200-500 ms with the new error code. CLI inputs add ~200-500 ms to total
wall-clock but otherwise behave identically. go + direct unchanged.

---

### U3. Handler error-code mapping for `chain_resolved_library_not_cli`

**Goal:** Map the new DO error code to a user-facing ScoreError variant; integrate into the existing handler.ts
mapDoError flow.

**Requirements:** R11 (response triad). User-visible response envelope must carry `spec_version`, `anc_version` (well,
N/A for bounces — only success), `checker_url` AND the new error code with PM-specific details.

**Dependencies:** U2.

**Files:**

- Modify: `src/worker/score/response-shape.ts` — add `{code: 'chain_resolved_library_not_cli'; details: string;
  cta_text: string}` to the ScoreError union. Update `statusForError()` to return 502.
- Modify: `src/worker/score/handler.ts:mapDoError()` — add the new code to the switch.
- Modify: `tests/score-handler.test.ts` — add a DO mock case that returns the new error and assert the response shape.

**Approach:**

Straight type-union extension. Once the new variant is added to ScoreError, mapDoError's exhaustiveness check (via
`assertNever()`) forces handling. The user-facing envelope shape is identical to other bounce classes.

**Test scenarios:**

- DO returns `{error: 'chain_resolved_library_not_cli', details: 'pm=pip pkg=requests reason=no_console_scripts'}` →
  handler returns 502 with envelope `{error: {code: 'chain_resolved_library_not_cli', details: '...', cta_text: '...'},
  spec_version, checker_url}`.
- ScoreError union compile check: removing the new variant should be a TypeScript error (assertNever exhaustiveness).

**Verification:** Handler tests pass. Response shape carries the new error code; status is 502.

---

### U4. Telemetry shim (precondition for the build decision)

**Goal:** Before any of U1-U3 ships, add a lightweight telemetry counter that measures the actual library-input rate in
production. The build trigger is "library inputs exceed 10% of install-command traffic over 7 days." Without this
measurement, the recommendation in Key Technical Decisions stays at "defer" — we'd be building speculation, not response
to demand.

**Requirements:** This unit gates the rest of the plan. If telemetry shows libraries are <10%, the build is not
justified.

**Dependencies:** None — this is the FIRST unit to ship.

**Files:**

- Modify: `src/worker/score/handler.ts` — add a Workers Analytics Engine write per POST with the eventual outcome
  classification. Fields: `pm` (the install-command pm), `outcome` ('cli' / 'library' / 'install_failed' / 'no_resolve'
  / etc.), `duration_ms`.
- Modify: `wrangler.jsonc` — add `analytics_engine_datasets[]` binding if not already present.
- Test: `tests/score-handler.test.ts` — add a stub for the AE write; assert the right fields are emitted on each outcome
  branch.

**Approach:**

The handler already knows the outcome after the DO call. Add a single AE write per request that records `pm`, `outcome`,
and `duration_ms`. Stays alive after pre-flight ships too: pre-flight's `chain_resolved_library_not_cli` becomes another
`outcome` value.

**Patterns to follow:**

- Plan U6's "Operational visibility" section already calls out Workers Analytics Engine writes as a v3.1 follow-up. This
  unit lands that infrastructure with the library-rate measurement as its first use.

**Test scenarios:**

- DO returns success → AE write with `{pm: 'npm', outcome: 'cli', duration_ms: N}`.
- DO returns `chain_resolved_no_binary_produced` → AE write with `{pm: 'pip', outcome: 'library', duration_ms: N}`.
- DO returns other error codes → corresponding outcome value.
- AE binding missing → handler logs and continues (no user-visible failure).

**Verification:** After 7 days on staging or prod, the library-input rate can be queried from the AE dataset. If above
10%, proceed to U1-U3. If below, document the measurement and close the plan with `status: completed` and a note in the
Operational Notes section.

---

## System-Wide Impact

- **Interaction graph.** Pre-flight adds three new upstream API dependencies (pypi.org, crates.io, registry.npmjs.org)
  to the Worker-side critical path. Each install-command POST that uses one of pip/cargo/npm/bun now makes one
  synchronous outbound HTTP call before container exec.
- **Error propagation.** New `chain_resolved_library_not_cli` flows through the existing ScoreError type system; no new
  error-class shape.
- **Cache behavior.** No caching at the pre-flight layer (consistent with Step 3 distributions). Adds API-call
  amplification: 100 POSTs of the same library pkg = 100 registry-API hits. Acceptable at expected traffic; revisit if
  traffic grows.
- **API surface parity.** No new endpoints; all changes are response-shape additions.
- **Failure mode under upstream-API outage.** pypi/crates.io/npm down → pre-flight times out (deadline-bounded) → falls
  through to reactive path → existing behavior preserved (just slower).

---

## Risk Analysis & Mitigation

| Risk                                                                                 | Likelihood | Impact | Mitigation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------ | ---------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Telemetry shows library inputs are <10%; pre-flight not justified                    | High       | Low    | Triage section already recommends defer-by-default. Worst case: U4 ships, measurement runs, U1-U3 stay unbuilt. Plan transitions to `status: completed` with a Documentation Notes section recording the rate.                                                                                                                                                                                                                                                                                    |
| Upstream API contract shift breaks pre-flight (pypi `.metadata`-style)               | Med        | Med    | Pre-flight uses deadline-bounded fetches with reactive fallback (helper returns `isCli: false, reason: 'api_unreachable'` on failure; resolveSpec falls through to existing path). Drift is observable in logs and surfaces as the bounce rate moving from library-bounce to reactive-bounce. Periodic audit + monitoring.                                                                                                                                                                        |
| Pre-flight latency tax outweighs library-bounce savings                              | High       | Low    | Triage section explicitly calls out this risk. Net wall-clock improvement is ~14 s/hr at assumed traffic; per-request latency penalty is ~200-500 ms × 27% of POSTs. Not a UX disaster but real. The hybrid Alt 3 (cache library results) could absorb this if it becomes a problem; defer to a v-next iteration if it materializes.                                                                                                                                                              |
| Library-detection false negatives (package has bin but pre-flight misses it)         | Low        | Med    | Each helper checks a specific upstream field; false negatives surface as bounces that COULD have scored. Reactive fallback (handler still attempts install if pre-flight returns inconclusive) shouldn't fire for is-cli: false (that's a hard bounce). False negatives in the pre-flight check directly bounce users. Mitigation: helper logic is deliberately conservative — return isCli: false only when the field is provably empty/missing; return isCli: true if ambiguous (fall through). |
| Library-detection false positives (package has no bin but pre-flight thinks it does) | Low        | Low    | Same fields the existing Step 3 uses for github-URL inputs. False positives mean the install runs anyway and the `which` gate catches the actual miss. No worse than current behavior.                                                                                                                                                                                                                                                                                                            |
| Maintenance burden grows with new PMs added to the install table                     | Med        | Low    | Each new PM addition needs either a pre-flight helper OR an explicit pass-through (no pre-flight, stays reactive). Acceptable cost; new-PM addition is rare (estimated 1-2 per year).                                                                                                                                                                                                                                                                                                             |

---

## Documentation / Operational Notes

- **If telemetry justifies the build:** when U4's measurement shows library inputs exceed 10% of install-command
  traffic, file a U6.x follow-up PR cutting from `dev` that lands U1 → U2 → U3 (in order). Update this plan's `status:
  active` → `status: completed` with a final note recording the trigger event.
- **If telemetry shows the build is NOT justified:** after 7 days of measurement, update the plan with the observed
  library-input rate, mark `status: completed`, and close. The recommendation stands: reactive is good enough.
- **Compound-engineering follow-up:** record the triage outcome (build / don't build) as a solutions doc under
  `docs/solutions/architecture-patterns/` so future PMs added to U6's install table can reference the triage rather than
  re-deriving.

---

## Sources & References

- U6 plan: `docs/plans/2026-04-28-002-feat-live-scoring-cf-sandbox-plan.md` (current parent plan; U6's `which` gate
  defines the reactive bounce class this plan considers replacing).
- U6 PM-coverage handoff (this session, 2026-05-18): chat history captures the empirical bounce-time measurements used
  in the triage table.
- `src/worker/score/discover-binary.ts:step3_distributions()` — the existing per-PM CLI-vs-library check pattern this
  plan extends.
- [PyPI JSON API docs](https://warehouse.pypa.io/api-reference/json.html).
- [crates.io API docs](https://crates.io/data-access).
- [npm registry API docs](https://github.com/npm/registry/blob/master/docs/REGISTRY-API.md).
