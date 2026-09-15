## Audit a website

The website audit probes the agent-facing surface of any public site: its MCP server, its MCP and agent discovery
surfaces, its machine-readable content (`llms.txt`, OpenAPI, JSON Schemas), its root-HTML affordances, and its crawl
policy. The result is a web scorecard with per-check evidence and copy-paste fixes, at a shareable `/score/<host>` page.

## What a website audit checks

The audit runs entirely as network probes: HTTP requests, a JSON-RPC handshake over streamable-HTTP, a CORS preflight,
and DNS-over-HTTPS lookups. There is no crawler and nothing is installed. Every check carries a MUST, SHOULD, or MAY
keyword and belongs to one of six categories:

- **Discoverability**: `robots.txt`, `sitemap.xml`, `Link` headers, `<link rel>` pointers, DNS-AID records under
  `_agents`, and an agent-friendly 404: a nonsense path MUST return HTTP 404 or 410 (a soft-200 SPA shell is broken),
  and the markdown 404 twin SHOULD carry at least one recovery link (`sitemap.xml`, `llms.txt`, or docs).
- **Content for agents**: `llms.txt` (root and per-section), `llms-full.txt`, and markdown content negotiation: `Accept:
  text/markdown`, the markdown twin served to bare CLI and library User-Agents and to AI user-fetchers that state no
  content-type preference, `Accept: text/plain` treated as a markdown request, and `Vary: Accept, User-Agent` on the
  negotiated response. Root HTML MUST carry an H1 and enough visible text for a non-JS agent; a discoverable `llms.txt`
  twin can mark that floor not-applicable rather than crediting a JS shell. When `llms.txt` is present, three quality
  rows score format (H1, summary, link index), whether those links resolve, and a when-to-use or programmatic-access
  heading. Plus the other root-HTML affordances (meta description, `<noscript>`, JSON-LD, semantic landmarks).
- **Bot and crawl policy**: AI-crawler rules, Content-Signal directives, `security.txt`, Web Bot Auth, and agent-UA
  reachability (`GET /` with a user-fetcher User-Agent must not land on a challenge interstitial).
- **API**: an OpenAPI description, referenced JSON Schemas, a `.well-known/api-catalog` (RFC 9727), JSON client-error
  bodies (not HTML), and rate-limit headers on a safe GET.
- **MCP**: the `initialize` handshake, `tools/list` with input schemas, `resources/list` when `capabilities.resources`
  is advertised, the modern era (protocol revision `2026-07-28`) scored as its own lane, per-era JSON-RPC error-code
  conformance, a prompt GET answer (no held-open hang), CORS preflight and actual, the `.well-known` server card, a
  usage doc, and WebMCP. Each protocol era scores independently: a dual-stack server earns both lanes, and a single-era
  server fails exactly the lane it lacks.
- **Agent discovery and auth**: the A2A agent card, optional `/.well-known/ai-catalog.json` (ARD), agent-skills index,
  OAuth discovery metadata, and `auth.md`.

A check is scored only when it applies: MCP checks need a discovered endpoint, API checks need an API surface, and a
declared site type (`content` or `api`) scopes the rest. Anything that does not apply is `n_a` and never counts against
the site. Two scores come out of one run: the **site score** (the headline) measures the site against the checks that
apply to it, so a site perfect for its type approaches 100%; the **global score** measures it against a maximally
agent-ready site, so exposing and nailing more surfaces ranks higher. A present-but-broken surface costs more than an
absent one, because it misleads agents. A surface that works while violating a spec detail reads `noncompliant` and
earns partial credit, so showing an imperfect capability always beats withdrawing it.

## From an agent: websites

An MCP client can run the audit without the form. The [anc.dev MCP server](/mcp) exposes four web tools:

- `audit_website(url, site_type?, public_listing?)`: run a fresh audit; every observed non-passing row carries inline
  remediation with a copy-paste prompt.
- `get_website_audit(url)`: read a cached scorecard without re-running.
- `list_website_audits(view?)`: the web leaderboard, curated by default.
- `get_web_remediation(check_id, evidence?)`: the canonical fix for any check, with a ready-to-paste prompt. Pass the
  failing row's evidence and it is appended to the prompt as a delimited, untrusted data block.

Every response carrying a scorecard also carries `cached`, `scored_at`, and `refresh_after` beside it. A cached entry
younger than one minute is served as-is; past `refresh_after` a repeat request tries a fresh audit instead. That is
cache-expiry eligibility, not a guarantee: the operator kill switch, the per-source rate limits, and probe failures can
still refuse, and the cached scorecard is served as data when they do. Full contract at
[response freshness](/web-scorecard-schema#response-freshness).

## See how sites score

The [web leaderboard](/web) ranks a curated set of sites by their agent-readiness, and each row links to its scorecard
with full per-check evidence and fixes.
