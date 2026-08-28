# MCP wire-protocol reference

Engineering reference for the two protocol lanes served on `POST https://anc.dev/mcp`. It records what goes on the wire:
which layer produces each JSON-RPC error code, whether the code arrives in an envelope or as a bare HTTP status, and
what the SEP-2243 headers and the modern `_meta` envelope have to carry. It is the starting point for a protocol bump,
because a revision change is mostly a change to the table below.

Companions, each with a different job: [`mcp-operator.md`](mcp-operator.md) covers the surfaces operators own (kill
switches, rate-limit policy, observability); [`content/mcp-skill.md`](../../content/mcp-skill.md) is the published
client guide. This file is unpublished and lives under `docs/`, which `guard-main-docs` keeps off `main`.

**Every fact here is read from `src/` or from a test that pins it, and each row cites where.** Rows marked `(observed)`
were confirmed against the real handler but are not pinned by a shipped test, so they are the rows most likely to drift
silently on an SDK bump. Do not copy a code out of a plan, a skill, or a neighboring doc into this table: read it off
the wire.

## Two lanes on one endpoint

One handler serves both eras. The lane is a property of the request, not of the deployment.

| Lane       | Client shape                                                                                 | Session                              |
| ---------- | -------------------------------------------------------------------------------------------- | ------------------------------------ |
| **legacy** | `initialize` handshake, then `tools/call`; no SEP-2243 headers                               | stateless mode; no session id issued |
| **modern** | SEP-2243 headers (`MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name`) plus `_meta` in `params` | sessionless; no `initialize`         |

The served revision is `2026-07-28`, pinned once at `src/worker/mcp/instructions.ts:17` (`SPEC_REVISION`) and
re-exported through `src/worker/mcp/server.ts:129`. `MCP_LEGACY_ENABLED=false` closes the legacy lane and leaves the
modern lane serving (`tests/worker-mcp-dispatch.test.ts:1015`).

## Which layer answers

Five layers can end a request. The first one to answer wins, so a code's meaning depends on where it was produced.

1. **Dispatch shell** (`src/worker/index.ts:553-763`): kill switch, method gate, Accept gate, legacy-era gate, rate
   limiter. Everything it emits is hand-built in this repo.
2. **SDK transport** (`agents/mcp/server` via `createMcpHandler`, wired at `src/worker/mcp/server.ts:98-118`): JSON
   parse, batch shape, protocol-version check, SEP-2243 header mirror, `_meta` validation.
3. **SDK method router**: method-not-found.
4. **Tool and resource handlers** (`src/worker/mcp/tools/`, `src/worker/mcp/resources.ts`): argument validation and
   resource lookup.
5. **SDK era encode seam**: re-encodes what layer 4 threw into the code that reaches the client. This seam is why the
   resource handler's tag and the wire code differ (see `-32002` below).

The shell runs its gates in a fixed order, and the ordering is load-bearing. The legacy-era gate additionally requires a
parsed body (`src/worker/index.ts:658`), so a malformed body reaches the SDK and earns a parse error rather than a
misleading era rejection (`tests/worker-mcp-dispatch.test.ts:923`).

## Error-code table

| Code     | Meaning                    | Produced by                    | Delivery                                                     | Verified at                                                                             |
| -------- | -------------------------- | ------------------------------ | ------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `-32700` | Parse error                | SDK transport (layer 2)        | HTTP **400**, envelope, `id: null`                           | `tests/worker-mcp-dispatch.test.ts:897`; holds with the legacy lane closed, `:923`      |
| `-32600` | Invalid Request            | SDK transport (layer 2)        | HTTP **400**, envelope, `id: null`                           | modern element in a batch `tests/worker-mcp-dispatch.test.ts:1134`; empty array `:1143` |
| `-32601` | Method not found           | SDK method router (layer 3)    | legacy HTTP **200**; modern HTTP **404**, envelope both ways | legacy `tests/worker-mcp.test.ts:664` via `mcpRpcExpect200`; modern 404 (observed)      |
| `-32602` | Invalid params, miss code  | SDK layers 2/4 + encode seam   | HTTP **200** for a miss; HTTP **400** for `_meta` validation | see the `-32602` breakdown below                                                        |
| `-32020` | Header mismatch (SEP-2243) | SDK transport (layer 2)        | HTTP **400**, envelope                                       | `tests/worker-mcp-dispatch.test.ts:1098`; `tests/worker-mcp.test.ts:718`                |
| `-32022` | UnsupportedProtocolVersion | **two producers, split below** | shell HTTP **200**; SDK HTTP **400**                         | shell `tests/worker-mcp-dispatch.test.ts:980`; SDK `:1151`                              |
| `-32099` | Rate limit                 | dispatch shell (layer 1)       | HTTP **200**, envelope, request `id` echoed                  | `tests/worker-mcp-dispatch.test.ts:557`, `:1073`                                        |
| `-32002` | Resource not found         | resource handler tag only      | **never reaches the wire**; the encode seam rewrites it      | `src/worker/mcp/resources.ts:45`; rewrite noted at `tests/worker-mcp.test.ts:657`       |
| `-32603` | Internal error             | not emitted deliberately       | not probed                                                   | `src/worker/audit-web/handlers/mcp.ts:266`                                              |

### `-32700` and the 4xx duality

A parse failure is the one case where the JSON-RPC code and the HTTP status carry the same news twice. The envelope is
well-formed even though the request was not, and `id` is `null` because no id was ever parsed. A conforming server may
also refuse an unparseable body with a bare HTTP 400 or 415 and no envelope at all; both shapes are legitimate. The
web-audit handler accepts either arm (`src/worker/audit-web/handlers/mcp.ts:270-275`, whose `httpAccept` is the
`TYPED_REFUSAL_STATUSES` set `[400, 415]` at `:187`). What is not legitimate is HTTP 200 carrying garbage, and 404 sits
outside the accepted set on purpose so a dead endpoint earns nothing (`:186`).

anc itself takes the envelope arm: HTTP 400 with a `-32700` body.

### `-32601` delivered as 404 on the modern lane

The same code arrives at two different statuses depending on the lane. The legacy lane answers an unknown method at HTTP
200 (`tests/worker-mcp.test.ts:664`, which routes through `mcpRpcExpect200` at `tests/helpers/mcp-rpc.ts:100`, so the
200 is pinned by the helper's throw). The modern lane answers HTTP **404** with the `-32601` envelope in the body
(observed against the handler).

404 delivery conforms as long as the body carries the envelope. A bare 404 with no envelope does not, and the
distinction is enforced rather than assumed: `tests/web-audit-handlers.test.ts:1296` names it exactly, and the registry
records the tolerance at `src/data/web-audit/registry.yaml:278`.

`-32601` is also one of the two codes that read as "this lane is not offered" rather than "this request was wrong"
(`LANE_UNAVAILABLE_CODES`, `src/worker/audit-web/handlers/mcp.ts:134`). That reading applies only to a request that
names a method the lane could be missing, which is why answering `-32601` to a conformance probe scores as broken
(`tests/web-audit-handlers.test.ts:1464`).

### `-32602` covers three questions at two statuses

`-32602` is the busiest code on the surface, and the status is what separates its meanings.

| Condition                                          | Lane   | Status  | Verified at                                          |
| -------------------------------------------------- | ------ | ------- | ---------------------------------------------------- |
| `tools/call` naming an unknown tool                | legacy | **200** | `tests/worker-mcp.test.ts:670`                       |
| `tools/call` naming an unknown tool                | modern | **200** | observed                                             |
| `resources/read` on a URI that matches no resource | legacy | **200** | `tests/worker-mcp.test.ts:647`                       |
| `resources/read` on a URI that matches no resource | modern | **200** | `tests/worker-mcp-dispatch.test.ts:1083`             |
| `_meta` missing `clientCapabilities`               | modern | **400** | code `tests/worker-mcp.test.ts:707`; status observed |

The resource-miss rows are the ones worth reading twice. `src/worker/mcp/resources.ts:45` tags the thrown error `.code =
-32002`, but `-32002` never reaches the wire: the SDK era encode seam rewrites it to `-32602` on **both** lanes. A
client that branches on `-32002` against this server matches nothing.

`-32002` remains receive-tolerated, because non-SDK servers do emit it. The web-audit resource-miss probe accepts either
code (`src/worker/audit-web/handlers/mcp.ts:335`, `accept: [-32602, -32002]`), and the tolerance is pinned at
`tests/web-audit-handlers.test.ts:1609`.

The `_meta` row is the odd one out: it is a transport-layer envelope rejection, so it lands at HTTP 400 with the SDK
message `Invalid _meta envelope for protocol revision 2026-07-28: io.modelcontextprotocol/clientCapabilities: missing`.
Conforming non-SDK servers may put this in the invalid-request family instead, so the audit accepts `-32600` alongside
`-32602` (`src/worker/audit-web/handlers/mcp.ts:305`; `tests/web-audit-handlers.test.ts:1374`).

### `-32022`: one code, two producers, two statuses

This is the split most likely to be documented wrong, because the code alone does not identify the condition.

| Producer                                      | Condition                                              | Status  | `error.data`                     | Verified at                              |
| --------------------------------------------- | ------------------------------------------------------ | ------- | -------------------------------- | ---------------------------------------- |
| **Dispatch shell**, `src/worker/index.ts:659` | legacy lane closed and a legacy request arrives        | **200** | `supported: ["2026-07-28"]`      | `tests/worker-mcp-dispatch.test.ts:980`  |
| **SDK transport**                             | request claims a protocol revision the server does not | **400** | `supported` **plus** `requested` | `tests/worker-mcp-dispatch.test.ts:1151` |

Both carry `data.supported`. Only the SDK's version reject carries `data.requested`, which is the field that tells the
two apart when the status is unavailable. The shell's reject echoes the request id (`:991`) and uses `id: null` for an
all-legacy batch (`:1027`); the SDK's version reject echoes the id (`:1168`).

The shell reject is the wire face of the `MCP_LEGACY_ENABLED` kill switch, and it logs `outcome: legacy_rejected` with
`error_code: -32022` (`src/worker/index.ts:675`, pinned at `tests/worker-mcp-dispatch.test.ts:994`). It is deliberately
not the rate-limit code: `-32022` and `-32099` are distinct conditions and must stay distinct in logs.

Like `-32601`, `-32022` reads as lane-unavailable rather than request-invalid (`LANE_UNAVAILABLE_CODES`,
`src/worker/audit-web/handlers/mcp.ts:134`).

### `-32099`: rate limit

The shell emits it when `MCP_LIMITER` denies (`src/worker/index.ts:697`), at HTTP 200 with the request id echoed. The
`mcp.request` log line fires after the gate so denials stay recorded while log volume stays bounded
(`src/worker/index.ts:698-709`).

**A `-32099` inside a tool result is a different thing.** `audit_website` and `score_cli` return their budget refusals
as `CallToolResult` with `isError: true`, carrying a `-32099`-shaped JSON string inside a text content block
(`src/worker/mcp/tools/web-audit.ts:76`, `src/worker/mcp/tools/scorecard-audit.ts:76`). The JSON-RPC envelope around it
is successful. Pinned at `tests/worker-mcp-audit.test.ts:406` and `tests/web-audit-mcp-tools.test.ts:423`. Tool-level
failure and transport-level failure are two layers, and only the second one is in this document's table.

## Responses with no JSON-RPC envelope

Three shell rejections happen before or outside JSON-RPC, so they carry a plain-text body and no envelope. Treating
these as JSON-RPC errors is a common client bug.

| Condition                            | Response                                   | Verified at                                                |
| ------------------------------------ | ------------------------------------------ | ---------------------------------------------------------- |
| `MCP_ENABLED` is not `'true'`        | **503**, `Retry-After: 3600`, `text/plain` | `tests/worker-mcp-dispatch.test.ts:292`, body shape `:300` |
| Method is neither `GET` nor `POST`   | **405**, `Allow: GET, POST`, `text/plain`  | `tests/worker-mcp-dispatch.test.ts:309`                    |
| `Accept` allows neither JSON nor SSE | **406**, `text/plain`                      | `tests/worker-mcp-dispatch.test.ts:531`                    |

The 406 is pre-JSON-RPC by design (`src/worker/index.ts:615`): there is no negotiated type in which to serialize an
envelope, so sending one would answer in a type the caller just refused.

## SEP-2243 header mirror

On the modern lane the request headers restate what the body says, so infrastructure can route and rate-limit without
parsing JSON-RPC. The rules are narrow and the penalty for breaking them is a single code.

- **`MCP-Protocol-Version`** carries the claimed revision. A revision the server does not serve draws `-32022` at HTTP
  400 with `data.supported` and `data.requested`.
- **`Mcp-Method`** must be present and must equal the body's `method` on any request carrying an id. Absent draws
  `-32020` (`the required Mcp-Method header is absent`); disagreeing draws `-32020` (`the body names method tools/list
  but the Mcp-Method header names resources/list`). Both observed; the disagreement arm is pinned at
  `tests/worker-mcp-dispatch.test.ts:1098` through its `Mcp-Name` sibling.
- **`Mcp-Name`** rides the two methods that name a target, and mirrors a different field in each:

| Method           | `Mcp-Name` mirrors | Verified at                         |
| ---------------- | ------------------ | ----------------------------------- |
| `tools/call`     | `params.name`      | `tests/helpers/mcp-modern.ts:51-57` |
| `resources/read` | `params.uri`       | `tests/helpers/mcp-modern.ts:87-93` |

  Absent or disagreeing draws `-32020` at HTTP 400, not a resource miss. This is the trap the header mirror sets for
  probe authors: a `resources/read` probe whose `Mcp-Name` carries the template name rather than the resource URI never
  reaches the resource handler, so it measures the header layer while appearing to measure the miss code
  (`tests/worker-mcp.test.ts:718` states exactly this, and `tests/worker-mcp-dispatch.test.ts:1083` is the correctly
  mirrored counterpart that does reach the handler).

The mirror binds requests, not notifications. A notification (no `id` field) without `Mcp-Method` is accepted at HTTP
**202** with an empty body (observed). The shell reads both headers case-insensitively
(`src/worker/mcp/rate-limit.ts:27-33`) and uses `Mcp-Name` to scope modern rate-limit keys to a registered tool or
resource-template name (`src/worker/mcp/rate-limit.ts:16-21`), which is a second reason a spoofed name buys nothing: an
unregistered name falls back to the coarse per-IP bucket (`tests/worker-mcp-dispatch.test.ts:966`).

## The modern `_meta` envelope

Every modern request carries `_meta` inside `params`, with three keys:

```json
{
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { "name": "your-client", "version": "0" },
  "io.modelcontextprotocol/clientCapabilities": {}
}
```

Shape verified at `tests/helpers/mcp-modern.ts:10-16`, mirrored independently by the auditor at
`src/worker/audit-web/handlers/mcp.ts:228-234`.

**`clientCapabilities` is mandatory and an empty object satisfies it.** Omitting the key draws `-32602` at HTTP 400 even
though the other two keys are present, because the envelope is validated as a whole before the method runs. This is the
single easiest way to write a probe that looks like it found a server bug when it found its own
(`tests/worker-mcp.test.ts:707`; the auditor's negative probe is built by dropping exactly this key,
`src/worker/audit-web/handlers/mcp.ts:301-304`).

A version reject echoes the claim back rather than only naming what is served, so a client can resolve the mismatch in
one round trip:

```json
{
  "jsonrpc": "2.0",
  "id": 14,
  "error": {
    "code": -32022,
    "data": { "supported": ["2026-07-28"], "requested": "2025-03-26" }
  }
}
```

Field-for-field pinned at `tests/worker-mcp-dispatch.test.ts:1160-1168`.

## Cache hints

Four read methods return `ttlMs` and `cacheScope` alongside the result, declared once at
`src/worker/mcp/server.ts:33-38` and handed to the `McpServer` constructor at `:89`. All four are one hour and `public`.

`cacheScope` is about who may reuse the answer, not about whether it is secret:

- **`public`** means the answer is caller-neutral. The same request from any caller produces the same result, so a
  shared cache in front of many agents may serve one answer to all of them. anc's catalog is unauthenticated and
  identical for every caller, so every hinted method is `public`.
- **`private`** means the answer is credential-scoped. It varies by who asked, so it may be cached only per caller and
  never in a shared tier.

Pinned on the wire at `tests/worker-mcp.test.ts:690-691` (`ttlMs: 3600000`, `cacheScope: 'public'`), which reads the
values out of a live `tools/list` response rather than asserting the constant.

## GET posture

There are two defensible answers to `GET` on an MCP endpoint, and the divergence is worth stating plainly because a
reviewer expecting one will read the other as a bug.

The hazard both answers address is the same: a streamable-HTTP `GET` routed into the transport opens the
server-to-client SSE notification stream, and a stateless server with nothing to push parks that connection until the
caller times out.

1. **Fast-fail.** Answer non-`POST` at the router with `405 Method Not Allowed`.
2. **Serve a documented surface.** Return something a human or an agent can read.

anc takes the second, deliberately. `GET /mcp` is content-negotiated (`src/worker/index.ts:560-569`):

| `Accept`               | Response                                       | Verified at                                     |
| ---------------------- | ---------------------------------------------- | ----------------------------------------------- |
| `application/json`     | **301** to `/.well-known/mcp/server-card.json` | `tests/worker-mcp-dispatch.test.ts:418`         |
| `text/html`, or absent | **200** `dist/mcp.html`, the full site shell   | `tests/worker-mcp-dispatch.test.ts:402`, `:379` |
| `text/markdown`        | **200** `dist/mcp.md`, the markdown twin       | `tests/worker-mcp-dispatch.test.ts:409`         |

The reasoning: the endpoint's URL should document itself. An agent that finds `/mcp` in an `llms.txt` and issues a plain
`GET` gets a page explaining the surface instead of a rejection, and one that asks for JSON gets machine-readable
identity. That identity survives the kill switch, because the JSON redirect is served even when `MCP_ENABLED` is off
(`tests/worker-mcp-dispatch.test.ts:449`): a disabled surface still says what it is.

The 405 is not abandoned, only narrowed. `PUT`, `DELETE`, and `PATCH` get `405` with `Allow: GET, POST`
(`src/worker/index.ts:600-609`, `tests/worker-mcp-dispatch.test.ts:309`). Note the `Allow` value names both serviceable
methods, so it differs from the fast-fail posture's `Allow: POST`.

Scoring treats both answers as conforming. The `mcp-get-fast-fail` check fails only on a held-open hang or a `5xx`
(`src/data/web-audit/registry.yaml:355-368`; remediation prose at `src/data/web-audit/remediation.yaml:222-233`).
`OPTIONS` deliberately falls through to static assets and 404s, which is the browser-blocked posture for a
server-to-agent endpoint (`src/worker/index.ts:554-558`).

## Codes deliberately not probed

Two codes are excluded from the conformance matrix, recorded at `src/worker/audit-web/handlers/mcp.ts:266-268` and
`src/data/web-audit/registry.yaml:229-230`:

- **`-32603` (internal error)** cannot be forced from outside. A probe that provokes one is measuring a bug it caused,
  not a contract.
- **`-32099` (rate limit)** can be forced, but forcing it against a third-party server is abusive. The auditor treats a
  received `-32099` as an operational condition and excludes the row from scoring rather than penalizing a target for
  defending itself (`RATE_LIMITED_CODE`, `src/worker/audit-web/handlers/mcp.ts:140`; pinned at
  `tests/web-audit-handlers.test.ts:2202`).

A third code appears in probe results without being probed for: **`-32000`**, JSON-RPC's reserved generic server error,
which a stateful legacy server returns to a sessionless POST (`SESSION_REQUIRED_CODE`,
`src/worker/audit-web/handlers/mcp.ts:182`). It is a statefulness signal, not an error-taxonomy signal.

## Bumping the revision

When the SDK moves to a new revision, work the table rather than the prose:

1. Change `SPEC_REVISION` at `src/worker/mcp/instructions.ts:17`. The drift gate makes every other copy of the literal
   fail until it matches (server card, `content/mcp-skill.md`, the handshake).
2. Re-run each row of the error-code table against the new SDK. A major bump can move a status without moving a code,
   which is the failure mode this document exists to catch. The per-lane pins in `tests/worker-mcp-dispatch.test.ts` and
   `tests/worker-mcp.test.ts` are the executable form of the table.
3. Re-verify the four `(observed)` rows first. They have no test holding them still.
4. Update the auditor's accept sets (`CONFORMANCE_PROBES`, `src/worker/audit-web/handlers/mcp.ts:269-337`) only after
   the server-side pins are green, so the audit never scores against an unverified expectation.

## References

- **EmailEngine's dual-stack protocol reference**: <https://learn.emailengine.app/docs/mcp/protocol>. Third-party
  corroboration from a production dual-stack server, useful when deciding whether a shape is an SDK artifact or the
  protocol.
- **Shared solutions archive** (`~/dev/solutions-docs`), the dual-protocol learnings:
  - `architecture-patterns/mcp-sdk-v2-dual-stack-migration-for-cloudflare-worker-mcp-servers.md`
  - `conventions/pin-wire-contract-error-codes-per-lane-in-tests-when-swapping-sdk-majors.md`
  - `conventions/reject-lane-error-envelopes-derive-every-field-from-canonical-sources.md`
  - `conventions/unit-worker-returns-carry-provisional-status-and-probe-evidence-not-the-shipped-tree.md`
  - `integration-issues/agents-legacy-mcp-lane-dual-accept-rewrite-and-sse-to-json-coercion.md`
  - `integration-issues/mcp-probe-missing-clientcapabilities-meta-on-tools-call-32602.md`
