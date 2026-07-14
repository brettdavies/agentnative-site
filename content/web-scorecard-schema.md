# Web scorecard schema

A web scorecard is the structured output of the [website agent-readiness audit](/web-audit). It scores a website and its
MCP server across five visible categories with a fairness-driven two-score model: a check that does not apply to a site
is excluded rather than counted against it, and a present-but-broken surface costs more than an absent one. This page
documents every field a web scorecard carries.

The web scorecard is site-owned. Its `schema_version` is **0.2**, independent of the CLI scorecard schema (currently
0.7) and of the [agentnative spec](/principles) `spec_version`. The CLI scorecard schema is documented separately at
[/scorecard-schema](/scorecard-schema).

## Top-level fields

```json
{
  "schema_version": "0.2",
  "spec_version": "...",
  "target_url": "https://example.com/",
  "mcp_endpoint": "https://example.com/mcp",
  "mcp_discovery": [ ... ],
  "tool": { "name": "example.com", "url": "https://example.com/" },
  "audience": null,
  "audit_profile": null,
  "site_type": null,
  "summary": { ... },
  "coverage_summary": { ... },
  "score_pct": 81,
  "score": { "relative": 81, "global": 63 },
  "categories": [ ... ],
  "results": [ ... ]
}
```

| Field              | Type                | Source  | Meaning                                                                                           |
| ------------------ | ------------------- | ------- | ------------------------------------------------------------------------------------------------- |
| `schema_version`   | string              | engine  | Version of the web-scorecard envelope. Site-owned, independent of the CLI schema.                 |
| `spec_version`     | string              | engine  | Version of the agentnative spec the run scored against. Same value the CLI scorecard carries.     |
| `target_url`       | string              | engine  | The normalized audited URL: scheme, host, and a trailing slash. Web-specific.                     |
| `mcp_endpoint`     | string \| null      | engine  | The discovered MCP endpoint, or `null` when none was found. Web-specific.                         |
| `mcp_discovery`    | array               | engine  | The discovery trail: each well-known card or common-path probe attempted, and what it returned.   |
| `tool`             | object              | engine  | Web identity: `{ name, url }`. No `binary`, `install`, `tier`, or `language`. See [tool](#tool).  |
| `audience`         | null                | engine  | Always `null` for web targets; the audience classifier is a CLI concept.                          |
| `audit_profile`    | null                | engine  | Always `null` for web targets; audit profiles are a CLI concept.                                  |
| `site_type`        | string \| null      | engine  | The declared site type the run scoped to: `content`, `api`, or `null` (everything ran).           |
| `summary`          | object              | derived | Tally of check outcomes by status. See [summary](#summary).                                       |
| `coverage_summary` | object              | derived | MUST / SHOULD / MAY totals and how many were verified. See [coverage_summary](#coverage_summary). |
| `score_pct`        | integer             | derived | The headline RELATIVE score, 0-100. Equals `score.relative`. See [scoring](#the-two-score-model). |
| `score`            | object              | derived | The two-score pair `{ relative, global }`. See [scoring](#the-two-score-model).                   |
| `categories`       | array               | derived | Per-category `passed/counted` rollups in display order. See [categories](#categories).            |
| `results`          | array of result obj | engine  | One entry per check. See [results](#results).                                                     |

## `tool`

Web identity. The CLI-only header fields (`tier`, `language`, `repo`, `install`) are absent on a web `tool` object.

```json
"tool": { "name": "example.com", "url": "https://example.com/" }
```

| Field  | Type   | Meaning                                              |
| ------ | ------ | ---------------------------------------------------- |
| `name` | string | The audited domain (host), used as the display name. |
| `url`  | string | The normalized audited URL. Matches `target_url`.    |

## The two-score model

Both scores derive from the same per-check outcomes; the engine computes them and consumers read the values straight
from the JSON.

- **`score.relative`** (the headline, mirrored at top-level `score_pct`) is earned points over the maximum achievable
  for **this site's applicable checks**, so a site perfect for its type approaches 100.
- **`score.global`** is earned points over the maximum of a **maximally agent-ready site** (every check in the
  registry), so exposing and nailing more surfaces ranks higher. The [web leaderboard](/web) sorts by it.

Per applicable check, with per-tier difficulty weights (currently 5 for MUST, 3 for SHOULD, 1 for MAY):

- `pass` earns the full weight.
- `broken` (present but invalid) costs 0.75 x weight at every tier: a malformed surface misleads agents, so it is worse
  than absence.
- An absent MUST is a full-weight zero; an absent SHOULD is a zero that occupies only half its weight in the relative
  denominator; an absent MAY is `n_a` (truly optional, never counted).
- `n_a`, `skip`, and `error` rows are excluded from both scores. Both scores floor at 0.

## `categories`

Per-category rollups in the fixed display order. `counted` excludes `n_a` / `skip` / `error` rows, so a category with
nothing applicable reads `0/0`.

```json
"categories": [
  { "id": "discoverability", "name": "Discoverability", "passed": 4, "counted": 5 },
  { "id": "content-for-agents", "name": "Content for agents", "passed": 7, "counted": 8 },
  { "id": "bot-crawl-policy", "name": "Bot & crawl policy", "passed": 3, "counted": 3 },
  { "id": "mcp-api", "name": "MCP & API", "passed": 6, "counted": 9 },
  { "id": "agent-discovery-auth", "name": "Agent discovery & auth", "passed": 3, "counted": 3 }
]
```

## `coverage_summary`

How many checks applied at each keyword level and how many passed. `n_a` / `skip` / `error` checks are excluded from the
totals.

```json
"coverage_summary": {
  "must":   { "total": 2,  "verified": 2 },
  "should": { "total": 15, "verified": 9 },
  "may":    { "total": 10, "verified": 7 }
}
```

## `summary`

A tally of every check by its final status.

```json
"summary": { "pass": 23, "broken": 2, "absent": 4, "n_a": 7, "skip": 0, "error": 0 }
```

## `results`

One object per check.

```json
{
  "id": "llms-txt",
  "label": "/llms.txt present with a summary and link index",
  "category": "content-for-agents",
  "group": "P2",
  "layer": "web",
  "keyword": "should",
  "tier": "recommended",
  "principle": "P2",
  "status": "pass",
  "evidence": "https://example.com/llms.txt -> 200"
}
```

| Field       | Type           | Meaning                                                                                                                                          |
| ----------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`        | string         | The check id from the registry (e.g. `llms-txt`, `mcp-initialize`). The remediation-catalog and fix-skill key.                                   |
| `label`     | string         | Human-readable check title.                                                                                                                      |
| `category`  | string         | The visible category slug (one of the `categories[].id` values). Drives the display grouping.                                                    |
| `group`     | string         | Mirrors `principle` for shared-renderer compatibility.                                                                                           |
| `layer`     | string         | Always `web` for a web scorecard row.                                                                                                            |
| `keyword`   | string         | `must`, `should`, or `may`, derived from the check's tier.                                                                                       |
| `tier`      | string         | `required`, `recommended`, or `optional` (the keyword's source).                                                                                 |
| `principle` | string         | Internal principle tag `P1` through `P8`. Kept as data; web surfaces neither display nor link it.                                                |
| `status`    | string         | `pass`, `broken`, `absent`, `n_a`, `skip`, or `error`. `broken` = present but invalid; `absent` = not there. See [statuses](#statuses).          |
| `na_reason` | string         | Present only on `n_a` rows: `antecedent-unmet` (the check does not apply to this site) or `optional-absent` (an applicable MAY not implemented). |
| `evidence`  | string \| null | A compact human-readable summary of what the probe observed.                                                                                     |

### Statuses

- `pass` — the surface is present and valid.
- `broken` — the surface exists but is invalid (malformed body, wrong content-type, an unexpected status where the
  surface clearly exists). Scores below absent.
- `absent` — the surface is not there (404/410, no DNS records, no CORS headers).
- `n_a` — excluded from both scores; `na_reason` says why (`antecedent-unmet` vs `optional-absent`).
- `skip` — the per-audit deadline passed before the check ran.
- `error` — an operational failure (network error, timeout); never credited, never penalized.

## Remediation on the MCP surface

Scorecard rows carry no remediation; the fix guidance is assembled at read time. The `audit_website` MCP tool returns
each row with a derived `result` line, and non-passing (`broken` / `absent`) rows additionally carry an inline
`remediation` object:

```json
"remediation": {
  "goal": "Publish an OpenAPI description so non-MCP agents can call your API",
  "fix": "Publish an OpenAPI 3.1 description at /openapi.json ...",
  "skill_url": "https://anc.dev/web-audit/skill/openapi",
  "resources": [{ "label": "OpenAPI 3.1", "url": "https://spec.openapis.org/oas/latest.html" }],
  "prompt": "Goal: ...\nIssue: <this run's evidence>\nFix: ...\nSkill: ...\nDocs: ..."
}
```

The same object is available by check id from `get_web_remediation(check_id, evidence?)`, and each `skill_url` resolves
to a fix-skill page with a markdown twin.

## Evidence by probe type

Each check runs one of the probe handlers. The compact `results[].evidence` string is derived from the handler's
structured evidence, which differs by handler:

- **http** — the resolved URL, the HTTP status, whether the assertion passed, and the failing reason when it did not.
  The canonical-redirect rule (the MCP server card) additionally records a per-alias verdict.
- **cors-preflight** — the URL, status, and the `Access-Control-Allow-Origin` / `-Methods` / `-Headers` values.
- **mcp** — the endpoint, status, and the op-specific facts: `serverInfo` and `protocolVersion` for `initialize`, the
  tool names and input-schema count for `tools-list`, the error code for the unknown-method probe, or the
  `Access-Control-Allow-Origin` for the CORS assertion.
- **dns-doh** — the queried name, the resolver, the DNS status code, and the answer count.
- **auth-md / webmcp / scoped-llms** — the probed URLs (or root-HTML markers) and per-candidate outcomes.

## Relationship to the CLI scorecard and the spec

The web scorecard is intentionally site-owned and not part of the [agentnative spec](/principles). Formalizing the web
shape into the spec is deferred until a second consumer exists. Until then, this page is the one published contract for
the web scorecard JSON. The parallel CLI contract is [/scorecard-schema](/scorecard-schema).
