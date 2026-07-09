# Audit your website

The same eight principles that score a CLI for agent-readiness also score a website and its MCP server. This audit
probes the agent-facing surface of any public site: its MCP server shape, its MCP and agent discovery surfaces, its
machine-readable content (`llms.txt`, OpenAPI, JSON Schemas), its root-HTML affordances, and its crawl policy. The
result is an anc scorecard, isomorphic with a CLI scorecard, at a shareable [`/web/<domain>`](/web) page.

<section class="live-score" aria-labelledby="web-audit-heading" data-web-audit-section>
  <div class="live-score__row">
    <span class="live-score__kicker" aria-hidden="true">Audit</span>
    <div class="live-score__content">
      <h2 id="web-audit-heading" class="live-score__title">Score a website, live.</h2>
      <p class="live-score__lede">Enter a public URL. Each check streams in as it resolves; the finished scorecard is saved at a shareable <code>/web/&lt;domain&gt;</code> page.</p>
      <form class="live-score__form" method="post" action="/api/audit-web" novalidate data-web-audit-form>
        <div class="live-score__input-row">
          <input id="web-audit-input" class="live-score__input" name="url" type="text" autocomplete="off" spellcheck="false" placeholder="anc.dev" required aria-label="Website URL" aria-describedby="web-audit-help" data-web-audit-input />
          <button type="submit" class="live-score__submit" data-web-audit-submit>Audit</button>
        </div>
        <p id="web-audit-help" class="live-score__help">
          or try
          <button type="button" class="live-score__chip" data-web-audit-example="anc.dev" aria-label="Try example: anc.dev"><code>anc.dev</code></button>,
          <button type="button" class="live-score__chip" data-web-audit-example="modelcontextprotocol.io" aria-label="Try example: modelcontextprotocol.io"><code>modelcontextprotocol.io</code></button>.
        </p>
        <p class="live-score__status" data-web-audit-status role="status" aria-live="polite" hidden></p>
      </form>
      <table class="audit-table">
        <tbody data-web-audit-results></tbody>
      </table>
    </div>
  </div>
</section>

## What it checks

The audit runs entirely as network probes: HTTP requests, a JSON-RPC handshake over streamable-HTTP, a CORS preflight,
and DNS-over-HTTPS lookups. There is no crawler and nothing is installed. Every check maps onto one of the eight
principles and carries a MUST, SHOULD, or MAY keyword:

- **MCP server shape** — the `initialize` handshake, `tools/list` with input schemas, JSON-RPC error codes, GET
  fast-fail, and CORS.
- **MCP and agent discovery** — the `.well-known` MCP server card, A2A agent card, agent-skills index, API catalog, and
  DNS-AID records under `_agents`.
- **Machine-readable content** — `llms.txt`, `llms-full.txt`, OpenAPI, JSON Schemas, and `Accept: text/markdown` content
  negotiation.
- **Root-HTML affordances** — a meta description, `<link rel>` to machine surfaces, a `<noscript>` fallback, Schema.org
  JSON-LD, and semantic landmarks.
- **Crawl policy** — `robots.txt`, AI-crawler rules, Content-Signal directives, `sitemap.xml`, and `security.txt`.

The MCP-shape checks apply only when an MCP endpoint is discovered; on a site without one they are marked `n_a` and
excluded from the score. The score is credit-weighted over the MUST and SHOULD checks that apply; MAY checks are
informational.

## From an agent

An MCP client can run the audit without the form. The [anc.dev MCP server](/mcp) exposes four web tools:

- `audit_website(url)` — run a fresh audit and return the complete scorecard.
- `get_website_audit(url)` — read a cached scorecard without re-running.
- `list_website_audits()` — the curated [web leaderboard](/web).
- `get_web_remediation(check_id)` — the canonical fix for any check.

## See how sites score

The [web leaderboard](/web) ranks a curated set of sites by their agent-readiness score. Each row links to its
`/web/<domain>` scorecard with full per-check evidence. For the CLI side, see the [ANC 100 leaderboard](/scorecards) and
[audit your CLI](/audit) with `anc`.
