# Using anc.dev's MCP server

anc.dev exposes the agent-native CLI standard catalog over a Model Context Protocol server at `https://anc.dev/mcp`.
Nine tools cover four surfaces (registry, principles, spec, scorecards) plus five resources for direct lookup. The
catalog is public: no authentication, no API key. This page is the **client integration guide**: how to call each tool,
what comes back, and what to do when something fails. Operator-facing material (kill switches, structured logging, CORS
posture) lives in the in-repo runbook at `docs/runbooks/mcp-operator.md`.

## Quick reference

The server speaks streamable HTTP per MCP spec revision `2025-06-18`. Drive it from any MCP-aware client (Claude Code,
Codex, Cursor) or raw JSON-RPC:

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

| Symptom                                           | Layer        | Recovery                                                                                                   |
| ------------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------- |
| `CallToolResult` with `isError: true`             | Tool-level   | Read the text content; the message names the failure (validator rejection, infrastructure, rate-limit).    |
| JSON-RPC envelope with `error.code: -32700`       | Transport    | Malformed JSON body. Fix the request and resend.                                                           |
| JSON-RPC envelope with `error.code: -32099`       | Transport    | Rate limit. Back off per the policy below; either limiter can trip this.                                   |
| HTTP `406 Not Acceptable` (plain-text body)       | Pre-JSON-RPC | Your `Accept` header doesn't include `application/json` or `text/event-stream`. Send one or both.          |
| HTTP `503 Service Unavailable` with `Retry-After` | Pre-JSON-RPC | Operator kill switch. Honor `Retry-After`. The read tier may still be available even if `score_cli` isn't. |

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
visitor-log data.

## Wire-level reference

For clients that need the protocol details.

**Endpoint.** `POST https://anc.dev/mcp`. Other methods return `405 Method Not Allowed` with `Allow: POST`. No
authentication.

**Transport.** Streamable HTTP per MCP spec revision `2025-06-18`. The handshake's `protocolVersion` and the
`/.well-known/mcp` pointer's `version` are pinned in lockstep; tests assert each literal so drift breaks the build.

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

- `https://anc.dev/.well-known/mcp`: HTTP-level JSON pointer carrying `mcp_endpoint`, `version`, `description`,
  `transport`, and `documentation` (this page).
- `https://anc.dev/.well-known/ai.txt`: AI-training and agent-access posture plus `Programmatic-API:
  https://anc.dev/mcp`.
