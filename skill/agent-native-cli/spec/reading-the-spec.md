## Reading the spec

Every principle file pairs a machine-readable frontmatter block with prose in a fixed order: Definition, Why Agents Need
It, Requirements (MUST / SHOULD / MAY), Evidence, Anti-Patterns, and Pressure-test notes. Both halves are load-bearing:
machines parse the frontmatter, humans read the prose, and a CI validator keeps the two in sync.

The frontmatter carries a `requirements[]` array (one entry per MUST/SHOULD/MAY bullet) that auditors and graders pin
against instead of prose. Each entry has:

- **`id`**: a stable `p<n>-<level>-<slug>` identifier, unique across all eight files. Tooling references these, so they
  survive prose edits.
- **`level`**: `must`, `should`, or `may`, with [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119) /
  [RFC 8174](https://www.rfc-editor.org/rfc/rfc8174) semantics.
- **`applicability`**: `universal`, or conditional: gated on a prose `{if: "<reason>"}` clause, or on a
  machine-checkable `{kind: conditional, antecedent: {audit_id: "<id>"}}` whose named verifier decides whether the
  requirement binds.
- **`summary`**: one sentence, mirrored by the prose bullet.

Requirement text names a flag by its double-dash spelling (`--force`, `--quiet`, `--output`). A tool whose help declares
no double-dash name follows the Go `flag` convention, where one dash and two name the same flag, and meets the
requirement with the single-dash spelling: `-force` on `terraform force-unlock` satisfies a requirement that names
`--force`. In a help that declares any double-dash name, a single-dash word is a name of its own and does not stand in
for the double-dash spelling. A single letter is a different name in either case and meets only a requirement that names
that letter, so `-f` meets `--force` only where the requirement also names `-f`.

[`principles/AGENTS.md`](https://github.com/brettdavies/agentnative/blob/v0.7.0/principles/AGENTS.md) is the full authoring and governance contract: frontmatter fields,
requirement-ID conventions, the conditional-applicability propagation table, the `last-revised` discipline, the status
lifecycle, and the coupled-release protocol with the linter.
