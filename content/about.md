# About this standard

The agent-native CLI standard is a specification for command-line tools that behave predictably under agent control.
Seven principles, enforced by RFC 2119 requirement tiers (MUST / SHOULD / MAY), and measured by a companion linter
([`agentnative`](/check)) that scores any CLI against them.

## Versioning

The spec uses semver-adjacent versioning with three tiers: MAJOR changes break citation IDs or remove MUSTs; MINOR
changes add MUSTs or promote SHOULDs; PATCH changes edit prose without shifting requirements. The current version
appears in the footer of every page.

Principle anchor slugs (`#p1-non-interactive-by-default` through `#p7-bounded-high-signal-responses`) are permanent. If
a principle merges with another or splits into two, the old slug resolves as a permanent redirect to wherever the
requirement now lives — no citation you made yesterday will 404 tomorrow.

## RFC 2119

MUST, SHOULD, MAY, MUST NOT, and SHOULD NOT on this site carry their [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119)
meanings. They are not emphatic; they are contractual. A tool that does not satisfy a MUST is non-conformant with the
version of the standard it claims to target.

## License

Spec text on this site is available under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). The `agentnative`
linter is dual-licensed under MIT and Apache-2.0; see [its LICENSE files](https://github.com/brettdavies/agentnative).

## Contributing

Pressure-testing is how the spec evolves. Three ways to contribute:

1. **Grade a real CLI** against a principle you think the spec gets wrong, and open an issue on the
   [site repo](https://github.com/brettdavies/agentnative-site) with your findings. Name the CLI, the principle, and the
   specific MUST/SHOULD/MAY that failed (or passed unexpectedly).
2. **Report a check that produces a false positive or false negative** on the
   [`agentnative` repo](https://github.com/brettdavies/agentnative). Include the command, the output, and the check ID.
3. **Propose a principle edit** — merge, split, rewording, demotion of a MUST to a SHOULD — via an issue with
   `[pressure-test]` in the title. The pressure-test protocol is documented in the spec's working repo.

## Colophon

Built with Cloudflare Workers. Typeset in Uncut Sans and Monaspace Xenon. Source:
[github.com/brettdavies/agentnative-site](https://github.com/brettdavies/agentnative-site).
