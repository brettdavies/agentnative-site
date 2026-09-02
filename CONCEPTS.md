# Concepts

Shared domain vocabulary for this project — entities, named processes, and status concepts with project-specific
meaning. Seeded with core domain vocabulary, then accretes as ce-compound and ce-compound-refresh process learnings;
direct edits are fine. Glossary only, not a spec or catch-all.

## The standard

### anc

The agent-native compliance auditor: the `anc` CLI inspects a tool's command-line interface against the agent-native
principles and emits a scorecard. It is the engine behind both batch scoring and the live-scoring sandbox; this site is
its public registry and results surface. The CLI itself lives in a separate repository.

### Agent-native principle

One of the eight principles (P1 through P8) that define what makes a CLI usable by an AI agent rather than only a human:
non-interactive defaults, structured parseable output, progressive help discovery, fail-fast actionable errors, safe
retries with explicit mutation boundaries, composable predictable commands, bounded high-signal responses, and a
discoverable skill bundle. A scorecard asserts which principles a tool meets and at what score. The canonical principle
text is the vendored spec; site copy is written from it deliberately, not imported at build time.

### Badge

The agent-native badge a tool earns when its scorecard clears the credit-weighted pass threshold. It is the headline
compliance signal on a tool's scorecard and the mark a project displays to claim agent-native status. The threshold is a
scoring-policy value, not fixed in this glossary.

## Visitor preference

### Visitor surface preference

The visitor's chosen CLI vs Website leaderboard surface (`cli` | `web`), stored in `localStorage` under `anc-surface`.
Writers are the homepage CLI|Website segment, the board Probe A segment, and the audit landing Probe A segment; readers
are the dual header Leaderboards and Audit anchors (CSS visibility flip via homepage `:has` or off-home
`html[data-surface]`). Preference drives where Leaderboards and Audit point next even when it differs from the board or
audit page currently displayed; visiting a board or audit URL alone does not write preference. On the homepage, no-JS
`:has` keeps Leaderboards, Audit, Full board, and segment in sync; board and audit Probe A require JavaScript to
navigate between peer landing pages.

## Content surface

### Markdown twin

The markdown version of every content page, served at the same path with a `.md` suffix, under an explicit markdown
`Accept`, or when Accept is absent/`*/*` and the client is a markdown-eligible agent (for example curl). It opens with a
short frontmatter block (title, description, canonical URL) followed by the source body verbatim, with site-internal
links resolved to absolute URLs. The frontmatter-free body is what gets concatenated into `llms-full.txt`. It is the
agent-facing half of the site's dual-surface contract: one markdown source emits both an HTML page for browsers and this
twin for agents. HTML smokes must send `Accept: text/html`; bare curl is not a browser.

Because the twin's body is the source verbatim, only prose belongs in the content source. Interactive HTML that renders
correctly in the HTML page leaks dead controls into the twin, so browser widgets are declared in a build template and
substituted per surface rather than authored inline.

### Format-class edge cache

The skip-Worker cache in front of this Worker (Cloudflare Workers Caching), keyed on a tiny agent-vs-browser class plus
`Accept` for negotiated URLs. A HIT on those URLs must still show `Vary: Accept, User-Agent`. Exact User-Agent strings
are not the class; a gateway normalizes them before the cached entrypoint. Zone Cache Rules are a different cache and do
not skip this Worker.

### HIT-1d / HIT-min / MISS

Three edge classes for this site. HIT-1d is bake-at-build (about a day of freshness, empty cache on a new Worker
version). HIT-min is live-board HTML and markdown (`max-age=300`, purge by Cache-Tag when R2 is rewritten). MISS is
every-request `no-store` (`/web/scoring*`, POST `/mcp`, `/api/score`, `/api/audit-web`). Homepage HTML and homepage
markdown share HIT-min because they are one object that includes the live web pane.

## Live scoring

### anc100

The curated registry of CLI tools used as the canonical scoring corpus. Lives in `registry.yaml` at the repo root and is
the source of truth for the leaderboard, per-tool scorecard pages, and the live-scoring sandbox's install table. Each
row is a registry entry. The name is fixed; the actual count drifts above and below 100 as tools join and leave.

### Registry entry

A single row in the anc100 registry. Carries the tool's URL-safe name, the binary it installs, the install command, the
project's tier (workhorse, agent, or notable), the creator, and the audit profile that shapes how `anc audit` scores it.
Lookup is dual-keyed by name (URL slug) and by GitHub owner/repo.

### Tier

The registry classification of why a tool is in the corpus, independent of the score it earns: `workhorse` (ubiquitous
general-purpose tools), `agent` (tools built for or aimed at agents), or `notable` (included for other noteworthy
reasons). Set per registry entry.

### Audit profile

A named scoring profile that adapts `anc audit` to a tool's interface style, so principles are applied appropriately
rather than uniformly (for example, a file-traversal utility versus a human-facing TUI). Set per registry entry; it
shapes which checks apply and how they weigh.

### Live-scoring sandbox

The system at `anc.dev` that accepts a user's install command, installs the named tool in an ephemeral container, runs
`anc audit` against the installed binary, and returns a scorecard. One container per scoring request — no shared state
across requests. The runtime is a Cloudflare Durable Object pool fronted by a Worker that resolves the input to an
install spec before dispatching to the container.

### Score (verb) / Scoring

Producing a scorecard by running `anc audit` against a tool. Score happens at two scales: batch scoring (the build-time
pipeline in `docker/score/` that scores the whole anc100 list once per release) and live scoring (per-request, on user
input, in the live-scoring sandbox).

### Scorecard

The structured JSON `anc audit` produces for a single tool, asserting which of the 8 agent-native principles the tool's
CLI meets and at what score. Each principle has weighted checks; the badge surfaces the percentage pass rate. Committed
scorecards live under `scorecards/` in the repo; live-scoring scorecards stream back to the user and are cached in R2.

### Install spec

The resolved, executable form of a user's input after the Worker's resolution layer (`src/worker/score/resolve-spec.ts`)
runs. Names a package manager (`brew`, `cargo-binstall`, `bun`, `pip`, `uv`, `npm`, `go`, `direct`, `git-clone`), a
package or URL, and the binary the post-install check verifies on `PATH`. The Durable Object only ever sees an install
spec, never the raw user input.

### Bounce

A live-scoring outcome where the request ends without a scorecard and the user gets an explanation panel instead: the
input never resolved to an installable tool, the resolved install produced no binary, or the install itself failed. A
bounce is a first-class result, not an error page; each bounce class carries its own headline, guidance, and, when there
is failure output worth surfacing, the truncated stderr so the user can see why. Distinct from a scoring error (the
pipeline broke) and from a low score (the pipeline finished).

## Web audit

### Web audit

The in-Worker website agent-readiness audit: registry-driven network probes (HTTP requests, a JSON-RPC handshake, a CORS
preflight, DNS-over-HTTPS lookups) of a site's agent-facing surfaces, streamed check-by-check and cached as a web
scorecard at a shareable per-domain page. There is no crawler; every check is a bounded probe.

### Web scorecard

The structured JSON a web audit produces. Distinct from the CLI scorecard and versioned by its own schema: it carries
the two scores (relative and global), per-category rollups, and per-check rows with tri-state outcomes and the reason a
row is not applicable; every serving surface (result page, markdown twin, MCP tools) attaches remediation pointers to
non-passing rows.

### Antecedent

The runtime gate deciding whether a web-audit check applies to a site. Resolved from the declared site type, MCP
discovery, the canonical root fetch, or another check's probe result — never a fresh fetch. An unmet antecedent makes
the check not applicable (excluded from scoring entirely), which is different from the check failing.

### Site type

The caller-declared scope of a web audit: a content site or an API/application. Checks outside the declared type are not
applicable; declaring nothing runs everything, and MCP surfaces are auto-detected from discovery regardless of the
declaration.

### Tri-state outcome

The web audit's distinction for a probed surface: absent (not there), broken (present but invalid), or not applicable.
Broken is priced worse than absent because a malformed surface actively misleads agents; an optional surface that is
absent counts as not applicable, never as a miss.

### Relative score / Global score

The two scores one web-audit run produces. Relative (the headline) measures the site against only the checks that apply
to it, so a site perfect for its type approaches the maximum. Global measures the same outcomes against a maximally
agent-ready site, so exposing and nailing more surfaces ranks higher; the web leaderboard sorts by it.

### Fix skill

The per-check remediation page for a web-audit check, served at a content URL with a markdown twin and listed as a
pointer entry in the agent-skills discovery index. Scorecard remediation prompts point agents at it as the durable
how-to-fix reference.

### Assemble prompt

The `/web/<domain>` HTML widget that concatenates those per-check prompts for failed rows. Default selection is MUST
failures (`broken` or `absent`); SHOULD and MAY are independent opt-ins, and an empty MUST set does not pull them in. It
mounts in the browser only, so the markdown twin keeps per-check fenced prompts and no-JS HTML has no dead controls.

### Leaderboard aggregate

The precomputed board object the homepage web pane, the MCP board listing, and the curated view of `/web` all read: a
ranked full board plus a top-N frontpage slice, rebuilt from the per-domain web scorecards. It keeps those surfaces in
agreement, so a fresh audit cannot leave one showing a different score than another. When it is absent (a fresh deploy,
or a spec-version change that rotates every cached key) the surfaces that depend on it render a scoring-in-progress
state until the next rescore rebuilds it.

### Board view

The two ways `/web` (and its markdown twin) render the ranked list: the curated view shows only the leaderboard
aggregate's registry-seeded rows; the all view, the default, adds every other non-expired cached audit — sites a user
submitted on demand rather than the registry — read live rather than from the aggregate. The homepage pane and the MCP
board listing always render curated only; there is no all-view equivalent for either.

### Public listing

A per-domain, submitter-set boolean stored on a web-audit envelope and mirrored into the R2 board metadata, recording
whether the submitter consents to that domain appearing on public board-listing surfaces. Curated (seeded) domains are
exempt and always exposed regardless of the flag. Explicit values always take effect; an omitted value never erases a
previously stored choice, and only a domain's first-ever audit defaults it to unlisted. Because the flag is out-of-band
state relative to an audit's own inputs, every write path capable of rewriting a domain's stored audit, a fresh
submission, a flag-only patch, a scheduled rescore, or a registry-fingerprint reflow, must explicitly resolve and carry
it forward, or it silently reverts to the default.

### Staleness window

More than one independent threshold gates behavior from the same web-audit freshness stamp, and they must not be
conflated. One controls whether an on-demand request serves the cached result or falls through to a fresh audit; a
separate one controls how long an unseeded entry stays visible before it ages off the board's display, even though the
underlying cached record persists. The two are tuned independently for different jobs, and a write path that restamps
freshness for an unrelated reason resets both at once, whether or not that is intended. Distinct from the cadence a Web
rescore batch uses to decide which curated domains are due for re-audit, a third, separately-tuned window.

### Web rescore

The batch process that re-audits every curated board domain and rebuilds the leaderboard aggregate. It runs on a weekly
schedule and after each deploy; only one batch runs at a time, so overlapping triggers coalesce rather than
double-spending the audit budget. It is what keeps the board's live scores fresh without committing any scorecard
snapshots. Distinct from an on-demand audit of a single domain, which caches its own result without starting a batch.

## Agent discovery

### MCP endpoint

The site's Model Context Protocol server at `/mcp`: a streamable-HTTP, JSON-RPC surface that exposes the anc100 registry
and scoring tools to agents. GET returns the landing page (or, under a JSON `Accept` header, a permanent redirect to the
MCP server card); POST carries JSON-RPC. Unauthenticated by design, because the catalog is public.

### MCP era

Which of two protocol generations a single `POST /mcp` request belongs to, `legacy` or `modern`. The server classifies
every request on arrival and carries that classification through the rate-limit key, the legacy kill switch, and the
`mcp.request` log line, so era is the axis operators group by when judging whether the legacy lane can be retired. Era
is a property of the request, not of the client or the connection: one agent can send both.

### Legacy lane

The era path for clients that open with an `initialize` handshake rather than the modern request headers. The server
answers statelessly, with no session to resume. `MCP_LEGACY_ENABLED` gates this lane alone: set to `false`, a legacy-era
request is rejected with JSON-RPC `-32022` naming the served revision under `data.supported`, and the modern lane keeps
serving. The lane is scheduled for sunset, so its traffic share and its top client names are the evidence that decision
rests on.

### Modern lane

The era path for clients that skip the handshake and address the server directly, carrying the protocol revision in an
`MCP-Protocol-Version` header, the operation in `Mcp-Method`, and client capabilities in `_meta` inside JSON-RPC params.
Two behaviors exist only here: a rate-limit key narrows to the named tool when `Mcp-Name` identifies a registered one,
and list and read results carry the server's cache hints (`ttlMs`, `cacheScope`). This is the lane the site's declared
spec revision describes.

### MCP server card

The machine-readable descriptor of the MCP endpoint, following the SEP-1649 server-card shape: it declares the endpoint
URL, the protocol revision, the transport, a documentation pointer, and that authentication is not required. Canonical
at `/.well-known/mcp/server-card.json`; the legacy alias paths permanently redirect to it, so one canonical body exists
with no duplicates.

### Discovery surface

Any machine-readable endpoint that lets an agent find and use the MCP endpoint without reading the HTML site: the MCP
server card, the OAuth metadata, the JWKS, the RFC 9727 api-catalog, the agent-skills index, and the AI-signal lines in
`robots.txt` / `ai.txt`. The family is served by the Worker and is the agent-facing twin of the human navigation; every
entry points at the same MCP endpoint, so drift between them breaks discoverability. DNS-AID is the DNS-layer
counterpart, discoverable before any HTTP fetch.

### DNS-AID

The DNS-layer member of the agent-discovery family: `SVCB` records published under the domain's `_agents` namespace that
point an agent at the MCP endpoint's host, port, and protocol over DNS, so a resolver-only client finds the service
without an HTTP fetch. The records carry connectivity only (host, port, ALPN), not the endpoint path; the path still
comes from the MCP server card. Unlike the Worker-served discovery surfaces, these live in the zone's DNS, are validated
over DNS-over-HTTPS, and are signed with DNSSEC.

### Origin rewrite

The Worker behavior of rewriting absolute URLs in a discovery surface to the inbound request's origin at serve time, so
staging and local previews return self-consistent URLs (their own host) instead of the production host baked in at
build. Every origin-aware surface must go through the one shared rewrite path; a surface served as a verbatim static
asset silently skips it and reports the wrong origin.

## Telemetry

### Client class

The closed taxonomy classifying every visitor for telemetry: browser, ai-fetcher, ai-crawler, search-crawler,
cli-client, or unknown. Derived at the gateway from the original User-Agent before normalization deletes or rewrites it,
and carried on page-serving records; agent identity comes from the taxonomy's own table, never from stored User-Agent
text. Distinct from the markdown-eligibility class the format-class edge cache keys on — that class routes content, this
one describes the audience, and their token lists differ deliberately.

### Delivery surface

The channel a response reaches a visitor through: the HTML page, the markdown twin, or the MCP endpoint. Telemetry
groups consumption share by this axis. Distinct from the visitor surface preference, which is a stored CLI-vs-Website
leaderboard choice, not a channel.

### Co-browsing

A human and an agent sharing one browsing session, as with WebMCP-style in-page tools. The agent side generates no
origin traffic of its own, so co-browsing is invisible to server-side telemetry; what the client layer can observe is
established by measurement before any backend consumes it.

### Telemetry lake

The permanent, open-format store of the site's raw telemetry events: Workers trace events delivered through a managed
export chain into Apache Iceberg tables on the site's own R2 bucket, queried through the R2 SQL editor. It is the only
layer that can answer months-horizon questions; the live Workers Logs window and the coarse zone rollups sit in front of
it with platform-capped retention.
