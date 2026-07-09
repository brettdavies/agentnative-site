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

Mirror the binary (`anc`) scoring so the web audit and the CLI audit read the same. Per methodology "How a score is
computed": the denominator is every audit with status `pass`/`warn`/`fail`/`opt_out`; a `pass` earns 1.0, a `warn` 0.5,
a `fail`/`opt_out` 0.0; `n_a` / `skip` / `error` drop out of both.

```text
score = round(100 * (pass + 0.5*warn) / (pass + warn + fail + opt_out))
```

The tier sets the severity of a **miss**, not the credit of a hit: a met requirement of any tier is a full-credit
`pass`.

| Tier   | Met (present + valid) | Not met (absent or broken) |
| ------ | --------------------- | -------------------------- |
| MUST   | pass (1.0)            | fail (0.0)                 |
| SHOULD | pass (1.0)            | warn (0.5)                 |
| MAY    | pass (1.0)            | warn (0.5)                 |

Plus `n_a` when the antecedent is absent (excluded from numerator and denominator). This reuses the shared scorer with
no bespoke math, and is the proposed default.

It drops two ideas from earlier in this chat, now flagged as opt-in deviations (see Open items):

- **MAY-absent as `n_a`** (truly optional, excluded) instead of `warn` (0.5). The binary counts a missed applicable MAY
  as `warn`, so skipping it costs half a slot; the deviation makes skipping a MAY free.
- **Broken harder than absent** — split "present-but-invalid" into a `fail` even for SHOULD/MAY. The binary scores a
  broken SHOULD/MAY the same as a missing one (`warn`); the deviation says a malformed surface that misleads agents
  should cost more than an absent one.

- **Engine's job**: map each applicable check to `pass` / `warn` / `fail` / `n_a`. The absent-vs-present-but-invalid
  distinction is only needed if the second deviation is adopted; the binary model does not require it.
- **Per-category rollups**: each visible category shows `met / counted` (CF's `4/4`), where `counted` is the denominator
  (applicable, non-`n_a` checks).
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

`Tier` is the RFC 2119 obligation = the severity of a **miss** (per the binary scoring above): a met requirement of any
tier is a full-credit `pass`; a missed `MUST` is a `fail`, a missed `SHOULD`/`MAY` is a `warn`; `n_a` when the
antecedent is absent. "Miss" covers both absent and present-but-broken unless a scoring deviation is adopted (Open
items). `Principle` is the hidden internal tag (revised from plan 001).

`Site types` is the declared-type filter (which types run the check by default); `Antecedent` is the runtime gate that
can still flip it to `n/a` (resolution in the next table); `Eval` flags a non-standard evaluation rule.

| Check                    | Category               | Principle | Tier   | Site types           | Antecedent         | Eval               |
| ------------------------ | ---------------------- | --------- | ------ | -------------------- | ------------------ | ------------------ |
| mcp-initialize           | MCP & API              | P2        | MUST   | MCP                  | mcp-present        | -                  |
| mcp-tools-list           | MCP & API              | P2        | MUST   | MCP                  | mcp-present        | -                  |
| mcp-capabilities         | MCP & API              | P2        | SHOULD | MCP                  | mcp-present        | -                  |
| mcp-unknown-method       | MCP & API              | P4        | SHOULD | MCP                  | mcp-present        | -                  |
| mcp-get-fast-fail        | MCP & API              | P4        | SHOULD | MCP                  | mcp-present        | -                  |
| mcp-cors-preflight       | MCP & API              | P6        | SHOULD | MCP                  | mcp-present        | -                  |
| mcp-cors-actual          | MCP & API              | P6        | SHOULD | MCP                  | mcp-present        | -                  |
| well-known-mcp-card      | MCP & API              | P8        | SHOULD | MCP                  | mcp-present        | canonical+redirect |
| mcp-usage-doc            | MCP & API              | P8        | MAY    | MCP                  | mcp-present        | -                  |
| openapi                  | MCP & API              | P2        | MUST   | API/Application      | api-surface        | -                  |
| json-schemas             | MCP & API              | P2        | MAY    | API/Application      | schemas-ref        | -                  |
| api-catalog              | MCP & API              | P8        | MAY    | API/Application      | api-surface        | -                  |
| llms-txt                 | Content for agents     | P2        | SHOULD | all                  | none               | -                  |
| llms-full-txt            | Content for agents     | P2        | MAY    | Content              | docs-site          | -                  |
| llms-txt-scoped          | Content for agents     | P2        | MAY    | Content              | root-llms-txt      | scoped-discovery   |
| llms-full-txt-scoped     | Content for agents     | P2        | MAY    | Content              | root-llms-full-txt | -                  |
| accept-markdown          | Content for agents     | P2        | SHOULD | all                  | html-root          | -                  |
| root-meta-description    | Content for agents     | P3        | SHOULD | all                  | html-root          | -                  |
| schema-org-jsonld        | Content for agents     | P2        | MAY    | all                  | html-root          | -                  |
| semantic-html            | Content for agents     | P3        | MAY    | all                  | html-root          | -                  |
| noscript-fallback        | Content for agents     | P1        | SHOULD | all                  | html-root          | -                  |
| robots                   | Discoverability        | P7        | SHOULD | all                  | none               | -                  |
| sitemap                  | Discoverability        | P7        | MAY    | all                  | none               | -                  |
| link-headers             | Discoverability        | P3        | SHOULD | all                  | http-root          | -                  |
| root-link-rel            | Discoverability        | P3        | SHOULD | all                  | html-root          | -                  |
| dns-aid                  | Discoverability        | P8        | MAY    | all                  | none               | -                  |
| robots-ai-rules          | Bot & crawl policy     | P7        | SHOULD | all                  | robots-present     | -                  |
| content-signals          | Bot & crawl policy     | P7        | SHOULD | all                  | robots-present     | -                  |
| web-bot-auth             | Bot & crawl policy     | P6        | MAY    | all                  | none               | -                  |
| security-txt             | Bot & crawl policy     | P4        | MAY    | all                  | none               | -                  |
| a2a-agent-card           | Agent discovery & auth | P8        | MAY    | all                  | none               | -                  |
| agent-skills             | Agent discovery & auth | P8        | MAY    | all                  | none               | -                  |
| oauth-discovery          | Agent discovery & auth | P1        | MAY    | API/Application, MCP | auth-present       | -                  |
| oauth-protected-resource | Agent discovery & auth | P1        | MAY    | MCP                  | mcp-auth           | -                  |

### Antecedent resolution

How the engine resolves each antecedent token. The key property: antecedents resolve from the **declared site type**,
from **discovery**, or from **another check's result** — so the engine evaluates checks in dependency order and reuses
probe results instead of re-fetching, keeping the subrequest budget bounded. Only `api-surface` / `docs-site` may need a
light extra signal (a link scan of the already-fetched root HTML).

| Antecedent         | The check applies when...                                             | Resolved from                                                                                                   |
| ------------------ | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| none               | always                                                                | no gate                                                                                                         |
| http-root          | the root URL returns any HTTP response                                | the root fetch (a network error makes the check `error`/`skip`, not `n/a`)                                      |
| html-root          | the root response Content-Type is `text/html`                         | Content-Type of the root fetch (already made for the HTML-affordance checks)                                    |
| mcp-present        | discovery found an MCP endpoint                                       | existing MCP discovery (well-known cards, then common-path `initialize`)                                        |
| mcp-auth           | the discovered MCP endpoint challenges for auth                       | `401` / `WWW-Authenticate` on the endpoint, or `authentication.required` in its card                            |
| api-surface        | declared type is API/Application, OR an API is detected               | declared type short-circuits; else an `openapi`/`service-desc` link in root HTML or the `openapi` probe passing |
| schemas-ref        | the site references JSON Schemas or publishes OpenAPI                 | the `openapi` result + a link scan of root/openapi                                                              |
| docs-site          | declared type is Content, OR content heuristics hold                  | declared type; else `llms.txt` present + a doc-heavy sitemap                                                    |
| root-llms-txt      | the root `/llms.txt` check passed                                     | reuse the `llms-txt` probe result                                                                               |
| root-llms-full-txt | the root `/llms-full.txt` check passed                                | reuse the `llms-full-txt` probe result                                                                          |
| robots-present     | `/robots.txt` returned `200`                                          | reuse the `robots` probe result                                                                                 |
| auth-present       | OAuth discovery metadata exists, OR an API/MCP surface returned `401` | reuse the `oauth-discovery` probe + any `401` observed during the run                                           |

`Eval` values: `-` is the standard evaluate-the-assertion path; `canonical+redirect` applies the
canonical-plus-redirect-aliases rule (below) to the MCP card; `scoped-discovery` enumerates subdir `llms.txt` candidates
(see Open items).

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
  "title": "OpenAPI description published",
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

- **Scoring deviations from the binary** (default is to mirror the binary exactly): (a) score a missed applicable MAY as
  `n_a` (excluded) instead of `warn` (0.5); (b) score a present-but-broken SHOULD/MAY as a `fail` instead of `warn`, so
  a malformed surface costs more than an absent one. Adopt either, both, or neither.
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
