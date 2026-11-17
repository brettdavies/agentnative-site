# Getting started

This skill teaches agents how to design, build, or audit a CLI for use by other agents. The work is one of three loops;
pick the one that matches your starting point. The canonical auditor is
[`anc`](https://github.com/brettdavies/agentnative-cli); the canonical principle text is in
[`spec/principles/`](./spec/principles/).

## You have an existing CLI

```bash
# 1. Run the auditor. Schema is 0.9; results[] carries `id`, `audit_id`, `tier`, `status`, `evidence`.
anc audit --output json . > scorecard.json

# 2. For each FAIL, look up the cited `id` (e.g. `p1-must-no-interactive`)
#    in spec/principles/p<N>-*.md — frontmatter `requirements[]`.

# 3. Apply the fix. Patterns live in:
#      references/rust-clap-patterns.md                (Rust/clap)
#      references/framework-idioms.md                  (Rust idioms)
#      references/framework-idioms-other-languages.md  (Click, argparse, Cobra, Commander, yargs, oclif, Thor)
#    Re-run `anc audit` until no MUST row is `fail`:
#      jq '[.results[] | select(.tier == "must" and .status == "fail")] | length'   # bar: 0
#    Do not use `coverage_summary.must.verified == coverage_summary.must.total`
#    as the bar; `verified` counts every verdict, `fail` included.
#    `opt_out` and `n_a` are non-failure terminals (deliberate non-adoption or
#    a conditional whose antecedent collapsed); don't chase them as bugs.

# 4. Claim the badge once `badge.eligible == true` (≥70%).
#    Copy `badge.embed_markdown` from the JSON scorecard into the project's README.

# 5. Prove the contract in your own CI: adapt the per-principle checklist in
#    references/testing.md into your test suite (skeletons: templates/tests/),
#    so the fixed behavior stays fixed between audits.
```

Useful flags: `--principle N` to focus on one principle, `--audit-profile <category>` to suppress audits that don't
apply (`human-tui` for TUIs that legitimately intercept the TTY, `posix-utility` for cat/sed/awk-style stdin-primary
tools, `diagnostic-only` for read-only tools, `file-traversal` reserved), `--binary` / `--source` to scope.

## You're building from scratch (Rust)

```bash
cargo init my-tool && cd my-tool

# Starter files. Encode P1–P7 by construction.
cp <skill-root>/templates/clap-main.rs          src/main.rs
cp <skill-root>/templates/error-types.rs        src/error.rs
cp <skill-root>/templates/output-format.rs      src/output.rs
cp <skill-root>/templates/agents-md-template.md AGENTS.md   # fill placeholders

# Add to Cargo.toml: clap (derive, env), serde, serde_json, thiserror,
# libc (SIGPIPE), clap_complete. See references/project-structure.md.

# Prove the contract as you build (per-principle checklist: references/testing.md).
cp <skill-root>/templates/tests/cli-integration.rs tests/cli-integration.rs   # swap YOUR_* placeholders

anc audit --output json    # run continuously as you build
```

## You're building in another language

`anc`'s source-analysis layer is Rust-only; its behavioral layer (`anc audit --command <name>`) runs against any
compiled binary on `PATH`. Read `spec/principles/p1-*.md` through `p7-*.md` for the language-agnostic requirements, and
`references/framework-idioms-other-languages.md` for per-framework idioms. To prove the contract in your own suite,
`references/testing.md` holds the per-principle checklist plus a language-to-harness table (`subprocess`+`pytest`,
`os/exec`+`testing`, `execa`, `Open3`); start from `templates/tests/cli_integration_test.py` for Python, or map the Rust
skeleton's structure onto your harness row.

## Installing anc and this skill bundle

```bash
# 1. Install the `anc` binary.
brew install brettdavies/tap/agentnative   # macOS / Linux
cargo install agentnative

# 2. Install this skill bundle into your host's canonical skills directory.
#    Six hosts supported: claude_code, codex, cursor, factory, kiro, opencode.
anc skill install claude_code
anc skill install --all                              # install into every known host
anc skill install --dry-run claude_code              # preview the git clone
eval $(anc skill install --dry-run claude_code)      # captures cleanly for scripted installs
anc skill install --output json claude_code          # uniform JSON envelope (success + error)
anc skill update claude_code                         # refresh an existing install (SKILL.md marker required)
anc skill update --all                               # refresh every known host

# 3. (Optional) Pin against the scorecard JSON Schema embedded in the binary.
anc emit schema > scorecard-v0.9.schema.json         # validate downstream parsers against this
```

Binary name: `anc`. Prebuilt releases at <https://github.com/brettdavies/agentnative-cli/releases>. If your host is not
yet in the binary's map, `anc skill install --dry-run <known-host>` prints a manual `git clone` you can adapt: `git
clone --depth 1 https://github.com/brettdavies/agentnative-skill.git <dest>`.

## Where things live

| Question                                        | Where                                                         |
| ----------------------------------------------- | ------------------------------------------------------------- |
| What does P3 mean?                              | `spec/principles/p3-progressive-help-discovery.md`            |
| What spec version does this bundle ship?        | `spec/VERSION`                                                |
| How do I implement `<pattern>` in Rust/clap?    | `references/rust-clap-patterns.md`                            |
| How do I implement `<pattern>` in Python/Go/JS? | `references/framework-idioms-other-languages.md`              |
| How do I test my CLI against the principles?    | `references/testing.md` + `templates/tests/`                  |
| How does the badge eligibility threshold work?  | `SKILL.md` § "The anc loop" (70% credit-weighted floor)       |
| What does the scorecard JSON look like?         | `anc emit schema` (schema 0.9) or `SKILL.md` § "The anc loop" |
| File a spec question or proposal                | <https://github.com/brettdavies/agentnative>                  |
| File an `anc` bug                               | <https://github.com/brettdavies/agentnative-cli>              |
| File a skill-bundle issue                       | <https://github.com/brettdavies/agentnative-skill>            |
