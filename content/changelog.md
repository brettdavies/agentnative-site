# Changelog

A record of what changed on anc.dev, newest first: the published standard, the scorecards and boards, the audits, the
MCP server, and the files agents read.

The standard's own version history lives in the
[spec repository's changelog](https://github.com/brettdavies/agentnative/blob/main/CHANGELOG.md). When a release moves
the site's principle pages to a new spec version, its entry here names the version and links the pages it touched.

## 2026-11-11

### Added

- Website audits treat a host and its `www.` sibling as one site when either redirects to the other. The scorecard is
  stored and shown under the bare host, and `/score/www.<domain>` redirects to it.
- The site serves its IndexNow key file at the root.

### Removed

- The OAuth discovery metadata for the MCP server: `/.well-known/oauth-protected-resource`,
  `/.well-known/oauth-authorization-server`, `/.well-known/jwks.json`, and the `/oauth2/token` stub now answer 404. The
  server needs no sign-in, which [/auth.md](/auth.md) and the server card still state.

### Fixed

- The website audit reads a server card that says sign-in is not required and lists no scheme as declaring no
  authentication, so the sign-in checks read not applicable for an open server.
- `score_cli` starts no live audit while live scoring is switched off, and two calls for the same input share one run.
  The [MCP server](/mcp-docs) instructions fit the length clients deliver whole, and every tool declares all three
  behavior hints.
- A CLI scorecard whose stored record cannot be read answers 503 with `Retry-After` instead of 404, and two audits
  started in the same second both run.

## 2026-11-10

### Added

- CLI scorecards that earn the agent-native [badge](/badge), and website scorecards with a headline score of 70 or more,
  can be indexed by search engines, on-demand audits included.
- A CLI scorecard with no repository or homepage links to its package's registry page.

### Changed

- Each live CLI audit installs and runs the tool as an unprivileged user in a new container of its own, and stores only
  a scorecard that matches the published shape. When no container can start, the score API answers 503 `sandbox_busy`.
- A pasted install command names a registry package. One that installs from a URL, a git repository, or a path answers
  `unparseable_install_command`.

### Fixed

- MCP clients on the 2026-07-28 protocol connect again: opening a `subscriptions/listen` stream no longer times out.
- Scorecard pages show every field's text as written and drop query parameters from the address on load, and outbound
  links tell the destination which page sent the visitor.

## 2026-11-09

### Added

- Every scorecard page has its own social card, showing the score in its band color with the audit date or tool version,
  and a clip of about 3.5 seconds that counts up to the score. The page's Open Graph and Twitter tags name both.
- A "Flag names" section on [/about](/about#flag-names) states how a requirement's double-dash flag name applies to
  tools whose help uses single-dash flags.

### Changed

- The principle pages move to spec v0.7.0, and the footer and social card show v0.7.0. [P2](/p2), [P3](/p3), and
  [P5](/p5) take the v0.7.0 rules. Every page's "Measured by" list names the audit IDs `anc` reports, and [P1](/p1),
  [P4](/p4), [P6](/p6), [P7](/p7), and [P8](/p8) drop conditions the standard does not have.
- Live CLI scoring and every curated CLI scorecard run on anc 0.7.0. A tool with no skill bundle reads not applicable on
  the P8 bundle rows, and a live run whose audit errored is shown but not saved.

### Fixed

- A GitHub repository URL entered in the [audit form](/audit) runs the audit instead of stopping at "That target has no
  result page".
- [/coverage](/coverage) and the MCP catalog's requirement summaries match the v0.7.0 rules, and the
  [scorecard schema](/scorecard-schema) documents `evidence` on passing rows.

## 2026-10-27

### Changed

- `GET /mcp` answers 405 with `Allow: POST` and a link to the endpoint description, which moves to
  [/mcp-docs](/mcp-docs). `/mcp.md` and `/mcp.html` redirect there.
- The website check `mcp-get-fast-fail` fails a `200` that is not an event stream, and `markdown-vary` passes when
  `Vary` names `Accept` or `*`, without `User-Agent`.

### Fixed

- The llms.txt link checks read a `[text](<url>)` destination without its angle brackets, so a valid link no longer
  reads as dead.
- The MCP server's error summary, in its `initialize` instructions and the [client guide](/mcp-skill), lists the HTTP
  403 `-32000` answer to a disallowed `Origin` or `Host`.

## 2026-10-08

### Changed

- A website audit sends each distinct request to the audited site once, so an audit makes fewer requests with the same
  scores.

### Fixed

- A robots.txt with no `Content-Signal` line, or with no wildcard or AI-crawler group, scores those rows absent instead
  of broken, so an ordinary robots.txt no longer scores below having none.

## 2026-10-06

### Fixed

- A badge URL built from a curated tool's binary name redirects to its canonical [badge](/badge): `/badge/rg.svg` goes
  to `/badge/ripgrep.svg`, so the embed snippet `anc` prints renders. An unknown name still answers 404.

## 2026-10-05

### Added

- anc.dev publishes a SEP-2127 MCP server card at [/mcp/server-card](/mcp/server-card) and an AI catalog at
  [/.well-known/ai-catalog.json](/.well-known/ai-catalog.json), advertised beside the SEP-1649 card on every discovery
  surface.

### Changed

- The principle pages move to spec v0.6.0, and the footer and social card show v0.6.0. [P3](/p3) gains the SHOULD that
  command-list entries name the command directly, and [P2](/p2)'s last two exit-code MUSTs render inside the MUST block.
- The website check `mcp-server-card` replaces `well-known-mcp-card` and scores the strongest card a site publishes, in
  either card generation. A SEP-1649 card still earns full credit.
- Live CLI scoring and every curated CLI scorecard run on anc 0.6.0, and a pasted GitHub branch link is audited from
  source.

### Fixed

- The scoring page hides its controls while an audit runs, and the homepage's principles and web-checks headings render
  at their designed size.

## 2026-10-04

### Added

- Website audits follow the hosts a site declares. An MCP endpoint on another host is probed once that host confirms it,
  and the API category is evaluated at the hosts the site's API catalog names. Each result lists the declared hosts and
  the host behind each check.
- An MCP endpoint that requires sign-in scores as present, and three checks score the sign-in itself.
- stripe.dev joins the curated website board.

### Changed

- Website audits send no plaintext request, so a surface reachable only over `http` never scores above a missing one.
  The [web scorecard schema](/web-scorecard-schema) moves to 0.5, which only adds fields.

### Fixed

- `www.anc.dev` redirects to `anc.dev`.
- An MCP probe answered 408 or 429 reads as an operational error, an OpenAPI description larger than 512 KiB counts as
  present, and the score copy says what the relative and global scores count.

## 2026-09-30

### Added

- Website results group their MCP checks into four protocol lanes (every MCP server, the legacy lane, the modern lane,
  and in-page WebMCP tools), each with its own pass count, on the result page and in its markdown twin.

### Removed

- The `GET /api/score`, `/api/score.json`, and `/api/score.md` read lane. A scorecard reads at `/score/<target>`;
  `POST /api/score` is unchanged.

### Fixed

- Website check rows are readable at phone width.

## 2026-09-15

### Added

- One audit form for CLIs and websites, on the homepage and [/audit](/audit), one progress page, and one result route at
  `/score/<target>` that serves the page, its markdown twin, and JSON. MCP tools return the same result, and a second
  request for a target already being audited joins the running audit.
- Structured data names the site, its breadcrumb trail, and its contact, and the rendered breadcrumb reads from the same
  trail.

### Changed

- [/scorecards](/scorecards) carries the CLI and website leaderboards behind one segment control, and the per-check fix
  skills move to `/fix`.

### Removed

- `/check`, `/web`, `/web/scoring`, `/score/live/<binary>`, and `POST /api/audit-web`. `/web-audit` and `/web/<host>`
  redirect to the new routes; the rest answer 404.

## 2026-09-08

### Fixed

- The install-command copy button uses a defined color token.
- Score endpoints send a `Vary` header that matches what each one negotiates.
- The live-score error panel scrolls by keyboard without scrolling the page behind it.
- A website audit that only the network edge answered reads unreachable instead of scoring the edge's replies.

## 2026-09-04

### Added

- Website result pages give in-page agents a repair queue: the WebMCP tools `get_fix_prompts` and `get_audit_summary`, a
  worksheet filtered by check, keyword, and status, and `cached`, `scored_at`, and `refresh_after` on every per-target
  response.

### Changed

- Audit probes identify themselves with an `anc-web-audit/1.0` User-Agent, and a site that refuses an identified agent
  has the refusal scored as evidence.
- Leftover `/.well-known/mcp.json` and `/mcp.json` aliases score as their own MAY check.

### Fixed

- Audits of sites that block or never answer finish with evidence or a "target unreachable" error, instead of hanging or
  saving a 0% scorecard. The scoring page offers a retry when its verification challenge stalls.
- Every link the site emits resolves from the origin serving the request.

## 2026-08-28

### Added

- The MCP server serves both the legacy `initialize` handshake and the header-routed 2026-07-28 lane, so modern clients
  connect without a handshake. All 13 tools carry a `title` and behavior annotations.
- The website audit scores MCP protocol eras separately, with conformance probes for each era's error codes and for
  whether a server honors the `Accept` header it advertises.

### Changed

- A working but nonconforming MCP surface scores above a hidden one.

### Fixed

- Scorecard code blocks scroll by keyboard on a narrow screen, and the homepage Score field wraps instead of pushing the
  page into horizontal scroll.

## 2026-08-25

### Added

- Agents and CLI clients get markdown on extensionless URLs, and authored markdown twins carry YAML frontmatter.
- Website audit checks for agent recovery and content honesty (404 behavior, content without JavaScript, reachability
  under agent User-Agents, llms.txt quality, API errors and rate-limit headers, MCP resources), markdown-for-agents and
  frontmatter checks, and an assemble-prompt control on result pages.
- On-demand website audits can opt into the public board.

### Changed

- Negotiated HTML and markdown keep `Vary: Accept, User-Agent` visible to clients, and badges move to badge-maker v6.

### Fixed

- `/llms.txt` and other single-representation files answer on their own path, and a cached website scorecard serves the
  full result.

## 2026-07-18

### Added

- The website leaderboard refreshes weekly and after each deploy, and covers more curated sites.

### Changed

- Website scorecards split "MCP & API" into separate API and MCP categories, and show each check's MUST, SHOULD, or MAY
  tier on its own row.

### Fixed

- A change to the audit registry's shape reflows every cached scorecard on the next rescore.

## 2026-07-15

### Changed

- The homepage `Link` header and a `<noscript>` block on every page name the site's machine entry points, so agents find
  them without running JavaScript.

### Fixed

- The website check `mcp-get-fast-fail` passes a documented `GET` surface on an MCP endpoint. The API-surface check
  stays not applicable for MCP-first sites, and a `sitemap.xml` counts as an API-surface signal.

## 2026-07-14

### Added

- The website agent-readiness audit: enter a domain, watch each check stream in, and share the result page and its
  markdown twin. It checks the site's MCP server, `.well-known` cards, `llms.txt`, content negotiation, robots, and
  DNS-AID.
- Four website tools on the MCP server (`audit_website`, `get_website_audit`, `list_website_audits`,
  `get_web_remediation`), a fix-skill page for every check, a website leaderboard, and the
  [web scorecard schema](/web-scorecard-schema).

### Changed

- Every page uses the shared design system: color, type, and spacing come from design tokens.

### Fixed

- Markdown twins carry no form controls, so `Accept: text/markdown` returns clean prose.
- The website audit form passes its verification challenge on submit, and an audit of anc.dev no longer reports its own
  files as broken.

## 2026-06-23

### Added

- Agent discovery files: a SEP-1649 MCP server card at `/.well-known/mcp/server-card.json`, an
  [API catalog](/.well-known/api-catalog), an agent-skills index, OAuth discovery metadata, and [/auth.md](/auth.md),
  which states the programmatic surfaces need no authentication.
- A WebMCP script exposes the site's tools to in-page agents.

### Changed

- The MCP server card takes the SEP-1649 shape: `transport` becomes an object, and the spec revision moves to
  `protocolVersion`.

## 2026-06-08

### Added

- The homepage names the three ways to use the standard: install `anc`, install the [skill bundle](/skill), or connect
  to the MCP server.
- Every page declares its markdown twin, `/llms.txt`, `/llms-full.txt`, the MCP descriptor, and `/skill.json` in
  `<link rel>` tags, and its JSON-LD describes the MCP server, the `anc` CLI, and the skill bundle.
- An MCP server page with HTML, markdown, and JSON forms, and a server descriptor at `/.well-known/mcp` and `/mcp.json`
  whose URLs name the serving origin.

## 2026-06-06

### Added

- An MCP server at `POST /mcp` with nine tools for the registry, principles, spec sections, and scorecards, live CLI
  audits included, and a client guide at [/mcp-skill](/mcp-skill).

## 2026-06-02

### Added

- Cursor and xAI Grok Build join the leaderboard in the agent tier.

### Changed

- The principle pages move to spec v0.5.0, and the footer shows v0.5.0. Every page is revised: [P1](/p1), [P2](/p2),
  [P3](/p3), [P4](/p4), [P5](/p5), [P6](/p6), [P7](/p7), and [P8](/p8). P3 gains a MUST that `--version` prints a
  version line and exits 0, and a SHOULD for a short alias.
- `check` becomes `audit` across the site: `/check` redirects to [/audit](/audit), and scorecards and twins name
  `anc audit`.
- The curated scorecards are scored again with anc 0.5.0, scorecard pages show `opt_out` and `n_a` statuses, and badges
  use five score bands.
- The live-scoring form's examples cover each supported input kind, and a live result reads at `/score/live/<binary>`
  with a markdown twin.

## 2026-05-25

### Added

- Live scoring: paste an install command or a GitHub URL into the homepage form, and the site installs the tool in a
  sandbox container, audits it with anc 0.4.0, and returns a scorecard with a shareable result URL.
- The header links Skill and Contribute, and the footer links the four source repositories.
- JSON-LD on every page names the publishing organization and author.

## 2026-05-15

### Added

- [P8: Discoverable Through Agent Skill Bundles](/p8), the eighth principle.

### Changed

- The principle pages move to spec v0.4.0, and the footer shows v0.4.0. [P1](/p1) requires a secret input path that
  stays out of process listings, [P2](/p2) adds a runtime-discoverable output schema and `--json` aliases, [P4](/p4)
  asks for a concrete remediation and the valid values on a rejected enum, [P6](/p6) adds SIGTERM handling and
  community-standard names, and [P7](/p7) asks that the list ceiling be documented.

### Fixed

- The `cf` registry entry points at its npm page, and [its scorecard](/score/cf) shows the corrected entry.

## 2026-05-03

### Changed

- The footer shows the spec version the principle pages are written to, v0.3.0, and each badge shows the spec version
  its scorecard was scored against.
- The 96 curated scorecards are scored again with anc 0.3.0.

### Removed

- The commit pin and `verify` block in `/skill.json`, and `anc.commit` in scorecards.

### Fixed

- Scorecard pages no longer link to a wrong `agentnative-cli` commit, the reproduce block in each scorecard's markdown
  twin is tagged `bash`, and `/skill.json` reports the published skill version.

## 2026-05-01

### Added

- anc.dev publishes the agent-native CLI standard: seven principles, [P1](/p1) through [P7](/p7), each with MUST,
  SHOULD, and MAY requirements.
- The ANC 100 leaderboard at [/scorecards](/scorecards) scores 96 widely used CLIs, with a scorecard page per tool, the
  [methodology](/methodology), the [coverage](/coverage) matrix, and the [scorecard schema](/scorecard-schema).
- [Badges](/badge) for scored tools, an [install](/install) page for `anc`, and a [skill](/skill) page with
  `/skill.json`.
- Every page has a markdown twin at its `.md` URL or through `Accept: text/markdown`, plus [/llms.txt](/llms.txt) and
  [/llms-full.txt](/llms-full.txt).
