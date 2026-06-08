This is the specification for CLIs that make it tractable. Eight principles, each expressing a requirement with
[RFC 2119](https://www.rfc-editor.org/rfc/rfc2119) tiers: **MUST** for the contract, **SHOULD** for the default, **MAY**
for the optional affordance. The companion linter, [`anc`](/audit), scores any CLI against them and reports results by
stable audit ID (`p1-non-interactive`, `p2-json-output`, `p6-sigpipe`, …). Cite a principle by its anchor slug
(`#p1-non-interactive-by-default` through `#p8-discoverable-skill-bundle`); those are permanent.

Each of the eight principles below has its own page (`/p1` through `/p8`) for deep-linking, and the same text is
available as raw markdown at `/p1.md` … `/p8.md` for agent consumption. The entire spec as one file lives at
[`/llms-full.txt`](/llms-full.txt); a curated index for retrieval-heavy agents lives at [`/llms.txt`](/llms.txt).

For the standard applied at scale, see the [**ANC 100 leaderboard**](/scorecards) (100 widely-used CLI tools, scored
against the same eight principles). The scoring methodology and per-field schema for the underlying JSON live at
[`/methodology`](/methodology) and [`/scorecard-schema`](/scorecard-schema).
