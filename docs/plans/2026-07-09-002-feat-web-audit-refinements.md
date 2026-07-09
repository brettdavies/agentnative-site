---
title: "feat: Web-audit refinements — standalone display, site-type applicability, CF-style remediation"
date: 2026-07-09
type: feat
status: proposed
supersedes-parts-of: docs/plans/2026-07-09-001-feat-web-audit-integration-plan.md
---

Proposed design for the web-audit refinements. Everything here is PROPOSED — redline any cell. It reshapes the display,
scoring, applicability, and remediation of the web audit shipped by plan 2026-07-09-001; the engine, cache, route, and
MCP plumbing are unchanged except where noted.

## Decisions locked (from the design chat)

- **Redirects, not content aliases.** `/.well-known/mcp` and `/.well-known/mcp.json`, plus `GET /mcp` with `Accept:
  application/json`, `301` to the canonical `/.well-known/mcp/server-card.json`. `POST /mcp` (JSON-RPC) and `GET /mcp`
  with `Accept: text/html`/`text/markdown` are unchanged.
- **No badge.** Drop the `badge` object. Score lives at top-level `score_pct`, plus per-category rollups.
- **`n/a` = site-type default + antecedents.** A declared site type sets baseline applicability; per-check antecedents
  can still flip a check to `n/a`.
- **Display is standalone from the principles.** Group and label by CF-style **category**; keep `principle: P1..P8` as a
  hidden per-check tag only (kept and revisited, never shown or linked in the web audit).
- **CF-style remediation.** Per check: Goal / Result / Fix / Resources (human Docs links + an agent Skill link) and a
  copy-paste **prompt** block (`Goal / Issue / Fix / Skill / Docs`). Remediation text is returned inline in MCP.
- **Skills live at content URLs; `.well-known` holds only a directory of pointers.**

## Score + display model

- **`score_pct`** (top-level int): credit-weighted. A check enters the denominator (at its `weight`) when it is MUST or
  SHOULD and resolved `pass`/`fail`, OR it is MAY and the resource is **present** (`pass` or `fail`). Passes add their
  weight to the numerator. Excluded from both: `n/a`, `skip`, `error`, and MAY checks whose resource is **absent**.
- **MAY is tri-state, not merely informational** (per the design chat): a MAY that is **absent** has null impact (like
  `n/a` — off the score, off group completion); a MAY that is **present + valid** counts as `pass` and *helps* the
  score; a MAY that is **present + invalid** counts as `fail` and *harms* it. Rationale: a broken optional surface (a
  malformed A2A card, an `llms.txt` with dead links) actively misleads agents, so it should cost more than an absent
  one, while never punishing a site for simply not adopting an optional standard.
- **Engine consequence**: for MAY checks the engine must distinguish **absent** (every candidate 404s / DNS NXDOMAIN —
  the status assertion itself fails) from **present-but-invalid** (a candidate returns 200 but a later content/schema
  assertion fails). MUST/SHOULD keep today's binary pass/fail (absence is a fail — you were expected to ship it).
- **Per-category rollups**: each visible category shows `passed / counted` (CF's `4/4`), where `counted` is the
  denominator above — a correctly-absent MAY is not in it; a present MAY (valid or invalid) is.
- **No global grade/level** by default. (CF shows "Level 5 / Agent-Native"; we can add a named tier later if wanted —
  flagged open.)
- **Per check on the page**: **Goal** (always) · **Result** (always, human line derived from status+evidence) · **Fix**
  (only when not passing) · **Resources** (Docs links + a Skill link) · a **copy-paste prompt** with a copy button.

## Visible categories (the display grouping)

Mapped from the existing internal `category` field. Redline names/membership freely.

| Category               | Checks                                                                                                                                                                                               |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Discoverability        | robots, sitemap, link-headers, root-link-rel, dns-aid                                                                                                                                                |
| Content for agents     | llms-txt, llms-full-txt, accept-markdown, root-meta-description, schema-org-jsonld, semantic-html, noscript-fallback                                                                                 |
| Bot & crawl policy     | robots-ai-rules, content-signals, web-bot-auth, security-txt                                                                                                                                         |
| MCP & API              | well-known-mcp-card, mcp-usage-doc, mcp-initialize, mcp-capabilities, mcp-tools-list, mcp-unknown-method, mcp-get-fast-fail, mcp-cors-preflight, mcp-cors-actual, openapi, json-schemas, api-catalog |
| Agent discovery & auth | a2a-agent-card, agent-skills, oauth-discovery, oauth-protected-resource                                                                                                                              |

## Site types + applicability

Declared site type (default: **run everything**); MCP presence is auto-detected from discovery, so the MCP surface is
always evaluated when found regardless of declared type.

| Site type       | Intent                                            |
| --------------- | ------------------------------------------------- |
| Content         | Blog / docs / marketing; no API or app surface    |
| API/Application | Ships a REST API and/or an interactive app        |
| MCP server      | Publishes an MCP server (also auto-detected)      |
| Commerce        | Agentic-commerce surface (future; see Open items) |

A check that doesn't apply to the declared site type is `n/a` (excluded from score), shown as informational.

## Conditional rules (reusable types)

1. **canonical-plus-redirect-aliases.** The canonical path is the requirement; alias paths satisfy it ONLY as `301`
   redirects to the canonical. An alias serving `200` content with no canonical is a **fail** (ambiguous/duplicate); a
   missing canonical is a **fail**. Applies to: the MCP server card (canonical `/.well-known/mcp/server-card.json`;
   aliases `/.well-known/mcp`, `/.well-known/mcp.json`, `GET /mcp` json).
2. **antecedent-gated → n/a.** A check is `n/a` unless its antecedent holds. E.g. `oauth-protected-resource` is `n/a`
   unless an MCP endpoint is discovered; `mcp-*` are `n/a` unless an MCP endpoint is discovered (already implemented);
   `llms-full-txt` is `n/a` unless the site is a docs/content site.
3. **informational-by-site-type.** The check runs and is displayed but does not affect the score when the site type
   doesn't match (CF's commerce treatment). E.g. commerce checks on a non-commerce site.

## The check matrix (PROPOSED — redline any row)

Tier philosophy: **MUST = "if you ship this surface, it must work"** (so MUSTs are antecedent-gated, not universal);
SHOULD = expected for an agent-ready site of that type; **MAY = adopt-if-you-can — absent is neutral, present-and-valid
helps, present-and-broken harms** (tri-state, per the score model above). `Principle` is the hidden internal tag
(revised from plan 001).

| Check                    | Category               | Principle | Tier   | Applies to (site types) | Conditional / antecedent                                              |
| ------------------------ | ---------------------- | --------- | ------ | ----------------------- | --------------------------------------------------------------------- |
| mcp-initialize           | MCP & API              | P2        | MUST   | MCP                     | antecedent: MCP endpoint discovered                                   |
| mcp-tools-list           | MCP & API              | P2        | MUST   | MCP                     | antecedent: MCP endpoint discovered                                   |
| mcp-capabilities         | MCP & API              | P2        | SHOULD | MCP                     | antecedent: MCP endpoint discovered                                   |
| mcp-unknown-method       | MCP & API              | P4        | SHOULD | MCP                     | antecedent: MCP endpoint discovered                                   |
| mcp-get-fast-fail        | MCP & API              | P4        | SHOULD | MCP                     | antecedent: MCP endpoint discovered                                   |
| mcp-cors-preflight       | MCP & API              | P6        | SHOULD | MCP                     | antecedent: MCP endpoint; browser-origin support optional             |
| mcp-cors-actual          | MCP & API              | P6        | SHOULD | MCP                     | antecedent: MCP endpoint; browser-origin support optional             |
| well-known-mcp-card      | MCP & API              | P8        | SHOULD | MCP                     | canonical-plus-redirect-aliases                                       |
| mcp-usage-doc            | MCP & API              | P8        | MAY    | MCP                     | antecedent: MCP endpoint discovered                                   |
| openapi                  | MCP & API              | P2        | MUST   | API/Application         | antecedent: API surface (declared or detected); n/a otherwise         |
| json-schemas             | MCP & API              | P2        | MAY    | API/Application         | antecedent: OpenAPI or schemas referenced                             |
| api-catalog              | MCP & API              | P8        | MAY    | API/Application         | informational on Content                                              |
| llms-txt                 | Content for agents     | P2        | SHOULD | all                     | none                                                                  |
| llms-full-txt            | Content for agents     | P2        | MAY    | Content                 | n/a unless docs/content site                                          |
| llms-txt-scoped          | Content for agents     | P2        | MAY    | Content                 | antecedent: root /llms.txt present; checks discovered subdir llms.txt |
| llms-full-txt-scoped     | Content for agents     | P2        | MAY    | Content                 | antecedent: root /llms-full.txt present                               |
| accept-markdown          | Content for agents     | P2        | SHOULD | all                     | none                                                                  |
| root-meta-description    | Content for agents     | P3        | SHOULD | all                     | n/a if root is not HTML                                               |
| schema-org-jsonld        | Content for agents     | P2        | MAY    | all                     | n/a if root is not HTML                                               |
| semantic-html            | Content for agents     | P3        | MAY    | all                     | n/a if root is not HTML                                               |
| noscript-fallback        | Content for agents     | P1        | SHOULD | all                     | n/a if root is not HTML                                               |
| robots                   | Discoverability        | P7        | SHOULD | all                     | none                                                                  |
| sitemap                  | Discoverability        | P7        | MAY    | all                     | none                                                                  |
| link-headers             | Discoverability        | P3        | SHOULD | all                     | n/a if root is not HTTP-fetchable                                     |
| root-link-rel            | Discoverability        | P3        | SHOULD | all                     | n/a if root is not HTML                                               |
| dns-aid                  | Discoverability        | P8        | MAY    | all                     | none                                                                  |
| robots-ai-rules          | Bot & crawl policy     | P7        | SHOULD | all                     | none                                                                  |
| content-signals          | Bot & crawl policy     | P7        | SHOULD | all                     | none                                                                  |
| web-bot-auth             | Bot & crawl policy     | P6        | MAY    | all                     | informational (only sites sending bot traffic)                        |
| security-txt             | Bot & crawl policy     | P4        | MAY    | all                     | none                                                                  |
| a2a-agent-card           | Agent discovery & auth | P8        | MAY    | all                     | informational                                                         |
| agent-skills             | Agent discovery & auth | P8        | MAY    | all                     | none                                                                  |
| oauth-discovery          | Agent discovery & auth | P1        | MAY    | API/Application, MCP    | antecedent: authenticated surface present                             |
| oauth-protected-resource | Agent discovery & auth | P1        | MAY    | MCP                     | antecedent: MCP endpoint that requires auth                           |

**Candidate additions from the CF set (not in our 32; decide per row):** `auth-md` (Auth.md metadata), `webmcp` (browser
WebMCP tools), and the Commerce set (`x402`, `mpp`, `ucp`, `acp`) as an informational Commerce category.

## Remediation format

`src/data/web-audit/remediation.yaml` per check (drops the MCP-shape-only `{{evidence}}` template — the run's evidence
becomes the uniform `Issue:` line for every check):

```yaml
mcp-server-card:
  title: MCP Server Card published
  goal: Publish an MCP Server Card for agent discovery
  fix: |
    Serve an MCP Server Card (SEP-1649) at /.well-known/mcp/server-card.json with serverInfo (name, version),
    transport endpoint, and capabilities.
  resources:
    - { label: SEP-1649, url: "https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2127" }
```

Rendered at audit time, per non-passing check, the copy-paste prompt is assembled from the static fields + the run's
evidence:

```text
Goal: <goal>
Issue: <the run's evidence for this check>
Fix: <fix>
Skill: https://anc.dev/web-audit/skill/<check-id>
Docs: <resources[].url, comma-separated>
```

The **Result** line (shown always) is derived from status + evidence: a `pass` reads as the affirmative finding, a
`fail` as the negative. Bespoke result copy can be added per check later. The same prompt + Resources render on the
result page (copy button) and return inline in `audit_website` results and `get_web_remediation`.

## Worked example: one check across every surface

The same failing check (`openapi`, MUST on an API site; anc.dev has none) as it renders on the web result page and as it
returns from both MCP tools. The `remediation` object (goal / fix / skill_url / resources / prompt) is identical across
all three; only the envelope differs.

### Web result page (rendered)

```text
openapi — FAIL                                        [MCP & API]
Goal    Publish an OpenAPI description so non-MCP agents can call your API
Result  No OpenAPI document found — /openapi.json, /openapi.yaml, /.well-known/openapi.json all returned 404
Fix     Publish an OpenAPI 3.1 description at /openapi.json covering your REST surface (endpoints, params, schemas).
Resources   OpenAPI 3.1 ↗   ·   Skill ↗ (/web-audit/skill/openapi)
[ Copy prompt ]
  Goal: Publish an OpenAPI description so non-MCP agents can call your API
  Issue: No OpenAPI document found — /openapi.json, /openapi.yaml, /.well-known/openapi.json all returned 404
  Fix: Publish an OpenAPI 3.1 description at /openapi.json covering your REST surface (endpoints, params, schemas).
  Skill: https://anc.dev/web-audit/skill/openapi
  Docs: https://spec.openapis.org/oas/latest.html
```

### MCP `audit_website` — the `results[]` row (remediation embedded inline)

```json
{
  "id": "openapi",
  "category": "MCP & API",
  "tier": "must",
  "status": "fail",
  "result": "No OpenAPI document found — /openapi.json, /openapi.yaml, /.well-known/openapi.json all returned 404",
  "evidence": "https://anc.dev/openapi.json -> 404 (status 404 not in [200])",
  "remediation": {
    "goal": "Publish an OpenAPI description so non-MCP agents can call your API",
    "fix": "Publish an OpenAPI 3.1 description at /openapi.json covering your REST surface (endpoints, params, schemas).",
    "skill_url": "https://anc.dev/web-audit/skill/openapi",
    "resources": [{ "label": "OpenAPI 3.1", "url": "https://spec.openapis.org/oas/latest.html" }],
    "prompt": "Goal: Publish an OpenAPI description so non-MCP agents can call your API\nIssue: No OpenAPI document found — /openapi.json, /openapi.yaml, /.well-known/openapi.json all returned 404\nFix: Publish an OpenAPI 3.1 description at /openapi.json covering your REST surface (endpoints, params, schemas).\nSkill: https://anc.dev/web-audit/skill/openapi\nDocs: https://spec.openapis.org/oas/latest.html"
  }
}
```

Passing rows carry `status: "pass"`, a `result` line, and **no** `remediation` object (nothing to fix). A MAY that is
absent carries `status: "n_a"` and no remediation; a MAY that is present-but-invalid carries `status: "fail"` plus the
remediation, same as above.

### MCP `get_web_remediation("openapi", evidence?)`

```json
{
  "found": true,
  "remediation": {
    "check_id": "openapi",
    "title": "OpenAPI description published",
    "goal": "Publish an OpenAPI description so non-MCP agents can call your API",
    "fix": "Publish an OpenAPI 3.1 description at /openapi.json covering your REST surface (endpoints, params, schemas).",
    "skill_url": "https://anc.dev/web-audit/skill/openapi",
    "resources": [{ "label": "OpenAPI 3.1", "url": "https://spec.openapis.org/oas/latest.html" }],
    "prompt": "Goal: ...\nIssue: <evidence arg, or a generic 'not implemented' line when omitted>\nFix: ...\nSkill: ...\nDocs: ..."
  }
}
```

`get_web_remediation` returns the static remediation for any check by id; when the caller passes the run's `evidence`,
the `Issue:` line in `prompt` uses it (otherwise a generic line). `audit_website` always fills `Issue:` from the live
evidence.

## Skills + `.well-known`

- Per-check skill docs served at **content URLs**: `/web-audit/skill/<check-id>` + a `.md` twin (the `Skill:` link
  target). Prose lives here, not under `.well-known`.
- The only `.well-known` artifact is a **directory of pointers**: extend the existing
  `/.well-known/agent-skills/index.json` (`skills[]` of `{name, url, type}`) to list every web-audit fix skill, each
  `url` targeting its content-URL doc. Optionally add a human-readable `index.md` alongside.

## Redirects

- `/.well-known/mcp` → `301` `/.well-known/mcp/server-card.json`
- `/.well-known/mcp.json` → `301` `/.well-known/mcp/server-card.json`
- `GET /mcp` + `Accept: application/json` → `301` `/.well-known/mcp/server-card.json`
- `POST /mcp` (JSON-RPC) and `GET /mcp` + `Accept: text/html`/`text/markdown`: unchanged.
- The root alias `/mcp.json` is dropped (or also `301`s) — decide.

## Open items to confirm

- Category names + membership (the two tables above).
- Site-type set; whether to add the Commerce category and the CF candidate checks (`auth-md`, `webmcp`, `x402`, `mpp`,
  `ucp`, `acp`).
- Whether to add a named overall tier/level (CF's "Level 5 / Agent-Native").
- Whether `.well-known/agent-skills/` also gets a human-readable `index.md`.
- Drop vs `301` for the root `/mcp.json` alias.
- **API-surface detection** for the `openapi` MUST antecedent: how the engine decides a site "has an API" when the site
  type isn't declared (candidates: declared `API/Application` type, presence of `/api/*`, an `openapi`/`swagger`
  reference in HTML, or a `service-desc` link). Under-detection makes `openapi` `n/a`; over-detection turns a MUST fail
  on a content site.
- **Scoped `llms.txt` discovery**: how the engine enumerates subdir candidates for `llms-txt-scoped` (from the root
  `llms.txt` link index, from sitemap top-level paths, or a bounded heuristic set), and the per-audit subrequest budget
  that implies.
