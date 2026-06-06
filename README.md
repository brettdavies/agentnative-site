# agentnative-site

Source for [anc.dev](https://anc.dev), the public surface for the agent-native CLI standard. The site publishes the
eight principles of the standard, the ANC 100 leaderboard, per-tool curated scorecards, a live-scoring form, the score
badge surface, and the agent-native-cli skill bundle distribution endpoint.

## What it serves

| Route                                                               | Purpose                                                                 |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `/`                                                                 | Homepage with the principle index and a live-score form to `/api/score` |
| `/scorecards`                                                       | The ANC 100 leaderboard (every curated tool, sortable)                  |
| `/score/<tool>`                                                     | Per-tool curated scorecards (renders from `scorecards/<tool>.json`)     |
| `/score/live/<binary>`                                              | Shareable live-score result pages backed by the R2 score cache          |
| `/audit`, `/install`, `/methodology`, `/badge`, `/scorecard-schema` | Supporting pages on usage, install, scoring methodology, badge, schema  |
| `/contribute`, `/about`                                             | Contribution map and attribution                                        |
| `/skill`                                                            | Human-facing install for the `agent-native-cli` skill bundle            |
| `/skill.json`                                                       | Canonical machine-primary skill manifest                                |
| `POST /mcp`                                                         | Model Context Protocol server; client skill at `/mcp-skill.md`          |
| `/llms.txt`, `/llms-full.txt`                                       | llmstxt.org convention (summary index plus full concatenated spec)      |

Every HTML page has a markdown twin reachable via `.md` suffix or `Accept: text/markdown` content negotiation. Agents
reach anc.dev's data programmatically via `POST /mcp`; the client integration guide lives at
[`/mcp-skill.md`](https://anc.dev/mcp-skill.md).

## Scoring

Per-tool scorecards display a behavioral-layer compliance score: each requirement is credited by outcome (a met
requirement counts full, a partially-met SHOULD or MAY counts half, a missed MUST or a deliberate opt-out counts zero),
while inapplicable and unmeasured checks are excluded so they neither help nor hurt. MUST-tier misses are `fail`;
SHOULD- or MAY-tier misses are `warn`. Badge eligibility starts at 70%. Full formula, the seven-status taxonomy, and the
cohort bands at [`/methodology`](https://anc.dev/methodology); per-field JSON schema at
[`/scorecard-schema`](https://anc.dev/scorecard-schema); badge contract at [`/badge`](https://anc.dev/badge). The
scoring engine itself lives in [`agentnative-cli`](https://github.com/brettdavies/agentnative-cli).

## Stack

Cloudflare Worker over Static Assets. Build pipeline renders markdown in `content/` to HTML at `dist/` via `bun
src/build/build.mjs`. Live scoring runs in a Cloudflare Sandbox Durable Object, cached in R2, rate-limited by KV, and
gated by Turnstile. Full inventory in [`wrangler.jsonc`](./wrangler.jsonc); design contract in
[`DESIGN.md`](./DESIGN.md).

## Local development

```bash
bun install
bun run build              # produces dist/
bun run dev                # bun run build && wrangler dev --env staging --local --port 8787 (http://localhost:8787)
bun test                   # unit + regression
bun run test:e2e           # Playwright
```

`bun run dev` is the only valid local preview. Static-file servers (`python -m http.server`, `serve`, `npx http-server`)
bypass the Worker and produce a false preview — see [AGENTS.md → Local dev](AGENTS.md#local-dev).

After cloning, point git at the repo's hooks once:

```bash
git config core.hooksPath scripts/hooks
```

This enables `scripts/hooks/pre-push`, which runs the seven local gates before every push: `lint`, `build`, `tests`,
`wrangler deploy --dry-run`, pack-README drift, banned-fonts scan, and `scripts/prose-check.sh` (Vale plus LanguageTool
when reachable). CI enforces stages 1 through 4; stages 5 through 7 are pre-push only.

## Branch and release model

Feature branches PR to `dev`. Production cuts via `release/<YYYY-MM-DD>-<slug>` cherry-picked from `dev` to `main`.
`deploy.yml` ships `main` to `anc.dev` on push. The full procedure lives in [`RELEASES.md`](./RELEASES.md); rationale in
[`RELEASES-RATIONALE.md`](./RELEASES-RATIONALE.md).

## Documentation map

| File                                                                                | Purpose                                                       |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| [`AGENTS.md`](./AGENTS.md)                                                          | Agent-facing project brief: scope, voice, structure, surfaces |
| [`CONTRIBUTING.md`](./CONTRIBUTING.md)                                              | Contribution tiers, dev setup, pre-push hook, PR conventions  |
| [`DESIGN.md`](./DESIGN.md)                                                          | Visual and structural design contract                         |
| [`BRAND.md`](./BRAND.md)                                                            | Voice, positioning, naming                                    |
| [`PRODUCT.md`](./PRODUCT.md)                                                        | Product framing and roadmap context                           |
| [`RELEASES.md`](./RELEASES.md) / [`RELEASES-RATIONALE.md`](./RELEASES-RATIONALE.md) | Release runbook plus its reasoning                            |
| [`docs/runbooks/`](./docs/runbooks/)                                                | Operational runbook set (live-scoring, analytics, deploy)     |

## Related repositories

- [agentnative](https://github.com/brettdavies/agentnative): the canonical spec (principle text, pressure-tests,
  versioning policy)
- [agentnative-cli](https://github.com/brettdavies/agentnative-cli): `anc`, the CLI linter and scoring engine, plus the
  tool registry
- [agentnative-skill](https://github.com/brettdavies/agentnative-skill): the `agent-native-cli` skill bundle, installed
  via [anc.dev/skill](https://anc.dev/skill)

## Contributing

Three shapes of contribution, in order of cost:

1. **Signal** (site bug, rendering issue, broken link, copy critique, mobile-layout or performance regression): file an
   issue with the matching template at
   [github.com/brettdavies/agentnative-site/issues/new/choose](https://github.com/brettdavies/agentnative-site/issues/new/choose).
2. **Proposal** (new page or section, scorecard renderer rework, Worker route addition, build-pipeline change,
   live-scoring surface change): open a design issue first; the maintainer signs off before code lands.
3. **Code**: PR against `dev` (per branch discipline).

Local setup:

```bash
git clone https://github.com/brettdavies/agentnative-site
cd agentnative-site
git config core.hooksPath scripts/hooks  # mirror CI locally on every push
bun install
bun run build
bun test
```

The full tier breakdown, pre-push hook contents, and PR conventions live in [`CONTRIBUTING.md`](./CONTRIBUTING.md).
Cross-repo routing: principle-level discussion (MUST/SHOULD/MAY tier changes, new principles, applicability clauses)
goes to the [spec repo](https://github.com/brettdavies/agentnative/issues/new/choose); scoring-engine and registry work
to [agentnative-cli](https://github.com/brettdavies/agentnative-cli/issues/new/choose); skill bundle changes to
[agentnative-skill](https://github.com/brettdavies/agentnative-skill/issues/new/choose).

## License

See [`LICENSE`](./LICENSE).
