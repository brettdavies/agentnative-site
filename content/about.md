# About this standard

The agent-native CLI standard is a specification for command-line tools that behave predictably under agent control.
Eight principles, enforced by RFC 2119 requirement tiers (MUST / SHOULD / MAY), and measured by a companion linter
([`anc`](/check)) that scores any CLI against them.

## Provenance

This spec is authored and maintained in the open by Brett Davies, with contributions accepted via the channels below. It
is a proposal pressure-tested in public, not a ratified industry standard — the goal is to converge on something worth
ratifying, by writing it down concretely first and inviting people to break it.

## Prior art

The eight-principle structure draws on two distinct lineages.

**Standards and methodologies that shaped the format:**

- [Command Line Interface Guidelines (clig.dev)](https://clig.dev/) — the closest direct prior art for CLI design
  guidance; the Unix-philosophy distillation this spec departs from when agents change the human-only assumptions.
- [The Twelve-Factor App (12factor.net)](https://12factor.net/) — the numbered-principle methodology layout,
  environment- first configuration, and the discipline of writing each factor down concretely.
- [IETF RFC 2119](https://www.rfc-editor.org/rfc/rfc2119) — the MUST / SHOULD / MAY contract that turns prose into a
  conformance bar.

**Writing that informed the principles directly:**

- Cloudflare's [Building a CLI for all of Cloudflare](https://blog.cloudflare.com/cf-cli-local-explorer) (2026-04-13)
  and the [HN discussion that followed](https://news.ycombinator.com/item?id=47753689) — the most concrete public
  statement of "agents are the primary customer" of CLI tools, paired with crowd-sourced failure modes from people who
  run agents against CLIs every day. Quotes from that thread shaped the framing of P3 (progressive help), P4 (actionable
  errors), and P6 (composable structure) directly. The Cloudflare team's own rules (`get` not `info`, `--json` always,
  `--force` not `--skip-confirmations`) are mirrored in P2 and P6.

If a specific principle's framing seems to echo prior writing, it probably does — credit accrues to the people whose
public reasoning informed it; mistakes are mine.

## Versioning

The spec uses semver-adjacent versioning with three tiers: MAJOR changes break citation IDs or remove MUSTs; MINOR
changes add MUSTs or promote SHOULDs; PATCH changes edit prose without shifting requirements. The current version
appears in the footer of every page.

Principle anchor slugs (`#p1-non-interactive-by-default` through `#p8-discoverable-skill-bundle`) are permanent. If a
principle merges or splits in a future MAJOR version, the old slug will resolve as a permanent redirect to wherever the
requirement now lives — citations made today will not 404 after a future restructuring.

## RFC 2119

MUST, SHOULD, MAY, MUST NOT, and SHOULD NOT on this site carry their [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119)
meanings. They are not emphatic; they are contractual. A tool that does not satisfy a MUST is non-conformant with the
version of the standard it claims to target.

## License

Spec text on this site is available under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). The `anc` linter is
dual-licensed under MIT and Apache-2.0; see [its LICENSE files](https://github.com/brettdavies/agentnative-cli).

## Contributing

Pressure-testing is how the spec evolves. Three ways to contribute:

1. **[Grade a real CLI](https://github.com/brettdavies/agentnative/issues/new?template=grade-a-cli.yml)** against a
   principle you think the spec gets wrong. Name the CLI, the principle, and the specific MUST/SHOULD/MAY that failed
   (or passed unexpectedly).
2.

**[Report a false positive or false negative](https://github.com/brettdavies/agentnative-cli/issues/new?template=false-positive.yml)**
in the `anc` checker. Include the command, the output, and the check ID.
3. **[Propose a principle edit](https://github.com/brettdavies/agentnative/issues/new?template=pressure-test.yml)** —
   merge, split, rewording, demotion of a MUST to a SHOULD. Describe the problem before proposing a solution.

For full routing guidance, see the spec repo's
[CONTRIBUTING.md](https://github.com/brettdavies/agentnative/blob/main/CONTRIBUTING.md).

## Colophon

Built with Cloudflare Workers. Typeset in Uncut Sans and Monaspace Xenon. Source:
[github.com/brettdavies/agentnative-site](https://github.com/brettdavies/agentnative-site).
