# MCP wire-protocol reference

Engineering reference for the two protocol lanes served on `POST https://anc.dev/mcp`. It records what goes on the wire:
which layer produces each JSON-RPC error code, whether the code arrives in an envelope or as a bare HTTP status, and
what the SEP-2243 headers and the modern `_meta` envelope have to carry. It is the starting point for a protocol bump,
because a revision change is mostly a change to the table below.

Companions, each with a different job: [`mcp-operator.md`](mcp-operator.md) covers the surfaces operators own (kill
switches, rate-limit policy, observability); [`content/mcp-skill.md`](../../content/mcp-skill.md) is the published
client guide. This file is unpublished and lives under `docs/`, which `guard-main-docs` keeps off `main`.

**Every fact here is read from `src/` or from a test that pins it, and each row cites where.** A citation is
`path#anchor`: the anchor is a test or `describe` title in a test file, and an identifier or verbatim string anywhere
else. Line numbers are never cited, and `tests/runbook-citations.test.ts` fails when an anchor stops resolving. Rows
marked `(observed)` were confirmed against the real handler but are not pinned by a shipped test, so they are the rows
most likely to drift silently on an SDK bump. Do not copy a code out of a plan, a skill, or a neighboring doc into this
table: read it off the wire.

## Two lanes on one endpoint

One handler serves both eras. The lane is a property of the request, not of the deployment.

| Lane       | Client shape                                                                                 | Session                              |
| ---------- | -------------------------------------------------------------------------------------------- | ------------------------------------ |
| **legacy** | `initialize` handshake, then `tools/call`; no SEP-2243 headers                               | stateless mode; no session id issued |
| **modern** | SEP-2243 headers (`MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name`) plus `_meta` in `params` | sessionless; no `initialize`         |

The served revision is `2026-07-28`, pinned once at `src/worker/mcp/instructions.ts#SPEC_REVISION` and re-exported
through `src/worker/mcp/server.ts#export { SPEC_REVISION }`. `MCP_LEGACY_ENABLED=false` closes the legacy lane and
leaves the modern lane serving
(`tests/worker-mcp-dispatch.test.ts#MCP_LEGACY_ENABLED=false still serves modern tools/list`).

## Which layer answers

Five layers can end a request. The first one to answer wins, so a code's meaning depends on where it was produced.

1. **Dispatch shell** (`src/worker/index.ts#handleSiteRequest`): kill switch, method gate, Accept gate, legacy-era gate,
   rate limiter. Everything it emits is hand-built in this repo.
2. **SDK transport** (`agents/mcp/server` via `createMcpHandler`, wired in `getMcpHandler` in
   `src/worker/mcp/server.ts`): Host and Origin allowlists, JSON parse, batch shape, protocol-version check, SEP-2243
   header mirror, `_meta` validation.
3. **SDK method router**: method-not-found.
4. **Tool and resource handlers** (`src/worker/mcp/tools/`, `src/worker/mcp/resources.ts`): argument validation and
   resource lookup.
5. **SDK era encode seam**: re-encodes what layer 4 threw into the code that reaches the client. This seam is why the
   resource handler's tag and the wire code differ (see `-32002` below).

The shell runs its gates in a fixed order, and the ordering is load-bearing. The legacy-era gate additionally requires a
parsed body (`src/worker/index.ts#legacyMode === 'reject' && legacyEra && parsedBody !== undefined`), so a malformed
body reaches the SDK and earns a parse error rather than a misleading era rejection
(`tests/worker-mcp-dispatch.test.ts#malformed JSON under MCP_LEGACY_ENABLED=false still answers -32700 at 400, never the
era reject`).

## Error-code table

| Code     | Meaning                    | Produced by                    | Delivery                                                     | Verified at                                                                                                                                                                                                                                                                                                       |
| -------- | -------------------------- | ------------------------------ | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `-32700` | Parse error                | SDK transport (layer 2)        | HTTP **400**, envelope, `id: null`                           | `tests/worker-mcp-dispatch.test.ts#non-JSON body answers a -32700 JSON-RPC envelope at HTTP 400 with id null`; legacy lane closed `tests/worker-mcp-dispatch.test.ts#malformed JSON under MCP_LEGACY_ENABLED=false still answers -32700 at 400, never the era reject`                                             |
| `-32600` | Invalid Request            | SDK transport (layer 2)        | HTTP **400**, envelope, `id: null`                           | `tests/worker-mcp-dispatch.test.ts#a batch carrying a modern-envelope element is rejected -32600`; `tests/worker-mcp-dispatch.test.ts#an empty batch array is rejected -32600`                                                                                                                                    |
| `-32601` | Method not found           | SDK method router (layer 3)    | legacy HTTP **200**; modern HTTP **404**, envelope both ways | legacy `tests/worker-mcp.test.ts#unknown method answers -32601` via `tests/helpers/mcp-rpc.ts#mcpRpcExpect200`; modern 404 (observed)                                                                                                                                                                             |
| `-32602` | Invalid params, miss code  | SDK layers 2/4 + encode seam   | HTTP **200** for a miss; HTTP **400** for `_meta` validation | see the `-32602` breakdown below                                                                                                                                                                                                                                                                                  |
| `-32020` | Header mismatch (SEP-2243) | SDK transport (layer 2)        | HTTP **400**, envelope                                       | `tests/worker-mcp-dispatch.test.ts#modern resources/read with a non-mirroring Mcp-Name is rejected -32020 at HTTP 400`; `tests/worker-mcp.test.ts#modern resources/read with a non-mirroring Mcp-Name is rejected -32020 (header mismatch)`                                                                       |
| `-32022` | UnsupportedProtocolVersion | **two producers, split below** | shell HTTP **200**; SDK HTTP **400**                         | shell `tests/worker-mcp-dispatch.test.ts#MCP_LEGACY_ENABLED=false rejects legacy initialize with -32022 + data.supported at HTTP 200`; SDK `tests/worker-mcp-dispatch.test.ts#a modern claim of an unsupported protocol version draws the SDK -32022 at HTTP 400`                                                 |
| `-32099` | Rate limit                 | dispatch shell (layer 1)       | HTTP **200**, envelope, request `id` echoed                  | `tests/worker-mcp-dispatch.test.ts#rate-limit breach returns -32099 JSON-RPC envelope at HTTP 200`; `tests/worker-mcp-dispatch.test.ts#the rate-limit envelope keeps -32099 with the request id echoed`                                                                                                           |
| `-32000` | Host or Origin rejected    | SDK transport (layer 2)        | HTTP **403**, envelope, `id: null`, both lanes               | `tests/worker-mcp-dispatch.test.ts#a rebinding Host is rejected 403 with -32000 and no access-control headers`; `tests/worker-mcp-dispatch.test.ts#a browser Origin is rejected with the same -32000 the Host gate uses`; `tests/worker-mcp-dispatch.test.ts#production and staging each reject their own origin` |
| `-32002` | Resource not found         | resource handler tag only      | **never reaches the wire**; the encode seam rewrites it      | `src/worker/mcp/resources.ts#.code = -32002`; rewrite pinned at `tests/worker-mcp.test.ts#reading an unknown template URI surfaces a JSON-RPC -32602 error envelope`                                                                                                                                              |
| `-32603` | Internal error             | not emitted deliberately       | not probed                                                   | excluded above `src/worker/audit-web/handlers/mcp.ts#CONFORMANCE_PROBES`                                                                                                                                                                                                                                          |

### `-32700` and the 4xx duality

A parse failure is the one case where the JSON-RPC code and the HTTP status carry the same news twice. The envelope is
well-formed even though the request was not, and `id` is `null` because no id was ever parsed. A conforming server may
also refuse an unparseable body with a bare HTTP 400 or 415 and no envelope at all; both shapes are legitimate. The
web-audit handler accepts either arm (the `'malformed-body'` probe in
`src/worker/audit-web/handlers/mcp.ts#CONFORMANCE_PROBES`, whose `httpAccept` is
`src/worker/audit-web/handlers/mcp.ts#TYPED_REFUSAL_STATUSES`, `[400, 415]`). What is not legitimate is HTTP 200
carrying garbage, and 404 sits outside the accepted set on purpose so a dead endpoint earns nothing
(`tests/web-audit-handlers.test.ts#a bare HTTP 404 with no envelope is broken on every conformance probe (dead-endpoint
guard)`).

anc itself takes the envelope arm: HTTP 400 with a `-32700` body.

### `-32601` delivered as 404 on the modern lane

The same code arrives at two different statuses depending on the lane. The legacy lane answers an unknown method at HTTP
200 (`tests/worker-mcp.test.ts#unknown method answers -32601`, which routes through
`tests/helpers/mcp-rpc.ts#mcpRpcExpect200`, so the 200 is pinned by the helper's throw). The modern lane answers HTTP
**404** with the `-32601` envelope in the body (observed against the handler).

404 delivery conforms as long as the body carries the envelope. A bare 404 with no envelope does not, and the
distinction is enforced rather than assumed: `tests/web-audit-handlers.test.ts#modern-unknown-method accepts HTTP 404
delivery only when the body carries the -32601 envelope` names it exactly, and the registry records the tolerance in the
hint of `src/data/web-audit/registry.yaml#mcp-modern-unknown-method`.

`-32601` is also one of the two codes that read as "this lane is not offered" rather than "this request was wrong"
(`src/worker/audit-web/handlers/mcp.ts#LANE_UNAVAILABLE_CODES`). That reading applies only to a request that names a
method the lane could be missing, which is why answering `-32601` to a conformance probe scores as noncompliant
(`tests/web-audit-handlers.test.ts#an endpoint answering -32601 to everything cannot outscore one that answers honestly`).

### `-32602` covers three questions at two statuses

`-32602` is the busiest code on the surface, and the status is what separates its meanings.

| Condition                                          | Lane   | Status  | Verified at                                                                                                                 |
| -------------------------------------------------- | ------ | ------- | --------------------------------------------------------------------------------------------------------------------------- |
| `tools/call` naming an unknown tool                | legacy | **200** | `tests/worker-mcp.test.ts#tools/call with an unknown tool name answers -32602`                                              |
| `tools/call` naming an unknown tool                | modern | **200** | observed                                                                                                                    |
| `resources/read` on a URI that matches no resource | legacy | **200** | `tests/worker-mcp.test.ts#reading an unknown template URI surfaces a JSON-RPC -32602 error envelope`                        |
| `resources/read` on a URI that matches no resource | modern | **200** | `tests/worker-mcp-dispatch.test.ts#modern resources/read with a mirroring Mcp-Name answers an unknown resource with -32602` |
| `_meta` missing `clientCapabilities`               | modern | **400** | code `tests/worker-mcp.test.ts#tools/call missing clientCapabilities returns -32602 (AE7)`; status observed                 |

The resource-miss rows are the ones worth reading twice. The resource handler tags the thrown error
(`src/worker/mcp/resources.ts#.code = -32002`), but `-32002` never reaches the wire: the SDK era encode seam rewrites it
to `-32602` on **both** lanes. A client that branches on `-32002` against this server matches nothing.

`-32002` remains receive-tolerated, because non-SDK servers do emit it. The web-audit resource-miss probe accepts either
code (`src/worker/audit-web/handlers/mcp.ts#accept: [-32602, -32002]`), and the tolerance is pinned at
`tests/web-audit-handlers.test.ts#modern-resources-miss tolerates the legacy-compat -32002 miss code`.

The `_meta` row is the odd one out: it is a transport-layer envelope rejection, so it lands at HTTP 400 with the SDK
message `Invalid _meta envelope for protocol revision 2026-07-28: io.modelcontextprotocol/clientCapabilities: missing`.
Conforming non-SDK servers may put this in the invalid-request family instead, so the audit accepts `-32600` alongside
`-32602` (`src/worker/audit-web/handlers/mcp.ts#accept: [-32602, -32600]`;
`tests/web-audit-handlers.test.ts#modern-clientcaps also passes on -32600 (invalid-request family)`).

### `-32022`: one code, two producers, two statuses

This is the split most likely to be documented wrong, because the code alone does not identify the condition.

| Producer                                                             | Condition                                              | Status  | `error.data`                     | Verified at                                                                                                                     |
| -------------------------------------------------------------------- | ------------------------------------------------------ | ------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| **Dispatch shell**, `src/worker/index.ts#outcome: 'legacy_rejected'` | legacy lane closed and a legacy request arrives        | **200** | `supported: ["2026-07-28"]`      | `tests/worker-mcp-dispatch.test.ts#MCP_LEGACY_ENABLED=false rejects legacy initialize with -32022 + data.supported at HTTP 200` |
| **SDK transport**                                                    | request claims a protocol revision the server does not | **400** | `supported` **plus** `requested` | `tests/worker-mcp-dispatch.test.ts#a modern claim of an unsupported protocol version draws the SDK -32022 at HTTP 400`          |

Both carry `data.supported`. Only the SDK's version reject carries `data.requested`, which is the field that tells the
two apart when the status is unavailable. The shell's reject echoes the request id
(`tests/worker-mcp-dispatch.test.ts#MCP_LEGACY_ENABLED=false rejects legacy initialize with -32022 + data.supported at
HTTP 200`) and uses `id: null` for an all-legacy batch
(`tests/worker-mcp-dispatch.test.ts#MCP_LEGACY_ENABLED=false rejects an all-legacy batch at the shell with a null id`);
the SDK's version reject echoes the id
(`tests/worker-mcp-dispatch.test.ts#a modern claim of an unsupported protocol version draws the SDK -32022 at HTTP 400`).

The shell reject is the wire face of the `MCP_LEGACY_ENABLED` kill switch, and it logs `outcome: legacy_rejected` with
`error_code: -32022` (`src/worker/index.ts#outcome: 'legacy_rejected'`, pinned at
`tests/worker-mcp-dispatch.test.ts#MCP_LEGACY_ENABLED=false rejects legacy initialize with -32022 + data.supported at
HTTP 200`). It is deliberately not the rate-limit code: `-32022` and `-32099` are distinct conditions and must stay
distinct in logs.

Like `-32601`, `-32022` reads as lane-unavailable rather than request-invalid
(`src/worker/audit-web/handlers/mcp.ts#LANE_UNAVAILABLE_CODES`).

### `-32099`: rate limit

The shell emits it when `MCP_LIMITER` denies (`src/worker/index.ts#env.MCP_LIMITER.limit`), at HTTP 200 with the request
id echoed. The `mcp.request` log line fires after the gate so denials stay recorded while log volume stays bounded
(`src/worker/index.ts#outcome: 'rate_limited'`).

**A `-32099` inside a tool result is a different thing.** `audit_website` and `score_cli` return their budget refusals
as `CallToolResult` with `isError: true`, carrying a `-32099`-shaped JSON string inside a text content block
(`src/worker/mcp/tools/web-audit.ts#jsonRpcError32099`, `src/worker/mcp/tools/scorecard-audit.ts#jsonRpcError32099`).
The JSON-RPC envelope around it is successful. Pinned at
`tests/worker-mcp-audit.test.ts#missing cf-connecting-ip on cache-miss returns isError: true with -32099` and
`tests/web-audit-mcp-tools.test.ts#missing cf-connecting-ip returns the -32099 envelope (no anon fallback)`. Tool-level
failure and transport-level failure are two layers, and only the second one is in this document's table.

## Responses with no JSON-RPC envelope

Three shell rejections happen before or outside JSON-RPC, so they carry a plain-text body and no envelope. Treating
these as JSON-RPC errors is a common client bug.

| Condition                             | Response                                                        | Verified at                                                                                                                                                                    |
| ------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `MCP_ENABLED` is not `'true'`         | **503**, `Retry-After: 3600`, `text/plain`                      | `tests/worker-mcp-dispatch.test.ts#returns 503 with Retry-After when disabled`; body shape `tests/worker-mcp-dispatch.test.ts#503 body is plain text, NOT a JSON-RPC envelope` |
| Method is not `POST` (`GET` included) | **405**, `Allow: POST`, `text/plain`, `Cache-Control: no-store` | `tests/worker-mcp-dispatch.test.ts#POST /mcp — method gate`; `tests/worker-mcp-dispatch.test.ts#GET /mcp — protocol only`                                                      |
| `Accept` allows neither JSON nor SSE  | **406**, `text/plain`                                           | `tests/worker-mcp-dispatch.test.ts#text/csv returns 406 text/plain with no JSON-RPC envelope`                                                                                  |

The 406 is pre-JSON-RPC by design (`src/worker/index.ts#status: 406`): there is no negotiated type in which to serialize
an envelope, so sending one would answer in a type the caller just refused.

## SEP-2243 header mirror

On the modern lane the request headers restate what the body says, so infrastructure can route and rate-limit without
parsing JSON-RPC. The rules are narrow and the penalty for breaking them is a single code.

- **`MCP-Protocol-Version`** carries the claimed revision. A revision the server does not serve draws `-32022` at HTTP
  400 with `data.supported` and `data.requested`.
- **`Mcp-Method`** must be present and must equal the body's `method` on any request carrying an id. Absent draws
  `-32020` (`the required Mcp-Method header is absent`); disagreeing draws `-32020`
  (`the body names method tools/list but the Mcp-Method header names resources/list`). Both observed; the disagreement
  arm is pinned through its `Mcp-Name` sibling,
  `tests/worker-mcp-dispatch.test.ts#modern resources/read with a non-mirroring Mcp-Name is rejected -32020 at HTTP 400`.
- **`Mcp-Name`** rides the two methods that name a target, and mirrors a different field in each:

| Method           | `Mcp-Name` mirrors | Verified at                                              |
| ---------------- | ------------------ | -------------------------------------------------------- |
| `tools/call`     | `params.name`      | `tests/helpers/mcp-modern.ts#modernToolCallHeaders`      |
| `resources/read` | `params.uri`       | `tests/helpers/mcp-modern.ts#modernResourcesReadHeaders` |

  Absent or disagreeing draws `-32020` at HTTP 400, not a resource miss. This is the trap the header mirror sets for
  probe authors: a `resources/read` probe whose `Mcp-Name` carries the template name rather than the resource URI never
  reaches the resource handler, so it measures the header layer while appearing to measure the miss code
  (`tests/worker-mcp.test.ts#modern resources/read with a non-mirroring Mcp-Name is rejected -32020 (header mismatch)`
  states exactly this, and
  `tests/worker-mcp-dispatch.test.ts#modern resources/read with a mirroring Mcp-Name answers an unknown resource with -32602`
  is the correctly mirrored counterpart that does reach the handler).

The mirror binds requests, not notifications. A notification (no `id` field) without `Mcp-Method` is accepted at HTTP
**202** with an empty body (observed). The shell reads both headers case-insensitively
(`src/worker/mcp/rate-limit.ts#headerMcpName`, `src/worker/mcp/rate-limit.ts#headerMcpMethod`) and uses `Mcp-Name` to
scope modern rate-limit keys to a registered tool or resource-template name
(`src/worker/mcp/rate-limit.ts#buildMcpRateLimitKey`), which is a second reason a spoofed name buys nothing: an
unregistered name falls back to the coarse per-IP bucket
(`tests/worker-mcp-dispatch.test.ts#a spoofed Mcp-Name outside the registered names falls back to modern:{ip}`).

## The modern `_meta` envelope

Every modern request carries `_meta` inside `params`, with three keys:

```json
{
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { "name": "your-client", "version": "0" },
  "io.modelcontextprotocol/clientCapabilities": {}
}
```

Shape verified at `tests/helpers/mcp-modern.ts#modernRequestMeta`, mirrored independently by the auditor at
`src/worker/audit-web/handlers/mcp.ts#modernMeta`.

**`clientCapabilities` is mandatory and an empty object satisfies it.** Omitting the key draws `-32602` at HTTP 400 even
though the other two keys are present, because the envelope is validated as a whole before the method runs. This is the
single easiest way to write a probe that looks like it found a server bug when it found its own
(`tests/worker-mcp.test.ts#tools/call missing clientCapabilities returns -32602 (AE7)`; the auditor's negative probe is
built by dropping exactly this key, the `src/worker/audit-web/handlers/mcp.ts#'modern-clientcaps'` probe).

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

Field-for-field pinned at
`tests/worker-mcp-dispatch.test.ts#a modern claim of an unsupported protocol version draws the SDK -32022 at HTTP 400`.

## Cache hints

Four read methods return `ttlMs` and `cacheScope` alongside the result, declared once as
`src/worker/mcp/server.ts#CACHE_HINTS` and handed to the `McpServer` constructor
(`src/worker/mcp/server.ts#cacheHints: CACHE_HINTS`). All four are one hour and `public`.

`cacheScope` is about who may reuse the answer, not about whether it is secret:

- **`public`** means the answer is caller-neutral. The same request from any caller produces the same result, so a
  shared cache in front of many agents may serve one answer to all of them. anc's catalog is unauthenticated and
  identical for every caller, so every hinted method is `public`.
- **`private`** means the answer is credential-scoped. It varies by who asked, so it may be cached only per caller and
  never in a shared tier.

Pinned on the wire at `tests/worker-mcp.test.ts#tools/list carries cache hints and the full tool surface`
(`ttlMs: 3600000`, `cacheScope: 'public'`), which reads the values out of a live `tools/list` response rather than
asserting the constant.

## GET posture

A streamable-HTTP `GET` opens the server-to-client SSE notification stream. anc is stateless and has nothing to push, so
it does not open that stream. `GET /mcp` and `HEAD /mcp` return **405 Method Not Allowed** for every `Accept` value,
including `text/event-stream`, `text/html`, `text/markdown`, and `application/json`.

The response carries `Allow: POST`, `Link: <…/mcp-docs>; rel="service-doc"` (RFC 8631), `Cache-Control: no-store`,
`CDN-Cache-Control: no-store`, and `Cloudflare-CDN-Cache-Control: no-store`. The body is plain text and names the docs
URL (`/mcp-docs` on the request origin). The 405 is served even when `MCP_ENABLED` is off, so a disabled surface cannot
fall through to a document. The gateway does not enter the cached entrypoint for `/mcp` or `/mcp/`, and the build does
not emit `dist/mcp.html` or `dist/mcp.md`, so a previously cached page has no asset to replay. `PUT`, `DELETE`, and
`PATCH` use the same 405 when the kill switch is on. `OPTIONS` is not handled: it falls through and 404s with no CORS
headers (KTD-10 / R15). `/mcp/` is a 308 to `/mcp` for every other method, so a POST keeps its body and a client
configured with the trailing slash still reaches the server.

The human and agent description of the endpoint is `/mcp-docs` (HTML and markdown negotiation). `/mcp.md` and
`/mcp.html` 301 there. The server card, the AI catalog, and `rel="mcp"` still name `https://anc.dev/mcp` as the server.

`mcp-get-fast-fail` probes `GET` with `Accept: text/event-stream`. A `200` whose content type is not `text/event-stream`
(HTML or markdown included) is broken. A `405`, or a `200` of `text/event-stream`, passes. A held-open hang or a `5xx`
is broken. Remediation says to return 405 or an SSE stream (`src/data/web-audit/remediation.yaml#mcp-get-fast-fail`).
Pinned in `tests/worker-mcp-dispatch.test.ts#GET /mcp — protocol only` and the `mcp-get-fast-fail:` tests in
`tests/web-audit-handlers.test.ts`.

## Codes deliberately not probed

Two codes are excluded from the conformance matrix, recorded above
`src/worker/audit-web/handlers/mcp.ts#CONFORMANCE_PROBES` and under
`src/data/web-audit/registry.yaml#Per-era error-code conformance probes`:

- **`-32603` (internal error)** cannot be forced from outside. A probe that provokes one is measuring a bug it caused,
  not a contract.
- **`-32099` (rate limit)** can be forced, but forcing it against a third-party server is abusive. The auditor treats a
  received `-32099` as an operational condition and excludes the row from scoring rather than penalizing a target for
  defending itself (`src/worker/audit-web/handlers/mcp.ts#RATE_LIMITED_CODE`; pinned at
  `tests/web-audit-handlers.test.ts#a rate-limited refusal is an operational error on every op, never a penalty`). An
  HTTP `408` or `429` answer reads the same way whatever body rides it
  (`src/worker/audit-web/handlers/shared.ts#RETRY_SHAPED_STATUSES`), a `-32000` included, so a busy target never reads
  as a missing modern lane.

A third code appears in probe results without being probed for: **`-32000`**, JSON-RPC's reserved generic server error,
which a stateful legacy server returns to a sessionless POST
(`src/worker/audit-web/handlers/mcp.ts#SESSION_REQUIRED_CODE`). It is a statefulness signal, not an error-taxonomy
signal. anc's own `-32000` is the HTTP 403 Host or Origin rejection in the table above, a different producer behind the
same code.

## Bumping the revision

When the SDK moves to a new revision, work the table rather than the prose:

1. Change `src/worker/mcp/instructions.ts#SPEC_REVISION`. The drift gate makes every other copy of the literal fail
   until it matches (server card, `content/mcp-skill.md`, the handshake).
2. Re-run each row of the error-code table against the new SDK. A major bump can move a status without moving a code,
   which is the failure mode this document exists to catch. The per-lane pins in `tests/worker-mcp-dispatch.test.ts` and
   `tests/worker-mcp.test.ts` are the executable form of the table.
3. Re-verify the four `(observed)` rows first. They have no test holding them still.
4. Update the auditor's accept sets (`src/worker/audit-web/handlers/mcp.ts#CONFORMANCE_PROBES`) only after the
   server-side pins are green, so the audit never scores against an unverified expectation.

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
