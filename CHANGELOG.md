# Changelog

All notable changes to this project will be documented in this file.

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
