# The agent-native CLI standard

CLI tools are how AI agents touch everything else. Compilers, databases, git, the cloud, the shell. An agent asked to
ship code, rotate a credential, grep a log, or deploy a branch does not call a SaaS API — it shells out to a binary,
reads the output, decides what went right or wrong, and picks the next move. There is no human between the request and
the process. The CLI either makes that loop tractable or it does not.

This is the specification for CLIs that make it tractable. Seven principles, each expressing a requirement with
[RFC 2119](https://www.rfc-editor.org/rfc/rfc2119) tiers — **MUST** for the contract, **SHOULD** for the default,
**MAY** for the optional affordance. The companion linter, [`agentnative`](/check), scores any CLI against them and
reports results by stable check ID (`p1-non-interactive`, `p4-process-exit`, …). Cite a principle by its anchor slug
(`#p1-non-interactive-by-default` through `#p7-bounded-high-signal-responses`) — those are permanent.

Each of the seven principles below has its own page (`/p1` through `/p7`) for deep-linking, and the same text is
available as raw markdown at `/p1.md` … `/p7.md` for agent consumption. The entire spec as one file lives at
[`/llms-full.txt`](/llms-full.txt); a curated index for retrieval-heavy agents lives at [`/llms.txt`](/llms.txt).
