# Web scorecard schema

A web scorecard is the structured output of the [website agent-readiness audit](/web-audit). It scores a website and its
MCP server against the same eight principles as the CLI scorecard, so the two shapes are deliberately parallel: a web
scorecard renders through the same presentation and reuses the shared `badge` / `results` / `coverage_summary` /
`summary` blocks. This page documents every field a web scorecard carries.

The web scorecard is site-owned. Its `schema_version` starts at **0.1**, independent of the CLI scorecard schema
(currently 0.7) and of the [agentnative spec](/principles) `spec_version`. The CLI scorecard schema is documented
separately at [/scorecard-schema](/scorecard-schema).

## Top-level fields

```json
{
  "schema_version": "0.1",
  "spec_version": "...",
  "target_url": "https://example.com/",
  "mcp_endpoint": "https://example.com/mcp",
  "mcp_discovery": [ ... ],
  "tool": { "name": "example.com", "url": "https://example.com/" },
  "audience": null,
  "audit_profile": null,
  "summary": { ... },
  "coverage_summary": { ... },
  "badge": { "score_pct": 0, "eligible": false },
  "results": [ ... ]
}
```

| Field              | Type                | Source  | Meaning                                                                                             |
| ------------------ | ------------------- | ------- | --------------------------------------------------------------------------------------------------- |
| `schema_version`   | string              | engine  | Version of the web-scorecard envelope. Site-owned; starts at 0.1, independent of the CLI schema.    |
| `spec_version`     | string              | engine  | Version of the agentnative spec the run scored against. Same value the CLI scorecard carries.       |
| `target_url`       | string              | engine  | The normalized audited URL: scheme, host, and a trailing slash. Web-specific.                       |
| `mcp_endpoint`     | string \| null      | engine  | The discovered MCP endpoint, or `null` when none was found. Web-specific.                           |
| `mcp_discovery`    | array               | engine  | The discovery trail: each well-known card or common-path probe attempted, and what it returned.     |
| `tool`             | object              | engine  | Web identity: `{ name, url }`. No `binary`, `install`, `tier`, or `language`. See [tool](#tool).    |
| `audience`         | null                | engine  | Always `null` for web targets; the audience classifier is a CLI concept.                            |
| `audit_profile`    | null                | engine  | Always `null` for web targets; audit profiles are a CLI concept.                                    |
| `summary`          | object              | derived | Tally of check outcomes by status. See [summary](#summary).                                         |
| `coverage_summary` | object              | derived | MUST / SHOULD / MAY totals and how many were verified. See [coverage_summary](#coverage_summary).   |
| `badge`            | object              | derived | `score_pct` and `eligible`. Web results carry no embeddable badge, so `eligible` is always `false`. |
| `results`          | array of result obj | engine  | One entry per check. See [results](#results).                                                       |

## `tool`

Web identity. The shared renderer emits only the URL link because the CLI-only header fields (`tier`, `language`,
`repo`, `install`) are absent on a web `tool` object.

```json
"tool": { "name": "example.com", "url": "https://example.com/" }
```

| Field  | Type   | Meaning                                              |
| ------ | ------ | ---------------------------------------------------- |
| `name` | string | The audited domain (host), used as the display name. |
| `url`  | string | The normalized audited URL. Matches `target_url`.    |

## `badge`

```json
"badge": { "score_pct": 67, "eligible": false }
```

| Field       | Type    | Meaning                                                                                               |
| ----------- | ------- | ----------------------------------------------------------------------------------------------------- |
| `score_pct` | integer | The credit-weighted score, 0-100. Computed by the engine (see [scoring](#how-score_pct-is-computed)). |
| `eligible`  | boolean | Always `false`: web audits produce no embeddable badge.                                               |

### How `score_pct` is computed

The web engine computes `score_pct` itself; the shared presentation reads the value straight from the JSON and never
recomputes it. The formula is site-owned and credit-weighted:

- Only checks whose keyword is **MUST** or **SHOULD** and whose status is a clean `pass` or `fail` count. Checks that
  are `n_a`, `skip`, or `error` are excluded from both the numerator and the denominator.
- **MAY** checks are informational only. They never move the score.
- Each counting check contributes its registry `weight` to the denominator; a `pass` contributes its `weight` to the
  numerator.
- `score_pct = round(100 * sum(weight of MUST/SHOULD passes) / sum(weight of applicable MUST/SHOULD checks))`, or `0`
  when nothing is applicable.

This is new site code, not a port of the source skill's A-F grade. The per-principle rollup shown on the page (how many
of the eight principles have every check passing) reuses the shared `computePrincipleScore`.

## `coverage_summary`

How many checks applied at each keyword level and how many passed. `n_a` / `skip` / `error` checks are excluded from the
totals.

```json
"coverage_summary": {
  "must":   { "total": 2,  "verified": 2 },
  "should": { "total": 15, "verified": 9 },
  "may":    { "total": 15, "verified": 12 }
}
```

## `summary`

A tally of every check by its final status.

```json
"summary": { "pass": 21, "fail": 8, "n_a": 3, "skip": 0, "error": 0 }
```

## `results`

One object per check.

```json
{
  "id": "llms-txt",
  "label": "/llms.txt present with a summary and link index",
  "group": "P2",
  "layer": "web",
  "keyword": "should",
  "status": "pass",
  "evidence": "https://example.com/llms.txt -> 200"
}
```

| Field      | Type           | Meaning                                                                                          |
| ---------- | -------------- | ------------------------------------------------------------------------------------------------ |
| `id`       | string         | The check id from the registry (e.g. `llms-txt`, `mcp-initialize`). The remediation-catalog key. |
| `label`    | string         | Human-readable check title.                                                                      |
| `group`    | string         | Principle group `P1` through `P8`. Drives the principle grouping and the principles-met count.   |
| `layer`    | string         | Always `web` for a web scorecard row.                                                            |
| `keyword`  | string         | `must`, `should`, or `may`, derived from the check's tier.                                       |
| `status`   | string         | `pass`, `fail`, `n_a`, `skip`, or `error`. MCP-shape checks are `n_a` when no endpoint is found. |
| `evidence` | string \| null | A compact human-readable summary of what the probe observed.                                     |

## Evidence by probe type

Each check runs one of four probe handlers. The compact `results[].evidence` string is derived from the handler's
structured evidence, which differs by handler:

- **http** — the resolved URL, the HTTP status, whether the assertion passed, and the failing reason when it did not.
- **cors-preflight** — the URL, status, and the `Access-Control-Allow-Origin` / `-Methods` / `-Headers` values.
- **mcp** — the endpoint, status, and the op-specific facts: `serverInfo` and `protocolVersion` for `initialize`, the
  tool names and input-schema count for `tools-list`, the error code for the unknown-method probe, or the
  `Access-Control-Allow-Origin` for the CORS assertion.
- **dns-doh** — the queried name, the resolver, the DNS status code, and the answer count.

## Relationship to the CLI scorecard and the spec

The web scorecard is intentionally site-owned and not part of the [agentnative spec](/principles). Formalizing the web
shape into the spec is deferred until a second consumer exists. Until then, this page is the one published contract for
the web scorecard JSON. The parallel CLI contract is [/scorecard-schema](/scorecard-schema).
