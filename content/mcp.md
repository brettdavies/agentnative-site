# MCP wire contract

anc.dev publishes a Model Context Protocol server at `https://anc.dev/mcp`. The catalog is intentionally public: every
scored CLI, every principle of the spec, and the vendored spec text itself are queryable without authentication. This
page is the canonical reference for the wire contract: what the endpoint accepts, what it returns, and how errors
propagate. It is authored as the `.md` source the MCP `documentation` pointer resolves to; the HTML rendering at
`/mcp-docs/` is the same content with chrome for humans inspecting the contract.

## Endpoint

- URL: `POST https://anc.dev/mcp`
- Transport: streamable HTTP per MCP specification revision `2025-06-18`
- Authentication: none. The catalog is public.
- Discovery siblings: `https://anc.dev/.well-known/mcp` (HTTP-level pointer), `https://anc.dev/.well-known/ai.txt`,
  `https://anc.dev/.well-known/security.txt`, and `https://anc.dev/llms.txt` (Programmatic access section)

Other methods on `/mcp` return `405 Method Not Allowed` with `Allow: POST`.

## Accept-header negotiation

The Worker negotiates between `application/json` and `text/event-stream`. JSON wins ties; q-values resolve unequal
preferences. Only when the client accepts neither MIME type does the Worker return `406 Not Acceptable`.

| Client `Accept` header                            | Response                                                            |
| ------------------------------------------------- | ------------------------------------------------------------------- |
| absent                                            | `application/json`                                                  |
| `*/*`                                             | `application/json`                                                  |
| `application/json`                                | `application/json`                                                  |
| `text/event-stream`                               | `text/event-stream` (SSE framing)                                   |
| `application/json, text/event-stream`             | `application/json` (JSON wins ties)                                 |
| `application/json;q=0.5, text/event-stream;q=0.9` | `text/event-stream` (higher q-value wins)                           |
| any value with neither type acceptable            | `406 Not Acceptable` with `Content-Type: text/plain; charset=utf-8` |

## Tools

Nine tools cover four surfaces. Full input schemas live on `tools/list`; the descriptions below are summaries.

Registry surface:

- `list_tools`: every scored CLI as a summary record (slug, name, binary, install, version, score_pct, scorecard_url,
  audit_profile)
- `get_tool`: full registry record for a single CLI by `slug`
- `search_tools`: filter by `score_min`, `score_max`, `audit_profile`, and/or `principle_min_score`; AND semantics

Principles surface:

- `list_principles`: every principle as a summary record (n, slug, title, level_summary)
- `get_principle`: full principle including markdown body and MUST/SHOULD/MAY requirements with `audit_id`s

Spec surface:

- `list_spec_sections`: the vendored spec's table of contents at the current `spec_version`
- `get_spec_section`: full section body for a single section by `slug`, with `spec_version` carried

Scorecard surface:

- `get_scorecard`: cheap read-only lookup over the registry index and R2 live-score cache. Returns the scorecard inline
  on hit, or a typed `next_tool: score_cli` redirect on miss. Always `isError: false` for cache-state outcomes.
- `score_cli`: cache-miss-only fresh audit. On registry or R2-cache hit, returns `audited: false` with a typed
  `next_tool: get_scorecard` redirect. On miss, runs a container audit, writes the cache, and returns `audited: true`.

Both scorecard tools compose the same `/api/score` orchestration core, so cache semantics never drift between MCP and
the human form on `/`. The two tools are symmetric: `get_scorecard` succeeds with `found: true` exactly when `score_cli`
returns `audited: false`; `get_scorecard` succeeds with `found: false` exactly when `score_cli` succeeds with `audited:
true`. The tool selection is the cost signal: `get_scorecard` is always cheap, `score_cli` is sometimes a container run.

## Resources

`resources/list` returns one concrete resource. Per-item records live behind URI templates surfaced via
`resources/templates/list`. Five total.

- `anc://registry`: full denormalized catalog (concrete)
- `anc://tool/{slug}`: single CLI record (template)
- `anc://principle/{n}`: single principle body and requirements (template)
- `anc://spec/{section}`: single spec section body (template)
- `anc://scorecard/{binary}`: cached scorecard for a CLI by binary name (template)

Clients that want the inventory call `tools/call list_tools` / `list_principles` / `list_spec_sections` or
`resources/read anc://registry`.

## Errors

Two layers carry errors:

- Tool-level failures: `tools/call` returns a `CallToolResult` with `isError: true` and a textual message in the
  `content` array. Used for genuine tool-execution failures: validator rejection on `score_cli`, infrastructure error,
  rate-limit breach on `MCP_AUDIT_LIMITER`. The JSON-RPC envelope itself is successful. **Cache state is data, not
  failure.** A `get_scorecard` miss returns `isError: false` with a typed `found: false, next_tool` body; a `score_cli`
  hit returns `isError: false` with a typed `audited: false, next_tool` body.
- Transport-level failures: JSON-RPC error envelopes returned with HTTP 200. Used for malformed requests and the global
  rate limit. Codes follow JSON-RPC 2.0:
- `-32700` parse error (malformed JSON body)
- `-32099` rate limit exceeded (implementation-defined server-error range; used by both `MCP_LIMITER` at the dispatch
    layer and `MCP_AUDIT_LIMITER` inside `score_cli`)

The `406 Not Acceptable` response is the exception: it is a transport rejection that happens before any JSON-RPC
parsing, so the body is plain text without a `jsonrpc`/`id`/`error` envelope.

## Rate limits

Two bindings, two cost profiles.

- `MCP_LIMITER`: 60 requests per 60 seconds per IP. Gates every `POST /mcp` request. Keyed on `cf-connecting-ip`;
  missing header falls back to a shared `anon` bucket. Breach returns the `-32099` envelope at HTTP 200.
- `MCP_AUDIT_LIMITER`: 5 fresh audits per 60 minutes per IP. Gates only `score_cli` cache-miss audits. Keyed on
  `cf-connecting-ip`; **no anon fallback**: a request with no `cf-connecting-ip` header is rejected with `-32099` rather
  than consuming a shared bucket, because container-run cost is non-trivial and a shared anon bucket would be a DoS
  vector.

The read tier accepts a shared anon bucket because per-request cost is trivial and a small anon flood is recoverable.
The audit tier rejects on missing IP because container-run cost is non-trivial. Both ceilings are pre-data placeholders
sized from parity with the sister `streamsgrp.com/mcp` deployment and will be tuned after 14 days of visitor-log data.

## Cost control: `score_cli` never bypasses the cache

The operator pays for every container run that `score_cli` triggers. There is no `force_refresh` flag and no path
through the MCP surface that bypasses the cache. The `score_cli` / `get_scorecard` separation is honest about latency
only when cache is universally respected. A `get_scorecard` hit becomes the agent's signal to use the cheap tool; a
`score_cli` miss is the signal that an audit is required, which `MCP_AUDIT_LIMITER` then meters.

## Kill switches

Two env vars give the operator a surgical zero-deploy off-switch. Both default `false` in production, `true` in staging;
flipping is `wrangler secret put MCP_ENABLED false` (or the corresponding `MCP_LIVE_SCORING_ENABLED`).

- `MCP_ENABLED`: gates the entire `/mcp` branch. When falsy, the endpoint returns `503 Service Unavailable` with
  `Retry-After: 3600` and a one-line plain-text body. No JSON-RPC envelope; the surface is off, not in-error.
- `MCP_LIVE_SCORING_ENABLED`: gates only the `score_cli` tool. When falsy, `score_cli` returns `isError: false` with
  `audited: false, message: "live scoring is currently disabled by the operator; cached scorecards remain available via
  get_scorecard"`. The read tier (`get_scorecard` and the seven catalog tools) stays alive.

A surface-level emergency (security issue, schema bug, abuse pattern at the dispatch layer) takes the whole endpoint
offline via `MCP_ENABLED`. A cost-level emergency (audit budget overrun) disables only the expensive tool via
`MCP_LIVE_SCORING_ENABLED` and keeps the read tier serving cached scorecards.

## Origin posture: server-to-agent, no CORS

`POST /mcp` returns no `Access-Control-Allow-Origin` header. The endpoint is server-to-agent JSON-RPC, not
browser-to-server. MCP clients are agent runtimes (Claude Code, Codex, Cursor, custom CLIs) that do not issue CORS
preflights. Browser-origin POSTs fail the browser's same-origin check and are blocked client-side: this is the
deliberate posture, because a browser-reachable `/mcp` would let any malicious web page trigger `score_cli` runs charged
against the visitor's `cf-connecting-ip` rather than the attacker's. A future use case needing browser access gets its
own KTD revision, an explicit allow-list, and a rate-limit policy designed for browser traffic.

Every `POST /mcp` request emits one structured `[mcp-call]` log line carrying the `Origin` header (or `null`), the
`User-Agent`, the Cloudflare-injected client IP, the Cloudflare-injected country, the chosen response format, and a
`gate_result` of `passed` or `rate_limited`. The log fires AFTER the rate-limit gate decision so Workers Logs volume
stays bounded under attack while still recording the denial.

## Spec revision pin

- `/.well-known/mcp` advertises `"version": "2025-06-18"`
- `initialize` round-trips the same value via the bundled MCP SDK
- The two values are bumped in lockstep when the SDK is upgraded; tests assert each literal value so any drift breaks
  the build

## Discovery siblings

Four discoverability surfaces point at this page or at each other.

- `https://anc.dev/.well-known/mcp`: HTTP-level JSON pointer carrying `mcp_endpoint`, `version`, `description`,
  `transport`, and `documentation` (this page's `.md` URL).
- `https://anc.dev/.well-known/ai.txt`: declares AI-training and agent-access posture, plus `Programmatic-API:
  https://anc.dev/mcp`.
- `https://anc.dev/.well-known/security.txt`: RFC 9116 vulnerability reporting contact.
- `https://anc.dev/llms.txt`: the llmstxt.org index lists `/mcp`, `/.well-known/mcp`, and this page under Programmatic
  access.
- The `InitializeResult.instructions` field of the MCP handshake carries a session-time summary plus a pointer at
  `https://anc.dev/mcp-docs.md`.
