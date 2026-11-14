# Changelog

All notable changes to this project will be documented in this file.

## [0.0.1794552806-gcc795eb] - 2026-11-13

### Added

- Add `title`, `description`, `websiteUrl`, and `icons` to the MCP server's `serverInfo`, on the legacy `initialize` result and in every modern result's `_meta`. by @brettdavies in [#578](https://github.com/brettdavies/agentnative-site/pull/578)
- Add `icons` to the SEP-2127 server card at `/mcp/server-card`.
- Add the `set_website_public_listing` MCP tool, which opts a site in to or out of the public website leaderboard and does nothing else. by @brettdavies in [#579](https://github.com/brettdavies/agentnative-site/pull/579)
- Add a `web-listing.change` log record for each listing change `set_website_public_listing` applies, so Workers Logs shows when and for which site a listing changed through MCP. by @brettdavies in [#580](https://github.com/brettdavies/agentnative-site/pull/580)

### Changed

- Change the MCP server's title and description, on both server cards and the handshake, to cover website scoring and the leaderboards alongside CLI scoring and the principles. by @brettdavies in [#578](https://github.com/brettdavies/agentnative-site/pull/578)
- Change `audit_website` so it no longer accepts `public_listing`; a call that sends it is refused with a pointer to `set_website_public_listing`, and an audit never changes a site's listing. by @brettdavies in [#579](https://github.com/brettdavies/agentnative-site/pull/579)
- Change `audit_website` to refuse any argument it does not declare, where it ignored one before.
- Change every MCP tool to refuse an argument it does not declare, with `isError: true` and an `Input validation error` message naming the key, where the tool ignored the argument before. by @brettdavies in [#582](https://github.com/brettdavies/agentnative-site/pull/582)
- Change the eleven read tools to declare `idempotentHint: true`.

### Fixed

- Fix a held followed website audit writing back a listing it resolved before the run, so it keeps the listing stored when it writes. by @brettdavies in [#581](https://github.com/brettdavies/agentnative-site/pull/581)

### Removed

- Remove `search_tools`' `principle_min_score`, which filtered nothing. by @brettdavies in [#582](https://github.com/brettdavies/agentnative-site/pull/582)

**Full Changelog**: [v0.0.1794455323-g5392089...v0.0.1794552806-gcc795eb](https://github.com/brettdavies/agentnative-site/compare/v0.0.1794455323-g5392089...v0.0.1794552806-gcc795eb)

## [0.0.1794455323-g5392089] - 2026-11-12

### Added

- Add the standard `title`, `description`, `url`, and `dateModified` frontmatter keys to `/scorecards.md`, `/coverage.md`, `/skill.md`, and every `/score/<target>` markdown twin. by @brettdavies in [#573](https://github.com/brettdavies/agentnative-site/pull/573)
- Add `dateModified` and `article:modified_time` to website, live CLI, and branch scorecard pages, giving the day the scoring ran.

### Changed

- Change the sitemap so each curated website scorecard carries a `<lastmod>`: the day its audit ran. by @brettdavies in [#573](https://github.com/brettdavies/agentnative-site/pull/573)
- Change the dates on `/` and `/scorecards`, in the sitemap, JSON-LD, `article:modified_time`, and the twin, to the later of the page's own content date and the newest website audit its board shows.

### Fixed

- Fix the `/scorecards` description, which said the scores run against seven agent-native principles; the standard has eight. by @brettdavies in [#573](https://github.com/brettdavies/agentnative-site/pull/573)

**Full Changelog**: [v0.0.1794452714-g3b6a03d...v0.0.1794455323-g5392089](https://github.com/brettdavies/agentnative-site/compare/v0.0.1794452714-g3b6a03d...v0.0.1794455323-g5392089)

## [0.0.1794452714-g3b6a03d] - 2026-11-12

### Added

- Add a `dateModified` key to the markdown twin frontmatter of the homepage, the principle pages, and the content sub-pages, giving the day the page's content last changed. by @brettdavies in [#569](https://github.com/brettdavies/agentnative-site/pull/569)
- Add `dateModified` to each page's `TechArticle` JSON-LD node, and an `article:modified_time` meta tag, carrying the same date.

### Changed

- Change `/changelog` to record what changed on anc.dev, release by release since launch, with a link to the spec repository's changelog for the standard's own history. by @brettdavies in [#568](https://github.com/brettdavies/agentnative-site/pull/568)
- Change each sitemap `<lastmod>` from the build date to the day the page's content last changed. A curated CLI scorecard page uses the day its audit ran. A seeded website result is listed without a `<lastmod>`. by @brettdavies in [#569](https://github.com/brettdavies/agentnative-site/pull/569)

**Full Changelog**: [v0.0.1794439906-g7cd7f26...v0.0.1794452714-g3b6a03d](https://github.com/brettdavies/agentnative-site/compare/v0.0.1794439906-g7cd7f26...v0.0.1794452714-g3b6a03d)

## [0.0.1794439906-g7cd7f26] - 2026-11-11

### Added

- Web audits treat `www.<domain>` and `<domain>` as one site when either redirects to the other; the scorecard is stored and shown under `<domain>`, `/score/www.<domain>` answers 301, scorecards gain an optional `site_hosts` field, and the unreachable error names a `www.` or bare host that answered. by @brettdavies in [#557](https://github.com/brettdavies/agentnative-site/pull/557)
- Add the site's IndexNow key file at the root. by @brettdavies in [#565](https://github.com/brettdavies/agentnative-site/pull/565)

### Fixed

- Fix `score_cli` starting a live container audit while the `scoring_disabled` kill switch is on; it now answers as it does with live scoring disabled. by @brettdavies in [#552](https://github.com/brettdavies/agentnative-site/pull/552)
- Fix `score_cli`'s live-scoring-disabled answer to carry `next_tool: "get_scorecard"`, as documented.
- Fix a second audit from the same IP within one second failing with `service_misconfigured` (browser and API) or a raw storage error (`score_cli`); the counter write retries once, and a third audit started at the same moment is told to retry in 2 seconds instead of being told the hourly limit is spent. by @brettdavies in [#553](https://github.com/brettdavies/agentnative-site/pull/553)
- Fix a board rebuild dropping a site from the web leaderboard when its stored record could not be read; the site keeps its existing row. by @brettdavies in [#555](https://github.com/brettdavies/agentnative-site/pull/555)
- Fix a failed operator alert email suppressing the next alert for the same failure for an hour. by @brettdavies in [#556](https://github.com/brettdavies/agentnative-site/pull/556)
- Fix the `/mcp` `tools/list` response so each of the eleven read tools declares `destructiveHint: false` and `openWorldHint: false` beside `readOnlyHint: true`, giving every tool all three behavior hints as booleans. by @brettdavies in [#558](https://github.com/brettdavies/agentnative-site/pull/558)
- Fix a CLI scorecard page answering 404 "No audit exists" when its stored record could not be read; it now answers 503 with `Retry-After`, and so does its social card. by @brettdavies in [#559](https://github.com/brettdavies/agentnative-site/pull/559)
- Fix two `score_cli` calls for the same input running two container audits; the second call now waits for the first run and is answered from its result. by @brettdavies in [#560](https://github.com/brettdavies/agentnative-site/pull/560)
- The MCP server instructions now fit the 4,096 characters Claude Code delivers whole, and lead with what the server is for, the guide link, which tool to call first, and what a website audit sends to third-party hosts. The `audit_website` description carries the short third-party disclosure, and its `follow_declarations` parameter carries the full one. by @brettdavies in [#563](https://github.com/brettdavies/agentnative-site/pull/563)
- Fix the `/mcp` server instructions to lead with the purpose, the cache-first sequence with both metered-audit quotas, and the shared 60-per-60-seconds limit, and drop the result-shape paragraph. by @brettdavies in [#564](https://github.com/brettdavies/agentnative-site/pull/564)

### Documentation

- Document `scoring_disabled` as the switch that stops every live CLI audit, with `MCP_LIVE_SCORING_ENABLED` as the MCP-only switch. by @brettdavies in [#552](https://github.com/brettdavies/agentnative-site/pull/552)

**Full Changelog**: [v0.0.1794364986-ga6ad604...v0.0.1794439906-g7cd7f26](https://github.com/brettdavies/agentnative-site/compare/v0.0.1794364986-ga6ad604...v0.0.1794439906-g7cd7f26)

## [0.0.1794364986-ga6ad604] - 2026-11-11

### Fixed

- Fix the web audit reading an MCP server card that says `required: false` and lists no scheme as declaring authentication; `oauth-protected-resource`, `oauth-discovery` and `auth-md` now read not applicable for that open server. by @brettdavies in [#547](https://github.com/brettdavies/agentnative-site/pull/547)
- Remove the OAuth discovery metadata anc.dev published for its MCP server (`/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`, `/.well-known/jwks.json`, and the `POST /oauth2/token` stub). The server needs no sign-in, and the metadata told clients it did. Each path now answers 404 like any unknown path; `/auth.md` and the server card's `authentication.required: false` remain the statement of the no-auth posture. by @brettdavies in [#548](https://github.com/brettdavies/agentnative-site/pull/548)

**Full Changelog**: [v0.0.1794347407-g9c1e97a...v0.0.1794364986-ga6ad604](https://github.com/brettdavies/agentnative-site/compare/v0.0.1794347407-g9c1e97a...v0.0.1794364986-ga6ad604)

## [0.0.1794347407-g9c1e97a] - 2026-11-10

### Fixed

- Fix MCP clients on the 2026-07-28 protocol timing out on connect when they open a `subscriptions/listen` stream. by @brettdavies in [#543](https://github.com/brettdavies/agentnative-site/pull/543)

### Documentation

- Note in the MCP client skill that `subscriptions/listen` always answers an open `text/event-stream`, whatever the `Accept` value. by @brettdavies in [#543](https://github.com/brettdavies/agentnative-site/pull/543)

**Full Changelog**: [v0.0.1794281993-gc008640...v0.0.1794347407-g9c1e97a](https://github.com/brettdavies/agentnative-site/compare/v0.0.1794281993-gc008640...v0.0.1794347407-g9c1e97a)

## [0.0.1794281993-gc008640] - 2026-11-10

### Added

- Add search indexing for a repo's default-branch scorecard page when the tool earns the agent-native badge. by @brettdavies in [#518](https://github.com/brettdavies/agentnative-site/pull/518)
- Add a link from a CLI scorecard with no repo or homepage to its package's registry page. by @brettdavies in [#534](https://github.com/brettdavies/agentnative-site/pull/534)
- Add a `sandbox_busy` error to the score API, returned with HTTP 503 and the message "The scoring sandbox is busy. Try again in a minute." when no container can be started. by @brettdavies in [#539](https://github.com/brettdavies/agentnative-site/pull/539)

### Changed

- Change website scorecard pages for on-demand audits to be indexable by search engines when the headline score is 70 or more. by @brettdavies in [#520](https://github.com/brettdavies/agentnative-site/pull/520)
- Change the live-scoring image to carry an unprivileged audit user and an execute-only auditor. by @brettdavies in [#532](https://github.com/brettdavies/agentnative-site/pull/532)
- Change live CLI scoring to install and audit each tool as an unprivileged user, with the audit in its own network namespace. by @brettdavies in [#536](https://github.com/brettdavies/agentnative-site/pull/536)
- Change pasted install commands to accept registry package names only. A URL, git form, or path returns `unparseable_install_command`.
- Change live CLI audits to run in a new container for each run, keyed to the audit's target. by @brettdavies in [#539](https://github.com/brettdavies/agentnative-site/pull/539)

### Fixed

- Fix the audit progress page loading the WebMCP in-page tool script, which that page must never load. Live CLI results and the no-audit page stop loading it too, and website results load it once instead of twice. by @brettdavies in [#512](https://github.com/brettdavies/agentnative-site/pull/512)
- Fix JSON-LD on result pages so breadcrumb text stays inside its script element. by @brettdavies in [#514](https://github.com/brettdavies/agentnative-site/pull/514)
- Fix the markdown twins of not-found and progress pages so a target stays inside its code span.
- Fix on-demand CLI scorecards staying out of search results when the tool earns the agent-native badge. by @brettdavies in [#517](https://github.com/brettdavies/agentnative-site/pull/517)
- Fix outbound links from anc.dev to tell the destination site that the visit came from anc.dev. by @brettdavies in [#525](https://github.com/brettdavies/agentnative-site/pull/525)
- Fix a scorecard's link to the audited site or tool so it tells that site which scorecard the visitor came from. by @brettdavies in [#526](https://github.com/brettdavies/agentnative-site/pull/526)
- Fix scorecard pages so the badge score, result status, and coverage counts are HTML-escaped like every other scorecard field. by @brettdavies in [#528](https://github.com/brettdavies/agentnative-site/pull/528)
- Fix live CLI scoring so a run stores only a scorecard that matches anc's published shape. by @brettdavies in [#529](https://github.com/brettdavies/agentnative-site/pull/529)
- Fix live CLI scoring so a direct install cannot be audited under the auditor's own name. by @brettdavies in [#531](https://github.com/brettdavies/agentnative-site/pull/531)
- Fix scorecard pages keeping inbound tracking parameters in the address: they now drop any query parameters on load. by @brettdavies in [#535](https://github.com/brettdavies/agentnative-site/pull/535)
- Fix pages whose text contains a `$` sequence so the text renders as written. by @brettdavies in [#537](https://github.com/brettdavies/agentnative-site/pull/537)
- Fix pages whose text spells a template token, such as `{{BODY}}`, so the text renders as written and the page's JSON-LD stays valid.
- Fix the homepage web board and website audit probe paths so a `$` sequence in a site's title or declared MCP endpoint stays as written.

**Full Changelog**: [v0.0.1793762860-g031ec6e...v0.0.1794281993-gc008640](https://github.com/brettdavies/agentnative-site/compare/v0.0.1793762860-g031ec6e...v0.0.1794281993-gc008640)

## [0.0.1793762860-g031ec6e] - 2026-11-09

### Added

- Add a social card for every scorecard page: a 1200×630 image with the ANC × brand lockup, the score in its band color, and the audit date or tool version, linked from the page's Open Graph and Twitter card tags. by @brettdavies in [#461](https://github.com/brettdavies/agentnative-site/pull/461)
- Add `x-anc-card` and `x-anc-card-logo` response headers on scorecard card images, naming whether the card was drawn or read from storage and where its logo came from.
- Add og:video clips to scorecard pages: a finished scorecard gets a ~3.5 s 1200x630 MP4 that counts up to its score, named in `og:video` once it exists and served at `/og/clip/<target>/<key>.mp4`. by @brettdavies in [#482](https://github.com/brettdavies/agentnative-site/pull/482)
- Add the `OG_VIDEO_ENABLED` switch, which stops every clip render without a deploy while pages keep naming the clips that exist.
- Add `scripts/og/setup.sh` and `scripts/og/status.sh`, with prose output and a `--json` result contract, to set og:video up per environment and to diagnose one scorecard's card and clip.
- Add the `x-anc-clip` and `x-anc-clip-run` diagnostic headers on scorecard pages.
- Add a "Flag names" section to `/about` that states how a requirement's double-dash flag name applies to tools whose help uses single-dash flags, and that a single-letter flag meets only a requirement naming that letter. by @brettdavies in [#486](https://github.com/brettdavies/agentnative-site/pull/486)

### Changed

- Change scorecard card drawing to a separate render Worker; a card the render Worker cannot draw falls back to the site's default card with `x-anc-card: fallback`. by @brettdavies in [#482](https://github.com/brettdavies/agentnative-site/pull/482)
- Change curated scorecard pages to carry `Cache-Tag: cli:<slug>`, purged when their clip lands.
- Change P2, P3, and P5 to the v0.7.0 rules: a documented introspection command such as `kubectl explain` satisfies the runtime-schema requirement, a documented confirmation flag such as `-auto-approve` on `terraform destroy` satisfies the destructive-operation requirement (`schema` / `--schema` and `--yes` / `--force` stay the recommended names), and the per-subcommand example requirement exempts subcommands whose usage line is their whole call shape (`tool version`, `tool logout`). by @brettdavies in [#486](https://github.com/brettdavies/agentnative-site/pull/486)
- Change the site's reconciled spec version, shown in the footer and on the social card, to v0.7.0.
- Change live CLI scoring on staging to anc 0.7.0. `anc audit` exits 3 when an audit errored or none applied; a scorecard it prints is still scored. by @brettdavies in [#488](https://github.com/brettdavies/agentnative-site/pull/488)
- Change every CLI scorecard to anc 0.7.0. The P8 skill-bundle rows read not applicable for a tool with no bundle, flags count only where an option definition declares them, and an output flag no safe probe can validate reads skip, so 70 tools score lower, 19 higher, and 60 hold the badge.
- Change live CLI scoring so a run whose scorecard reports an errored audit is shown but not saved: the next request for the tool scores it fresh, and the progress page says why the result has no page. by @brettdavies in [#490](https://github.com/brettdavies/agentnative-site/pull/490)

### Fixed

- Fix a GitHub repo URL entered in the audit form, such as `https://github.com/owner/repo`, stopping at "That target has no result page" instead of running the audit, and `github.com/owner/repo` failing as unrecognized input. Every spelling of a repo URL now audits the repo it names. by @brettdavies in [#483](https://github.com/brettdavies/agentnative-site/pull/483)
- Fix `scripts/og/smoke.sh` starting its live fixture deploy on anc.dev for `--help`, a missing argument, or an argument that is not an `http://` or `https://` URL; it now prints the usage and exits before any deploy. by @brettdavies in [#485](https://github.com/brettdavies/agentnative-site/pull/485)
- Fix `scripts/og/setup.sh` and `scripts/og/status.sh` printing only their usage text for a bad argument, even under `--json`; they now name the argument and, with `--json`, return the `usage` reason (exit 2).
- Fix principle pages so every "Measured by" list names the audit IDs `anc` reports, and P1, P2, P3, P4, P6, and P7 no longer add conditions, exemptions, or requirements the standard does not have, including P3's top-level example count (2–3) and P1's headless-auth scope (any CLI that authenticates against a remote service). by @brettdavies in [#486](https://github.com/brettdavies/agentnative-site/pull/486)
- Fix `/coverage` and the MCP catalog's requirement summaries for P2's schema surface, P3's subcommand examples, and P5's confirmation flag, which still stated the 0.6.0 rules.
- Fix the scorecard schema page's `evidence` field, which anc 0.7.0 fills on passing rows. by @brettdavies in [#488](https://github.com/brettdavies/agentnative-site/pull/488)
- Fix release changelog entries for PRs whose descriptions use Windows (CRLF) or old Mac (CR) line endings: their bullets no longer break across two lines, and their changelog section is no longer replaced by the PR title. by @brettdavies in [#493](https://github.com/brettdavies/agentnative-site/pull/493)

### Documentation

- Document the scorecard card key, edition, logo lookup, storage, and fonts in `DESIGN.md` §4.13, and the og-cards smoke in `RELEASES-PREFLIGHT.md`. by @brettdavies in [#461](https://github.com/brettdavies/agentnative-site/pull/461)
- Document og:video in `AGENTS.md`, its setup, switch, purge rate and cost watch in `RELEASES.md`, its reason codes in `RELEASES-PREFLIGHT.md`, its iMessage and Discord playback check in `RELEASES-POSTFLIGHT.md`, and the clip, purge and template bump rules in `DESIGN.md` §4.13. by @brettdavies in [#482](https://github.com/brettdavies/agentnative-site/pull/482)
- Document the production og:video enable sequence in the release checklists: `setup.sh production` before the first og:video release merges, then setup, the switch, the curated pass and a check after its deploy. by @brettdavies in [#485](https://github.com/brettdavies/agentnative-site/pull/485)
- Define the curated pass in `CONCEPTS.md`. by @brettdavies in [#487](https://github.com/brettdavies/agentnative-site/pull/487)
- Document in the MCP client guide that a fresh CLI audit reporting an errored audit returns null URLs and is not cached. by @brettdavies in [#490](https://github.com/brettdavies/agentnative-site/pull/490)
