# Agent-native badge

The agent-native badge is a small SVG that lets a CLI author advertise agent-native conformance on their tool's README.
It links to the live scorecard for that tool, so any reader can follow the claim to current evidence rather than trust a
self-declaration.

This page is the convention. It defines what claiming the badge means, what it does not mean, and how the URL behaves
when a tool's score changes.

## What the badge looks like

The badge is rendered at build time and served as a static SVG. The site does not use shields.io, has no third-party
render dependency, and requires no account. The renderer is [`badge-maker`](https://www.npmjs.com/package/badge-maker),
the same library shields.io uses internally. Visually identical output, fully self-hosted.

For a tool named `<tool>`:

```text
https://anc.dev/badge/<tool>.svg
```

The label reads `agent-native vMAJOR.MINOR` (the spec version the score is rooted in); the message is the rounded
percent score; the color tracks the same green / yellow / red bands the [leaderboard](/scorecards) uses.

## How to embed it

```markdown
[![agent-native](https://anc.dev/badge/<tool>.svg)](https://anc.dev/score/<tool>)
```

Replace `<tool>` with the tool's slug: the same name that appears on the leaderboard and in the registry. The badge
links to the tool's per-tool scorecard page so a reader who clicks lands on the live evidence.

Per-tool scorecard pages whose tool clears the eligibility floor render this snippet inline, ready to copy.

## Eligibility: the floor

A tool may legitimately embed the badge when its score is **80% or higher**.

The floor is the brightline at the top quartile of the launch corpus. It captures tools that took agent-readiness
seriously, not tools that scored marginally. A tool below the floor can still link to its scorecard page (that is the
public-by-default posture of the standard), but should not embed the badge as a quality signal until it clears 80%.

The floor is enforced by the per-tool scorecard page, not by the SVG endpoint. The SVG is rendered for every scored tool
regardless of score. This is intentional: a tool that already embedded the badge should see the visual color shift if
its score regresses, not a 404.

## Score format: `XX%`

The score on the badge is the same pass-rate the leaderboard reports: `pass / (pass + warn + fail)`, rounded to the
nearest integer percent.

`91/100` and `6/7 principles` were both considered and rejected. The rounded percent reads cleanest at badge size and
matches the leaderboard's score column so a reader sees the same number across surfaces.

## Color bands

| Range     | Color       | What it means                                                |
| --------- | ----------- | ------------------------------------------------------------ |
| 80–100%   | brightgreen | Eligible; meets or exceeds the badge floor                   |
| 60–79%    | yellow      | Decent agent-readiness with meaningful gaps                  |
| Below 60% | red         | Significant gaps; the per-tool page lists the failing checks |

Tools below the floor still receive a rendered SVG so an embedded badge stays honest after a regression.

## Version pinning: URL always-latest, label cites the spec

The URL `/badge/<tool>.svg` always reflects the tool's most recent score against the most recent published spec. The
spec version baseline is carried in the badge **label** (e.g., `agent-native v0.3`), not in the URL.

This is a deliberate trust-and-verify choice. A tool author embeds the badge once; the score and the spec-version label
update on every site build. If the spec moves to v0.4 and a tool's score drops because a new MUST landed, the badge
reflects the drop the next time it's served. If the URL pinned a spec version (`/badge/<tool>/v0.3.svg`), readers would
be looking at a snapshot — exactly what trust-and-verify says not to do.

The trade-off: there is no "I was 100% conformant on v0.3" archival URL. That is by design. The historical record lives
in [the scorecard JSON archive](https://github.com/brettdavies/agentnative-site/tree/main/scorecards), which carries the
spec version inside each file. The badge surface is for the present, not the past.

## Honesty expectation

Self-grading is acceptable. The badge URL must resolve to a scorecard that anyone can re-run. That is the whole story.

In practice this means:

- The tool must be listed in the [registry](https://github.com/brettdavies/agentnative-site/blob/main/registry.yaml).
- The scorecard must be a real `anc check --output json` run, committed under
  [`scorecards/`](https://github.com/brettdavies/agentnative-site/tree/main/scorecards).
- Anyone reading the badge can run `anc check --command <binary>` locally and arrive at the same number, modulo
  scorecard-staleness. See the regression policy below.

If the live re-run produces a different score than the badge, the live re-run wins. The badge is a pointer, not an
authority.

## Regression policy

If a tool regresses below the floor, no separate action is required from the tool author. The next site build will
render a yellow or red badge in place of green, and the per-tool scorecard page will replace the embed snippet with a
"top issues to address" hint. There is no maintainer takedown, no embargo, no retroactive edit of historical commits in
the tool's README.

This is the core promise: the badge is an outbound link, not a stamp. Embedding it is permission for the world to check
your work continuously, not a one-time award.

## Claiming the badge

1. Get on the [leaderboard](/scorecards): file a registry entry per
   [the registry README](https://github.com/brettdavies/agentnative-site/blob/main/registry.yaml). The site
   auto-discovers the latest scorecard for each registry entry on every build.
2. Run `anc check --command <binary> --output json > scorecards/<tool>-v<version>.json` and commit the result.
3. When your tool's row on the leaderboard reads 80% or higher, the per-tool page at `/score/<tool>` renders the embed
   snippet inline. Copy it into your README.

That is the whole flow. The convention is intentionally narrow.

## Related

- [Methodology](/methodology): how scores are computed and what the audience signal does and does not claim
- [Scorecard schema](/scorecard-schema): the shape of the underlying JSON
- [Leaderboard](/scorecards): every scored tool, sortable
- [Install `anc`](/install): the CLI that produces scorecards
