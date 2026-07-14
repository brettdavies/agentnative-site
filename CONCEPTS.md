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

## Content surface

### Markdown twin

The verbatim markdown version of every content page, served at the same path with a `.md` suffix or under `Accept:
text/markdown`, and concatenated into `llms-full.txt`. It is the agent-facing half of the site's dual-surface contract:
one markdown source emits both an HTML page for browsers and this twin for agents.

Because the twin is served from the source verbatim, only prose belongs in the content source. Interactive HTML that
renders correctly in the HTML page leaks dead controls into the twin, so browser widgets are declared in a build
template and substituted per surface rather than authored inline.

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

## Agent discovery

### MCP endpoint

The site's Model Context Protocol server at `/mcp`: a streamable-HTTP, JSON-RPC surface that exposes the anc100 registry
and scoring tools to agents. GET returns the landing page (or, under a JSON `Accept` header, a permanent redirect to the
MCP server card); POST carries JSON-RPC. Unauthenticated by design, because the catalog is public.

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
