# Audit your website

This audit probes the agent-facing surface of any public site: its MCP server shape, its MCP and agent discovery
surfaces, its machine-readable content (`llms.txt`, OpenAPI, JSON Schemas), its root-HTML affordances, and its crawl
policy. The result is a web scorecard with per-check evidence and copy-paste fixes, at a shareable
[`/web/<domain>`](/web) page.

{{WEB_AUDIT_FORM}}

The browser audit runs with JavaScript and a Turnstile challenge. Agents and scripts should call the
[`audit_website`](/mcp) MCP tool instead, which accepts a full URL and needs no browser.

## What it checks

The audit runs entirely as network probes: HTTP requests, a JSON-RPC handshake over streamable-HTTP, a CORS preflight,
and DNS-over-HTTPS lookups. There is no crawler and nothing is installed. Every check carries a MUST, SHOULD, or MAY
keyword and belongs to one of six categories:

- **Discoverability** — `robots.txt`, `sitemap.xml`, `Link` headers, `<link rel>` pointers, DNS-AID records under
  `_agents`, and an agent-friendly 404: a nonsense path MUST return HTTP 404 or 410 (a soft-200 SPA shell is broken),
  and the markdown 404 twin SHOULD carry at least one recovery link (`sitemap.xml`, `llms.txt`, or docs).
- **Content for agents** — `llms.txt` (root and per-section), `llms-full.txt`, and markdown content negotiation:
  `Accept: text/markdown`, the markdown twin served to bare CLI/library User-Agents and AI user-fetchers that state no
  content-type preference, `Accept: text/plain` treated as a markdown request, and `Vary: Accept, User-Agent` on the
  negotiated response. Root HTML MUST carry an H1 and enough visible text for a non-JS agent; a discoverable `llms.txt`
  twin can mark that floor not-applicable rather than crediting a JS shell. When `llms.txt` is present, three quality
  rows score format (H1, summary, link index), whether those links resolve, and a when-to-use / programmatic-access
  heading. Plus the other root-HTML affordances (meta description, `<noscript>`, JSON-LD, semantic landmarks).
- **Bot & crawl policy** — AI-crawler rules, Content-Signal directives, `security.txt`, Web Bot Auth, and agent-UA
  reachability (`GET /` with a user-fetcher User-Agent must not land on a challenge interstitial).
- **API** — an OpenAPI description, referenced JSON Schemas, a `.well-known/api-catalog` (RFC 9727), JSON client-error
  bodies (not HTML), and rate-limit headers on a safe GET.
- **MCP** — the `initialize` handshake, `tools/list` with input schemas, `resources/list` when `capabilities.resources`
  is advertised, the modern era (protocol revision `2026-07-28`) scored as its own lane (a header-routed `tools/list`
  that needs no `initialize`, and `server/discover` answering with server identity), per-era JSON-RPC error-code
  conformance (on the legacy lane: a parse-error envelope or typed HTTP refusal for a malformed body, batch rejection,
  and the unknown-method and unknown-tool codes; on the modern lane: the unknown-method code, the mandatory
  `clientCapabilities` refusal, the header-mirror mismatch code, the version reject carrying `data.supported`, and the
  resources-read miss code), a prompt GET answer (no held-open hang), CORS preflight and actual, the `.well-known`
  server card, whether the legacy card paths redirect to it rather than serving their own copy, a usage doc, and WebMCP.
  Each protocol era scores independently: a dual-stack server earns both lanes, and a single-era server fails exactly
  the lane it lacks.
- **Agent discovery & auth** — the A2A agent card, optional `/.well-known/ai-catalog.json` (ARD), agent-skills index,
  OAuth discovery metadata, and `auth.md`.

A check is scored only when it applies: MCP checks need a discovered endpoint, API checks need an API surface, and a
declared site type (`content` or `api`) scopes the rest. Anything that does not apply is `n_a` and never counts against
the site. Two scores come out of one run: the **site score** (the headline) measures the site against the checks that
apply to it, so a site perfect for its type approaches 100%; the **global score** measures it against a maximally
agent-ready site, so exposing and nailing more surfaces ranks higher. A present-but-broken surface costs more than an
absent one, because it misleads agents. A surface that works while violating a spec detail reads `noncompliant` and
earns partial credit, so showing an imperfect capability always beats withdrawing it.

The HTML result page can assemble MUST failure prompts into one copy buffer (SHOULD and MAY are opt-in). The markdown
twin keeps per-check fenced prompts and does not carry that widget. Both state when the audit was scored and when a
re-run becomes eligible.

## From an agent

An MCP client can run the audit without the form. The [anc.dev MCP server](/mcp) exposes four web tools:

- `audit_website(url, site_type?, public_listing?)` — run a fresh audit; every observed non-passing row carries inline
  remediation with a copy-paste prompt.
- `get_website_audit(url)` — read a cached scorecard without re-running.
- `list_website_audits(view?)` — the [web leaderboard](/web), curated by default.
- `get_web_remediation(check_id, evidence?)` — the canonical fix for any check, with a ready-to-paste prompt. Pass the
  failing row's evidence and it is appended to the prompt as a delimited, untrusted data block.

Every response carrying a scorecard also carries `cached`, `scored_at`, and `refresh_after` beside it. A cached entry
younger than one minute is served as-is; past `refresh_after` a repeat request tries a fresh audit instead. That is
cache-expiry eligibility, not a guarantee: the operator kill switch, the per-source rate limits, and probe failures can
still refuse, and the cached scorecard is served as data when they do. Full contract at
[response freshness](/web-scorecard-schema#response-freshness).

## From the result page

`/web/<domain>` publishes its own read-only [WebMCP](https://webmachinelearning.github.io/webmcp/) tools, so a browser
agent reads a finished audit from the page it is already looking at. Each tool reads the rendered page and nothing else:
no fetch, no form submission, no navigation. None of them starts an audit, so none of them can bypass the Turnstile
challenge the browser audit sits behind. To run an audit, use the MCP tools above.

| Tool                | Arguments                                        | Returns                                                                                                               |
| ------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `get_worksheet`     | `ids`, `keywords`, `statuses`, `offset`, `limit` | One row per matching finding: `id`, `keyword`, `tier`, `status`, `unprobed`, `result`, `remediable`.                  |
| `get_fix_prompt`    | `id` (required)                                  | The stored prompt for one check id, or a reason it has none, or `found: false` for an id the page does not render.    |
| `get_fix_prompts`   | `ids`, `keywords`, `statuses`, `offset`, `limit` | A prompt per matching fixable row; a selected row that needs no fix comes back with `remediable: false` and a reason. |
| `get_audit_summary` | `offset`, `limit`                                | `site_score`, `global_score`, a count for each of the seven statuses, and the paged issue list.                       |

Every response is a JSON envelope carrying `ok`, the page's `cached` / `scored_at` / `refresh_after`, and the result.
Rejected input answers `{ "ok": false, "error": { "code", "field", "message" } }`, with `allowed` listing the accepted
values when the field is an enum.

**Filters.** `ids`, `keywords`, and `statuses` are independent dimensions. Values OR within one dimension and the
dimensions AND across, so `{ "keywords": ["must", "should"], "statuses": ["broken"] }` selects the broken MUST and
SHOULD rows. `keywords` accepts `must`, `should`, and `may`; `statuses` accepts `pass`, `noncompliant`, `broken`,
`absent`, `n_a`, `skip`, and `error`. An omitted filter selects every value, with one exception: an omitted `statuses`
selects the observed fixable rows (`broken`, `noncompliant`, and `absent`, excluding `unprobed` ones), because an agent
asking for findings with no status in mind wants what it can fix. Naming statuses explicitly selects those rows whether
or not the run probed them, so every rendered row stays reachable. A present but empty array is rejected rather than
read as "none"; omit the filter instead.

**Order.** Every paginated surface returns one order: normative keyword `must`, `should`, `may`; then status `broken`,
`absent`, `noncompliant`, `error`, `pass`, `n_a`, `skip`; then observed rows before `unprobed` ones; then rendered page
order.

**Pagination.** `offset` defaults to 0 and accepts any integer from 0 up. `limit` defaults to 10 and accepts 1 through
25. Each response reports `total` (items matching the filters), `returned` (items in this page), `omitted` (matching
items left after this page), and `next_offset`. Follow `next_offset` until it comes back `null`. A page carries whole
items only, so a page of long prompts can return fewer than `limit`; `next_offset` advances by `returned`, so following
it never skips an item.

**Prompt size.** Browser tools answer inside a 1,500-character cap. A prompt too long to fit whole comes back with
`prompt_truncated: true` and a `full_fix` object naming both an MCP tool call (`get_web_remediation` with the check id)
and the skill page's markdown URL. Only the `Fix:` line is ever shortened: the run's evidence block exists nowhere else
in the response, and `Goal:` and `Skill:` are how a reader recovers everything else.

## See how sites score

The [web leaderboard](/web) ranks a curated set of sites by their global agent-readiness score, with a relative-score
toggle. Each row links to its `/web/<domain>` scorecard with full per-check evidence and fixes. For the CLI side, see
the [ANC 100 leaderboard](/scorecards) and [audit your CLI](/audit) with `anc`.
