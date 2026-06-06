# MCP server operator runbook

Operator playbook for `POST https://anc.dev/mcp`. Companion to the client-facing skill at
[`content/mcp-skill.md`](../../content/mcp-skill.md) (published at `https://anc.dev/mcp-skill.md`). The client skill
covers the wire contract clients see; this runbook covers the surfaces operators see: kill switches, observability,
posture rationale, spec-revision drift handling, and rate-limit policy. Unpublished by design: the published surface is
the client skill plus the `.well-known/mcp` pointer, not this runbook.

## Kill switches

Two `wrangler secret` flags give zero-deploy emergency control. Both default `false` in production, `true` in staging;
flip with `wrangler secret put`.

| Secret                     | Scope                     | Falsy behavior                                                                                                                                                                                          |
| -------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MCP_ENABLED`              | the entire `/mcp` branch  | `503 Service Unavailable` with `Retry-After: 3600` and a one-line plain-text body. No JSON-RPC envelope, because the surface is off, not in-error. Discoverability siblings stay live.                  |
| `MCP_LIVE_SCORING_ENABLED` | only the `score_cli` tool | `score_cli` returns `isError: false` with `audited: false, message: "live scoring is currently disabled by the operator; cached scorecards remain available via get_scorecard"`. Read tier stays alive. |

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

## Structured logging

Every `POST /mcp` request emits one structured `[mcp-call]` log line. Schema:

| Field             | Source                                          | Notes                                                    |
| ----------------- | ----------------------------------------------- | -------------------------------------------------------- |
| `origin`          | request `Origin` header (or `null`)             | Useful for spotting unexpected browser-origin probes.    |
| `user_agent`      | request `User-Agent` header                     | Identifies which agent runtimes are calling.             |
| `client_ip`       | CF-injected `cf-connecting-ip`                  | Rate-limit key for both `MCP_LIMITER` and audit limiter. |
| `country`         | CF-injected geo header                          | Useful when triaging an abuse pattern.                   |
| `response_format` | chosen `application/json` / `text/event-stream` | Negotiated from `Accept`.                                |
| `gate_result`     | `passed` or `rate_limited`                      | The log fires AFTER the rate-limit gate decision.        |

**Important:** the log fires after the gate so Workers Logs volume stays bounded under attack, but still records the
denial. A flood that trips `MCP_LIMITER` produces one log line per request, not zero.

To query:

```bash
# Tail live
wrangler tail --env production --search '[mcp-call]'

# Pull a window via Workers Logs API or the dashboard search
```

When triaging abuse: filter by `client_ip` + `gate_result: rate_limited` to confirm a single source is the cause. When
triaging unexpected traffic shape: filter by `origin` (browser probes) or `user_agent` (a new client).

## Spec revision pin

Spec revision `2025-06-18` is pinned in three places that MUST stay in lockstep:

1. `src/worker/mcp/instructions.ts`: the `SPEC_REVISION` constant baked into the handshake `instructions` field.
2. `src/build/11a-discovery-emit.mjs`: the `MCP_SPEC_VERSION` constant baked into `/.well-known/mcp`.
3. The MCP SDK version in `package.json`: the SDK enforces the protocol-level pin on `initialize`.

Tests assert each literal value so any drift breaks the build (`tests/worker-mcp.test.ts`,
`tests/build-discovery-emit.test.ts`). When upgrading the SDK:

1. Bump the SDK in `package.json` and `bun install`.
2. Read the SDK changelog for the new pinned revision.
3. Update both constants above to match.
4. Update the literal expectations in `tests/worker-mcp.test.ts` and `tests/build-discovery-emit.test.ts`.
5. Update the literal `2025-06-18` references in `content/mcp-skill.md` and this file.
6. Run `bun test` and the staging-mcp e2e suite. If the SDK introduced wire-shape changes, expect failures in
   `tests/e2e/discoverability.e2e.ts` and triage from there.

Bumping any one of these alone is a bug, not a feature.

## Rate-limit policy rationale

Two limiters, asymmetric posture. The asymmetry is intentional and documented here so a future "let's unify them"
refactor doesn't drop the security argument.

### Read tier (`MCP_LIMITER`): 60 req / 60s per IP, anon fallback allowed

Per-request cost is trivial (in-isolate catalog read, no container, no R2 write). A small anon flood is recoverable
within the 60-second window. A shared anon bucket is acceptable because the worst case is a brief denial-of-service for
unkeyed traffic, since no resource cost amplifies.

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
tuned after 14 days of visitor-log data lands. Before changing either, pull the `[mcp-call]` log volume by IP and the
audit-window distribution from KV; tune to keep p95 traffic under the ceiling rather than guessing.

## Discoverability surfaces operators own

Four surfaces advertise the MCP endpoint. Operators are responsible for keeping them coherent.

- `/.well-known/mcp`: JSON pointer. `documentation` field must equal the published client-skill URL
  (`https://anc.dev/mcp-skill.md`). Tests assert this literal.
- `/.well-known/ai.txt`: `Programmatic-API: https://anc.dev/mcp` plus the canonical contact
  (`97-boss-beetle@icloud.com`).
- `/.well-known/security.txt`: RFC 9116 contact; `Expires` must stay at least 300 days in the future (tests assert).
- `/llms.txt`: Programmatic access section listing `/mcp`, `/.well-known/mcp`, and the client-skill URL.
- `InitializeResult.instructions`: session-time summary plus a pointer back to the client-skill URL.

When the client-skill URL changes (a rename, a domain move), all six surfaces have to update together. The drift gate is
the test suite; trust it, but pull the e2e suite locally before deploying to confirm.

## Live-scoring kill switch interplay

`MCP_LIVE_SCORING_ENABLED` shares a name and semantic with the live-scoring kill switch used by the human form on `/`.
They are separate secrets (one gates the MCP tool, the other gates `/api/score`), but they target the same underlying
cost (container audit pool). When both are flipped off, no live audits run from any surface; cached scorecards remain
available everywhere.

When flipping for cost reasons, flip both unless you have a specific reason to keep one surface alive. When flipping for
an MCP-specific issue (a bug in the `score_cli` tool, an abuse pattern via MCP), flip only the MCP one.
