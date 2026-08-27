# MCP server operator runbook

Operator playbook for `POST https://anc.dev/mcp`. Companion to the client-facing skill at
[`content/mcp-skill.md`](../../content/mcp-skill.md) (published at `https://anc.dev/mcp-skill.md`). The client skill
covers the wire contract clients see; this runbook covers the surfaces operators see: kill switches, observability,
posture rationale, spec-revision drift handling, and rate-limit policy. Unpublished by design: the published surface is
the client skill plus the server card at `/.well-known/mcp/server-card.json`, not this runbook.

## Kill switches

Two `wrangler secret` flags give zero-deploy emergency control (`MCP_ENABLED`, `MCP_LIVE_SCORING_ENABLED`). Both default
`false` in production, `true` in staging; flip with `wrangler secret put`. Staging also binds `MCP_LEGACY_ENABLED` as a
plain `vars` entry (not a secret) — flip that one with `wrangler deploy --var`, not `secret put` (see Legacy lane
disable below).

| Flag                       | Binding shape (staging) | Scope                     | Falsy behavior                                                                                                                                                                                          |
| -------------------------- | ----------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MCP_ENABLED`              | secret                  | the entire `/mcp` branch  | `503 Service Unavailable` with `Retry-After: 3600` and a one-line plain-text body. No JSON-RPC envelope, because the surface is off, not in-error. Discoverability siblings stay live.                  |
| `MCP_LIVE_SCORING_ENABLED` | secret                  | only the `score_cli` tool | `score_cli` returns `isError: false` with `audited: false, message: "live scoring is currently disabled by the operator; cached scorecards remain available via get_scorecard"`. Read tier stays alive. |
| `MCP_LEGACY_ENABLED`       | `vars` (`"true"`)       | legacy `initialize` lane  | When `'false'`, shell logs `legacy_rejected` with `error_code: -32022` and returns JSON-RPC `-32022` (`data.supported: ["2026-07-28"]`) before SDK dispatch. Modern lane unaffected.                    |

Decision flow:

- **Security issue, schema bug, or abuse pattern at the dispatch layer** → flip `MCP_ENABLED` to take the whole endpoint
  offline. Use this when continuing to serve any tool would be a liability.
- **Cost-level emergency (audit budget overrun, container pool saturation, R2 throttling on the cache write path)** →
  flip `MCP_LIVE_SCORING_ENABLED` only. The seven catalog tools and `get_scorecard` keep serving cached scorecards;
  agents that were about to call `score_cli` get a typed "disabled" response and route themselves back to
  `get_scorecard`.

```bash
# Disable only the cost-bearing audit path
wrangler secret put MCP_LIVE_SCORING_ENABLED --env production
# Enter: false

# Or take the whole surface offline
wrangler secret put MCP_ENABLED --env production
# Enter: false
```

Re-enable with the same command and the value `true`.

## Origin posture: server-to-agent, no CORS

`POST /mcp` returns no `Access-Control-Allow-Origin` header. This is deliberate, not an oversight.

The endpoint is server-to-agent JSON-RPC, not browser-to-server. MCP clients are agent runtimes (Claude Code, Codex,
Cursor, custom CLIs) that do not issue CORS preflights. Browser-origin POSTs fail the browser's same-origin check and
are blocked client-side.

The threat that drives this posture: a browser-reachable `/mcp` would let any malicious web page trigger `score_cli`
runs charged against the visitor's `cf-connecting-ip` rather than the attacker's. The visitor would burn their own audit
quota, then face rate-limited cache misses on their legitimate calls.

If a future use case needs browser access, it gets its own KTD revision, an explicit allow-list, and a rate-limit policy
designed for browser traffic. Do not add a wildcard CORS header to this endpoint without that review.

## Structured logging (`mcp.request`)

Every `POST /mcp` attempt emits **exactly one** PII-free JSON log line with `"event":"mcp.request"`. Replaces the former
`[mcp-call]` shape.

| Field              | Notes                                                                              |
| ------------------ | ---------------------------------------------------------------------------------- |
| `era`              | `legacy` or `modern` (`isLegacyRequest`)                                           |
| `method`           | `Mcp-Method` header when present; else JSON-RPC method when known                  |
| `name`             | `Mcp-Name` when present (nullable)                                                 |
| `client_name`      | Truncated from initialize / `_meta` clientInfo when available                      |
| `protocol_version` | From header or `_meta` when available                                              |
| `host`             | Request host                                                                       |
| `response_format`  | `sse` when the served `content-type` is `text/event-stream`, else `json`           |
| `outcome`          | `ok`, `error`, `legacy_rejected`, `rate_limited`, `disabled`, `accept_rejected`, … |
| `error_code`       | Numeric JSON-RPC transport code only (nullable); no tool payloads                  |
| `ms_bucket`        | `<50`, `50-200`, `200-1000`, `>1000`                                               |

No IP, slug, query text, or tool results appear in the log line. Use Cloudflare rate-limit analytics for IP triage.

### Reading `response_format`

The field records what went on the wire, not what the client asked for, so `response_format:sse` counts real streams and
nothing else.

An SSE-preferring `Accept` does not imply an SSE response. The modern lane runs `responseMode: 'auto'`, which answers a
single JSON body unless a tool emits a related message before its result. No `anc` tool reports progress mid-call, so a
modern-era request answers `application/json` whatever its `Accept` said. The legacy lane does stream: the transport
defaults to SSE, and dispatch coerces that back to JSON only for a JSON-preferring client. A modern-era
`subscriptions/listen` also streams.

Exits that never reach the MCP dispatch log `json`: the `MCP_ENABLED` kill switch (503 `text/plain`) and the Accept
rejection (406 `text/plain`) carry no MCP body, and the field answers "was this a stream". The `legacy_rejected` and
`rate_limited` exits log `json` too; both serve a JSON-RPC error envelope as `application/json`.

```bash
# --search can look empty depending on envelope shape; prefer local filter:
bun x wrangler tail --env staging --format json | rg 'event.:.mcp.request'
```

When triaging era mix before legacy sunset: filter `era:legacy` vs `era:modern` and group by `client_name`. Legacy share
alone is insufficient — review top-N legacy `client_name` values over 30 days before flipping
`MCP_LEGACY_ENABLED=false`.

## Spec revision pin

Declared spec revision `2026-07-28` is pinned in lockstep across:

1. `src/worker/mcp/instructions.ts` — `SPEC_REVISION` in handshake `instructions`.
2. `src/build/11a-discovery-emit.mjs` — server card `protocolVersion`.
3. `content/mcp-skill.md` — wire-level reference block.
4. `AGENTS.md` § MCP server — agent onboarding summary.

Legacy clients may still send `initialize` with client `protocolVersion=2025-06-18`; the SDK dual-stack answers per
pinned server revision. Tests assert literals in `tests/worker-mcp.test.ts`, `tests/build-discovery-emit.test.ts`, and
`tests/e2e/discoverability.e2e.ts`.

When upgrading `@modelcontextprotocol/server` / `agents`:

1. Bump pins in `package.json` and `bun install`.
2. Update all four surfaces above to the new declared revision.
3. Update test literals and `scripts/release/mcp-smoke.sh` checks 1–2.
4. Run `bun run build && bun test` and staging `scripts/release/mcp-smoke.sh <staging-url>` (expect 6/6 scripted
   checks).

## Rate-limit policy rationale

Two limiters, asymmetric posture. The asymmetry is intentional and documented here so a future "let's unify them"
refactor doesn't drop the security argument.

### Read tier (`MCP_LIMITER`): 60 req / 60s per IP, anon fallback allowed

Read tier keys are **era-aware**: `legacy:{ip}` for legacy requests; `modern:{mcp-name}:{ip}` when `Mcp-Name` names a
registered tool or resource template (from `registered_tool_names` / `registered_resource_templates` in the catalog
emit); otherwise `modern:{ip}`. Spoofed `Mcp-Name` values fall back to `modern:{ip}`.

### Audit tier (`MCP_AUDIT_LIMITER`): 5 audits / 60min per IP, NO anon fallback

Per-request cost is non-trivial (container spawn, R2 write, DO dispatch). A shared anon bucket would be a DoS vector: an
attacker without `cf-connecting-ip` could burn the bucket and lock out every legitimate anonymous caller from auditing.
The mitigation is to reject on missing IP rather than share. The cost difference between read and audit makes the rule
asymmetric.

The hourly ceiling is enforced in two layers because the CF Rate Limiting binding only accepts `period: 10 | 60`
(validated at wrangler parse time):

- **CF binding** enforces 5-per-60-seconds burst floor.
- **KV-backed per-hour window** in `SCORE_KV` enforces the hourly ceiling.

Key shape: `mcp_audit:<ip>:<hour_bucket>` with a 7200-second TTL (window plus one-hour grace). There's a small TOCTOU
window between read and write but it's bounded by the burst gate; worst-case overshoot is a handful of audits per hour,
not orders of magnitude.

### Tuning

Both ceilings are pre-data placeholders sized from parity with the sister `streamsgrp.com/mcp` deployment. They will be
tuned after 14 days of `mcp.request` log volume by IP and the audit-window distribution from KV; tune to keep p95
traffic under the ceiling rather than guessing.

## Staging proof (dual-stack migration)

Run after the dual-stack Worker is on staging (normally a `dev` merge deploy; a manual `bun run build && bun x wrangler
deploy --env staging` from `feat/mcp-2026-dual-protocol` is acceptable for this proof). Requires CF Access service-token
headers (same pair as `scripts/release/preflight.sh` / `scripts/release/postflight.sh`).

### Scripted checks (6/6)

```bash
export CF_ACCESS_CLIENT_ID=…
export CF_ACCESS_CLIENT_SECRET=…
scripts/release/mcp-smoke.sh https://agentnative-site-staging.brettdavies.workers.dev
```

Expect **6/6** pass: server card `2026-07-28`, legacy initialize + 13 tools, modern list cache hints, modern
get_scorecard hit/miss.

**Check 6 miss input (recorded 2026-08-26):** unknown registry slugs (`nope-not-a-tool`) are validator rejection
(`isError: true`, `unrecognized_input`), not cache-miss. The smoke miss probe uses a well-formed `github_url` absent
from registry + R2 (`https://github.com/example/anc-smoke-no-scorecard`) and expects inner `found: false` + `next_tool:
score_cli`. Curated hits return `source=registry` with `entry` (not always an inline `scorecard` object).

**Legacy Accept / JSON (recorded 2026-08-26):** the agents legacy transport requires dual Accept and defaults to SSE.
Dispatch keeps the dual-Accept rewrite for the SDK, then coerces SSE → `application/json` when `detectMcpFormat`
resolved to JSON (`src/worker/mcp/coerce-json-response.ts`). Modern lane uses `responseMode: 'json'` and needs no
coerce. `createMcpHandler({ corsOptions: false })` plus `stripCorsHeaders` keep POST `/mcp` free of `Access-Control-*`
(KTD-10).

### Check 8 — telemetry (manual)

In one terminal:

```bash
# Prefer no --search first: --search can match the outer wrangler envelope oddly and look empty
# while logs are still flowing. Filter locally once lines appear.
bun x wrangler tail --env staging --format json > /tmp/mcp-tail.json
```

In another, run check 5 from the smoke script (modern `tools/list` with `clientInfo.name: anc-mcp-smoke` in `_meta`).
Confirm exactly **one** JSON log message per POST with `era=modern`, `method=tools/list`, `client_name=anc-mcp-smoke`,
`protocol_version=2026-07-28`, `host`, `outcome=ok`, `ms_bucket` — and **no** IP, slug, or tool-result fields in the
`mcp.request` payload (Cloudflare's outer tail envelope may still show request headers; that is not our log line).

**Observed 2026-08-26 (staging version `a34f7312…`, manual feature-branch deploy):**

```json
{"event":"mcp.request","era":"modern","method":"tools/list","name":null,"client_name":"anc-mcp-smoke","protocol_version":"2026-07-28","host":"agentnative-site-staging.brettdavies.workers.dev","response_format":"json","outcome":"ok","error_code":null,"ms_bucket":"<50"}
```

Scripted smoke: **6/6** (+ symmetry + live-cache figlet extension) green after the SSE→JSON coerce and check-6 miss
probe fix.

### Legacy lane disable (staging-only manual)

Staging declares `MCP_LEGACY_ENABLED` in `wrangler.jsonc` `env.staging.vars`. Do **not** `wrangler secret put` that name
while it remains a vars binding — Cloudflare API **10053** (binding name already in use). Temporary flip:

```bash
bun x wrangler deploy --env staging --var MCP_LEGACY_ENABLED:false
```

1. After that deploy, POST legacy `initialize` → expect HTTP 200 with JSON-RPC `{ "error": { "code": -32022, "message":
   "legacy MCP requests are disabled; use MCP 2026-07-28", "data": { "supported": ["2026-07-28"] } } }`, the request
   `id` echoed, and shell log `"outcome":"legacy_rejected"` with `"error_code":-32022`.
2. Re-run modern checks 5–6 → expect pass.
3. Restore dual-stack (required for normal soak — preflight/postflight legacy recipes assume it):

```bash
bun x wrangler deploy --env staging
```

Plain deploy reloads `"true"` from `wrangler.jsonc` vars.

**Observed 2026-08-26** (staging drill after U6, on the build whose reject envelope was `-32099`): reject envelope and
`legacy_rejected` telemetry matched that build's expectations; modern lane stayed green; restore deploy returned legacy
`initialize` to `server=anc`. The `-32022` envelope above is pinned by the dispatch suite; the next staging drill
re-attests it live.

### Bundle size (U1 gate)

Recorded at implementation time (`wrangler deploy --dry-run --env staging`):

| Ref                    | Total upload | gzip       |
| ---------------------- | ------------ | ---------- |
| `origin/dev` (v1 SDK)  | 3792.53 KiB  | 745.69 KiB |
| dual-stack branch (v2) | 2164.99 KiB  | 411.56 KiB |

Manual staging deploy 2026-08-26 (with coerce): **2166.43 KiB / gzip 411.97 KiB**. Material reduction; no acceptance
waiver required.

## Legacy sunset advisory

Flip `MCP_LEGACY_ENABLED=false` in production only when **both** hold:

1. Legacy share **< 1%** of `mcp.request` volume for **30 consecutive days**.
2. Top-N legacy `client_name` breakdown reviewed — era percentage alone is insufficient; a single long-tail integrator
   may dominate the legacy bucket.

Procedure: staging-first disable → 6/6 modern smoke + legacy-off manual checklist → soak → production var flip → monitor
`era:legacy` tail volume for 48h.

## Discoverability surfaces operators own

Discovery surfaces advertise the MCP endpoint. Operators are responsible for keeping them coherent.

- `/.well-known/mcp/server-card.json`: SEP-1649 canonical server card. `protocolVersion` must match the handshake;
  `documentation` must equal the published client-skill URL (`https://anc.dev/mcp-skill.md`). Legacy aliases
  (`/.well-known/mcp`, `/mcp.json`, `/.well-known/mcp.json`) serve the same JSON body via the Worker.
- `/.well-known/api-catalog`: RFC 9727 link set; `service-desc` and `status` both point at the server card.
- `/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`, `/.well-known/jwks.json`,
  `/auth.md`: agent-readiness OAuth metadata for a public/no-auth catalog. `POST /oauth2/token` returns
  `public_catalog`.
- `/.well-known/ai.txt`: `Programmatic-API: https://anc.dev/mcp` plus the canonical contact
  (`97-boss-beetle@icloud.com`).
- `/.well-known/security.txt`: RFC 9116 contact; `Expires` must stay at least 300 days in the future (tests assert).
- `/llms.txt`: Programmatic access section listing `/mcp`, `/.well-known/mcp/server-card.json`, and the client-skill
  URL.
- `InitializeResult.instructions`: session-time summary plus a pointer back to the client-skill URL.

When the client-skill URL changes (a rename, a domain move), all surfaces have to update together. The drift gate is the
test suite; trust it, but pull the e2e suite locally before deploying to confirm.

## CORS policy

Discovery metadata is **read-only** and returns `Access-Control-Allow-Origin: *` (server card, api-catalog, OAuth
PRM/AS, JWKS). This is deliberate: automated scanners and browser-based catalog tools fetch these URLs cross-origin. No
credentials or metered operations are exposed through them.

**Server-to-agent paths omit CORS:**

- `POST /mcp` — JSON-RPC including metered `score_cli`. A browser-reachable endpoint would let any malicious page
  trigger audits charged to the visitor's IP (KTD-10).
- `POST /oauth2/token` — returns a typed `public_catalog` error only; posture is in `auth.md` and OAuth metadata.

Full prose lives in `/auth.md` under **CORS posture**. Do not add CORS to `POST /mcp` without an explicit KTD revision.

## Live-scoring kill switch interplay

`MCP_LIVE_SCORING_ENABLED` shares a name and semantic with the live-scoring kill switch used by the human form on `/`.
They are separate secrets (one gates the MCP tool, the other gates `/api/score`), but they target the same underlying
cost (container audit pool). When both are flipped off, no live audits run from any surface; cached scorecards remain
available everywhere.

When flipping for cost reasons, flip both unless you have a specific reason to keep one surface alive. When flipping for
an MCP-specific issue (a bug in the `score_cli` tool, an abuse pattern via MCP), flip only the MCP one.
