# Changelog

Reverse-chronological record of changes to the agent-native CLI standard. The spec uses semver-adjacent versioning:
MAJOR changes break citation IDs or remove MUSTs; MINOR changes add MUSTs or promote SHOULDs; PATCH changes edit prose
without shifting requirements. See [Versioning](/about) for the full policy.

## Unreleased

Initial publication of the standard. Seven principles (P1 through P7) defining agent-native CLI behavior, enforced
by RFC 2119 requirement tiers. Companion linter [`agentnative`](/audit) scores any CLI against them.

- P1: Non-Interactive by Default
- P2: Structured, Parseable Output
- P3: Progressive Help Discovery
- P4: Fail Fast with Actionable Errors
- P5: Safe Retries and Explicit Mutation Boundaries
- P6: Composable and Predictable Command Structure
- P7: Bounded, High-Signal Responses
