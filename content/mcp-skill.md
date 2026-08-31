# Using anc.dev's MCP server

anc.dev exposes the agent-native CLI standard catalog over a Model Context Protocol server at `https://anc.dev/mcp`.
Thirteen tools cover five surfaces (registry, principles, spec, scorecards, web audits) plus five resources for direct
lookup. The catalog is public: no authentication, no API key.

## Quick reference

The server speaks streamable HTTP per MCP spec revision `2026-07-28`. The endpoint serves **dual-stack** clients: legacy
(`initialize` → `tools/call`) and modern (SEP-2243 headers + `_meta` in params, no `initialize`).

### Legacy quick start

Drive it from any MCP-aware client (Claude Code, Codex, Cursor) or raw JSON-RPC:

```bash
# 1. initialize the session (returns InitializeResult with instructions)
curl -sS https://anc.dev/mcp -H 'Content-Type: application/json' -d '{
  "jsonrpc": "2.0", "id": 1, "method": "initialize",
  "params": {
    "protocolVersion": "2025-06-18",
    "capabilities": {},
    "clientInfo": {"name": "demo", "version": "0.1"}
  }
}'

# 2. list every tool with its full input schema
curl -sS https://anc.dev/mcp -H 'Content-Type: application/json' -d '{
  "jsonrpc": "2.0", "id": 2, "method": "tools/list"
}'

# 3. call a tool
curl -sS https://anc.dev/mcp -H 'Content-Type: application/json' -d '{
  "jsonrpc": "2.0", "id": 3, "method": "tools/call",
  "params": {"name": "get_scorecard", "arguments": {"slug": "ripgrep"}}
}'
```

### Modern quick start (no initialize)

```bash
META='"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientInfo":{"name":"demo","version":"0"},"io.modelcontextprotocol/clientCapabilities":{}}'

# tools/list — Mcp-Name header omitted
curl -sS https://anc.dev/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json' \
  -H 'MCP-Protocol-Version: 2026-07-28' -H 'Mcp-Method: tools/list' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":10,\"method\":\"tools/list\",\"params\":{$META}}"

# tools/call — Mcp-Name required
curl -sS https://anc.dev/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json' \
  -H 'MCP-Protocol-Version: 2026-07-28' -H 'Mcp-Method: tools/call' -H 'Mcp-Name: get_scorecard' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":11,\"method\":\"tools/call\",\"params\":{\"name\":\"get_scorecard\",\"arguments\":{\"slug\":\"ripgrep\"},$META}}"
```

All examples below show the `arguments` object passed to `tools/call`; the JSON-RPC envelope around it is the same shape
every time.

## Get a scorecard

The most-used surface. Two tools, three input shapes, one orchestration core. The split is honest about cost:
`get_scorecard` is always cheap (registry-index or R2-cache lookup); `score_cli` may trigger a fresh container audit.
Both accept exactly one of `slug`, `binary`, `install`, or `github_url`.

### "I want the scorecard for a CLI I know is in the registry"

Call `get_scorecard` with the slug. On a registry hit, the response carries the inline entry and the source attribution:

```json
// tools/call get_scorecard { "slug": "ripgrep" }
{
  "found": true,
  "source": "registry",
  "scorecard_url": "https://anc.dev/score/ripgrep",
  "entry": {
    "slug": "ripgrep",
    "name": "ripgrep",
    "binary": "rg",
    "install": "brew install ripgrep",
    "score_pct": 87,
    "...": "..."
  },
  "spec_version": "2026.05"
}
```

Use `source` as your cost signal: `registry` means curated and committed; `live-cache` means a prior `score_cli` audit
cached the result.

### "Is this binary in the live-score cache?"

Same tool, install command as input. A hit returns the cached scorecard with `source: "live-cache"`; a miss returns a
typed redirect. Not an error.

```json
// tools/call get_scorecard { "install": "npm install -g cowsay" }
// HIT
{
  "found": true,
  "source": "live-cache",
  "scorecard_url": "https://anc.dev/score/live/cowsay",
  "scorecard": { "...": "..." },
  "anc_version": "0.7.2",
  "spec_version": "2026.05"
}

// MISS
{
  "found": false,
  "next_tool": "score_cli",
  "message": "no cached scorecard for this input. Call score_cli with the same arguments to run a fresh audit (subject to the audit rate limit and the operator-controlled live-scoring kill switch)."
}
```

The miss is `isError: false`. Cache state is data, not failure. Follow the `next_tool` pointer.

### "I want to live-audit a CLI that isn't cached yet"

Call `score_cli` with the same input shape. On a registry or cache hit it redirects you back to `get_scorecard` (no
container run, no cost). On a true cache miss it runs a metered audit and returns the fresh scorecard.

```json
// tools/call score_cli { "github_url": "https://github.com/owner/some-new-cli" }
// HIT — already cached, no audit ran
{
  "audited": false,
  "source": "live-cache",
  "next_tool": "get_scorecard",
  "scorecard_url": "https://anc.dev/score/live/some-new-cli",
  "message": "a cached live-score result already exists; call get_scorecard for the inline record."
}

// MISS — fresh container audit ran
{
  "audited": true,
  "source": "fresh-audit",
  "scorecard_url": "https://anc.dev/score/live/some-new-cli",
  "scorecard": { "...": "..." },
  "anc_version": "0.7.2",
  "spec_version": "2026.05"
}
```

The tools are symmetric: `get_scorecard` returns `found: true` exactly when `score_cli` returns `audited: false` on the
same input. The cost difference (registry/cache lookup vs container run) is the only reason to choose between them.

## Audit a website

Four tools score a website and its MCP server against the same eight principles as a CLI, mirroring the scorecard
surface above. The web audit runs entirely as in-Worker network probes (HTTP, JSON-RPC over streamable-HTTP, CORS,
DNS-over-HTTPS): no container, nothing crawled.

- `get_website_audit` (cheap read): pass a `url`; returns `{ found: true, cached, scored_at, refresh_after, scorecard,
  share_url, spec_version }` on a cache hit or `{ found: false, next_tool: "audit_website" }` on a miss.
- `audit_website` (metered fresh audit): runs a fresh audit and returns a single terminal scorecard plus its
  `share_url`. There are no progress notifications: the server runs stateless per-request. A cached result younger than
  one minute is returned without re-running. Gated by `WEB_AUDIT_ENABLED` + `WEB_AUDIT_LIMITER_IP` (30 per hour per IP,
  no anon fallback).
- `list_website_audits`: the web leaderboard (`anc.dev/web`), curated by default; `view: "all"` adds the user-submitted
  domains that opted in to public listing.
- `get_web_remediation`: the canonical fix for a web-audit `check_id`. Pass the failing row's `evidence` and it is
  appended to the prompt as a delimited, length-bounded data block; omit it for the catalog text alone.

```jsonc
// tools/call audit_website { "url": "anc.dev" }
```

**Freshness.** Every result that carries a scorecard carries `cached`, `scored_at`, and `refresh_after` beside it,
outside the scorecard itself. `cached` is `true` for a served cache entry or a listing-only flag patch and `false` for a
result the call produced; `scored_at` is when the audit ran (`null` on a legacy entry with no stamp); `refresh_after` is
`scored_at` plus the one-minute cache-reuse window. Past `refresh_after` a repeat call stops reusing the cached entry
and tries a fresh audit, which is eligibility rather than a promise: the kill switch, the rate limits, and probe
failures still apply, and the cached scorecard is served as data when they refuse.

Web scorecards use the `score` / `results` / `coverage_summary` shape documented at
[/web-scorecard-schema](/web-scorecard-schema); each result page is at `anc.dev/web/<domain>`. That page publishes four
further read-only tools over WebMCP for a browser agent already on it (`get_worksheet`, `get_fix_prompt`,
`get_fix_prompts`, `get_audit_summary`); they read the rendered page only and cannot start an audit. Their filter,
ordering, and pagination contract is at [/web-audit](/web-audit#from-the-result-page).

## Browse the catalog

Three tools over the curated registry. None of them require a network round trip on the server side, since every
response is a slice of the build-time catalog projection. Live-scored binaries do **not** appear here; they only show up
via `get_scorecard` / `score_cli`.

```json
// tools/call list_tools
[
  {
    "slug": "ripgrep", "name": "ripgrep", "binary": "rg",
    "install": "brew install ripgrep",
    "version": "14.1.0", "score_pct": 87,
    "scorecard_url": "/score/ripgrep",
    "audit_profile": null
  },
  "..."
]

// tools/call get_tool { "slug": "ripgrep" }
{ "found": true, "entry": { "...": "..." } }

// tools/call get_tool { "slug": "nonexistent" }
{ "found": false, "message": "no registry entry for slug: nonexistent" }

// tools/call search_tools { "score_min": 80, "audit_profile": "default" }
[ "...summaries matching all filters..." ]
```

Filters AND together. Rows without a committed scorecard are excluded when either of `score_min` / `score_max` is set.
`principle_min_score` is reserved for a future per-principle filter and is currently a no-op.

## Read the spec

Two pairs of tools cover the spec text and the principles that derive from it. The principle records carry the
`audit_id` strings the `anc` CLI emits. Those identifiers are useful when an agent is reading a scorecard and wants to
look up exactly which requirement a finding maps to.

```json
// tools/call list_principles
[
  {
    "n": 1, "slug": "p1-non-interactive-by-default",
    "title": "Non-interactive by default",
    "level_summary": {"must": 3, "should": 2, "may": 1}
  },
  "..."
]

// tools/call get_principle { "n": 1 }
{
  "found": true,
  "principle": {
    "n": 1, "slug": "p1-non-interactive-by-default",
    "title": "Non-interactive by default",
    "body_markdown": "...",
    "requirements": [
      { "id": "p1.r1", "level": "must", "summary": "...", "audit_ids": ["p1.r1.no-tty-prompt"] },
      "..."
    ]
  }
}

// tools/call list_spec_sections
{
  "spec_version": "2026.05",
  "sections": [
    { "slug": "readme", "title": "README", "level": 1, "parent_slug": null },
    { "slug": "p1-non-interactive-by-default", "title": "Non-interactive by default", "level": 2, "parent_slug": "principles" },
    "..."
  ]
}

// tools/call get_spec_section { "slug": "scoring" }
{
  "found": true,
  "section": {
    "slug": "scoring", "title": "Scoring",
    "body_markdown": "...",
    "spec_version": "2026.05"
  }
}
```

`get_principle` and `get_spec_section` both return `isError: false` with `found: false` on a miss. Absence is data.

## Resources (direct URI lookup)

Five resources cover the same content as the tools, addressable by URI for clients that prefer the `resources/read`
flow.

| URI                        | Returns                                       |
| -------------------------- | --------------------------------------------- |
| `anc://registry`           | full denormalized catalog (concrete resource) |
| `anc://tool/{slug}`        | single CLI record                             |
| `anc://principle/{n}`      | single principle body and requirements        |
| `anc://spec/{section}`     | single spec section body                      |
| `anc://scorecard/{binary}` | cached scorecard for a CLI by binary name     |

Per-item records live behind templates surfaced via `resources/templates/list`. `resources/list` returns only the one
concrete resource (`anc://registry`).

## When things fail

Two error layers. The discriminator is whether the JSON-RPC envelope itself succeeded.

| Symptom                                                | Layer        | Recovery                                                                                                                       |
| ------------------------------------------------------ | ------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `CallToolResult` with `isError: true`                  | Tool-level   | Read the text content; the message names the failure (validator rejection, infrastructure, rate-limit).                        |
| `error.code: -32700` at HTTP 400                       | Transport    | Malformed JSON body; the envelope's `id` is `null` because the request never parsed. Fix the request and resend.               |
| JSON-RPC envelope with `error.code: -32099`            | Transport    | Rate limit. Back off per the policy below; either limiter can trip this.                                                       |
| `error.code: -32022` at HTTP 200, no `data.requested`  | Transport    | The legacy lane is disabled. `error.data.supported` lists the served revision (`2026-07-28`); resend as a modern request.      |
| `error.code: -32022` at HTTP 400 with `data.requested` | Transport    | Your claimed protocol version is unsupported. Resend claiming a version from `error.data.supported`.                           |
| JSON-RPC envelope with `error.code: -32020`            | Transport    | Header mismatch. `Mcp-Method` and `Mcp-Name` must mirror the JSON-RPC body (`Mcp-Name` mirrors the tool name or resource URI). |
| JSON-RPC envelope with `error.code: -32600`            | Transport    | Invalid request at HTTP 400: an empty batch, a non-JSON-RPC object, or a batch mixing modern-envelope elements.                |
| JSON-RPC envelope with `error.code: -32601`            | Transport    | Unknown method. Check the method name against the wire reference below.                                                        |
| JSON-RPC envelope with `error.code: -32602`            | Transport    | Invalid params; also the miss code for an unknown tool or resource (the legacy `-32002` resource-miss code is never emitted).  |
| HTTP `406 Not Acceptable` (plain-text body)            | Pre-JSON-RPC | Your `Accept` header doesn't include `application/json` or `text/event-stream`. Send one or both.                              |
| HTTP `503 Service Unavailable` with `Retry-After`      | Pre-JSON-RPC | Operator kill switch. Honor `Retry-After`. The read tier may still be available even if `score_cli` isn't.                     |

### Common tool-level error shapes

```json
// score_cli with invalid input (security-gate rejection)
{ "isError": true, "content": [{
  "type": "text",
  "text": "{\"error\": \"invalid_input\", \"code\": \"unsupported_install_target\"}"
}]}

// score_cli when live-scoring is disabled by the operator
// isError: false — read tier still works
{ "audited": false, "message": "live scoring is currently disabled by the operator; cached scorecards remain available via get_scorecard." }

// any tool when MCP_LIMITER trips
{ "isError": true, "content": [{
  "type": "text",
  "text": "{\"jsonrpc\":\"2.0\",\"error\":{\"code\":-32099,\"message\":\"rate limit exceeded\"}}"
}]}
```

**Always check `isError` before parsing content as a result.** A `found: false` body with `isError: false` is a typed
redirect carrying a `next_tool` pointer; treating it as an error and giving up is the most common client bug.

## Rate limits you'll actually hit

Two limiters, two cost profiles.

| Limiter             | Scope                              | Ceiling                  | Keyed on           | Anon fallback |
| ------------------- | ---------------------------------- | ------------------------ | ------------------ | ------------- |
| `MCP_LIMITER`       | every `POST /mcp` request          | 60 per 60 seconds per IP | `cf-connecting-ip` | yes (shared)  |
| `MCP_AUDIT_LIMITER` | `score_cli` cache-miss audits only | 5 per 60 minutes per IP  | `cf-connecting-ip` | **no**        |

The audit tier rejects requests with no `cf-connecting-ip` header rather than consuming a shared bucket, because
container-run cost is non-trivial and a shared anon bucket would be a DoS vector. The hourly ceiling is enforced in two
layers (CF binding burst gate + KV-backed per-hour window); both surface as `-32099` on breach.

Read-tier breach is recoverable by waiting out the 60-second window. Audit-tier breach needs an hour-bucket window to
roll. Both ceilings are pre-data placeholders sized from parity with sister deployments and will be tuned with
`mcp.request` log volume.

## Wire-level reference

For clients that need the protocol details.

**Endpoint.** `POST https://anc.dev/mcp`. `GET` is also serviceable: it returns the human landing page, or a permanent
redirect to the server card under a JSON `Accept`. Every other method returns `405 Method Not Allowed` advertising
`Allow: GET, POST`. No authentication.

**Transport.** Streamable HTTP per MCP spec revision `2026-07-28`. Legacy clients send `initialize` with client
`protocolVersion=2025-06-18`; modern clients use `MCP-Protocol-Version: 2026-07-28`, `Mcp-Method`, optional `Mcp-Name`
(call only), and `_meta` inside JSON-RPC **params** (including `io.modelcontextprotocol/clientCapabilities` on both list
and call). The server card's `protocolVersion` is pinned in lockstep; tests assert each literal so drift breaks the
build.

**Tool metadata.** Every `tools/list` entry carries a `title` (a short display name) alongside `description` and
`inputSchema`, plus an `annotations` object describing the tool's posture. The eleven read tools carry `readOnlyHint:
true`. The two tools that run fresh work, `score_cli` and `audit_website`, carry `readOnlyHint: false` with
`destructiveHint: false`, `idempotentHint: false`, and `openWorldHint: true`, because they reach external systems and
write cache and leaderboard state. Annotations are hints for client UX and consent prompts, not a security boundary.

**Accept-header negotiation.** Server picks between `application/json` and `text/event-stream`. JSON wins ties; q-values
resolve unequal preferences. Absent or `*/*` Accept → JSON. Only a request that accepts neither MIME type returns `406`.

| Client `Accept` header                            | Response                                  |
| ------------------------------------------------- | ----------------------------------------- |
| absent or `*/*`                                   | `application/json`                        |
| `application/json`                                | `application/json`                        |
| `text/event-stream`                               | `text/event-stream` (SSE framing)         |
| `application/json, text/event-stream`             | `application/json` (JSON wins ties)       |
| `application/json;q=0.5, text/event-stream;q=0.9` | `text/event-stream` (higher q-value wins) |
| any value with neither type acceptable            | `406 Not Acceptable` (plain text)         |

**Discovery siblings.**

- `https://anc.dev/.well-known/mcp/server-card.json`: canonical MCP server card (SEP-1649). Pointer aliases:
  `/.well-known/mcp`, `/mcp.json`.
- `https://anc.dev/.well-known/ai.txt`: AI-training and agent-access posture plus `Programmatic-API:
  https://anc.dev/mcp`.
