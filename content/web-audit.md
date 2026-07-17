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

- **Discoverability** — `robots.txt`, `sitemap.xml`, `Link` headers, `<link rel>` pointers, and DNS-AID records under
  `_agents`.
- **Content for agents** — `llms.txt` (root and per-section), `llms-full.txt`, `Accept: text/markdown` content
  negotiation, and the root-HTML affordances (meta description, `<noscript>`, JSON-LD, semantic landmarks).
- **Bot & crawl policy** — AI-crawler rules, Content-Signal directives, `security.txt`, and Web Bot Auth.
- **API** — an OpenAPI description, referenced JSON Schemas, and a `.well-known/api-catalog` (RFC 9727).
- **MCP** — the `initialize` handshake, `tools/list` with input schemas, JSON-RPC error codes, a prompt GET answer (no
  held-open hang), CORS preflight and actual, the `.well-known` server card, a usage doc, and WebMCP.
- **Agent discovery & auth** — the A2A agent card, agent-skills index, OAuth discovery metadata, and `auth.md`.

A check is scored only when it applies: MCP checks need a discovered endpoint, API checks need an API surface, and a
declared site type (`content` or `api`) scopes the rest. Anything that does not apply is `n_a` and never counts against
the site. Two scores come out of one run: the **site score** (the headline) measures the site against the checks that
apply to it, so a site perfect for its type approaches 100%; the **global score** measures it against a maximally
agent-ready site, so exposing and nailing more surfaces ranks higher. A present-but-broken surface costs more than an
absent one — it misleads agents.

## From an agent

An MCP client can run the audit without the form. The [anc.dev MCP server](/mcp) exposes four web tools:

- `audit_website(url, site_type?)` — run a fresh audit; non-passing rows carry inline remediation with a copy-paste
  prompt.
- `get_website_audit(url)` — read a cached scorecard without re-running.
- `list_website_audits()` — the curated [web leaderboard](/web).
- `get_web_remediation(check_id, evidence?)` — the canonical fix for any check, with a ready-to-paste prompt.

## See how sites score

The [web leaderboard](/web) ranks a curated set of sites by their global agent-readiness score, with a relative-score
toggle. Each row links to its `/web/<domain>` scorecard with full per-check evidence and fixes. For the CLI side, see
the [ANC 100 leaderboard](/scorecards) and [audit your CLI](/audit) with `anc`.
