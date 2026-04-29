# Install agentnative

`agentnative` is the reference linter for the agent-native CLI standard. It scores any CLI tool against the seven
principles and tells you, by check ID, where it passes and where it falls short. Install it locally, then point it at a
binary or a project directory.

## Homebrew

```bash
brew install brettdavies/tap/agentnative
```

The tap publishes signed bottles for macOS (Intel + Apple Silicon) and Linux (x86_64 + arm64). `brew upgrade
brettdavies/tap/agentnative` updates in place.

## Cargo

```bash
cargo install agentnative
```

For a prebuilt binary without compiling from source: `cargo binstall agentnative`.

## GitHub Releases

Platform archives — including Windows builds and SHA256 checksums — live at
[github.com/brettdavies/agentnative-cli/releases](https://github.com/brettdavies/agentnative-cli/releases). Download the
archive for your platform, extract, and put the `anc` binary on `$PATH`.

## What's next

Once installed, the CLI is invoked as `anc`. See [/check](/check) for usage — flags, output shapes, and how to interpret
the per-principle check IDs. The principles themselves are spelled out at [/](/), with one page per principle (`/p1`
through `/p7`).

To install the **agent-native-cli skill bundle** instead — the Claude Code / Codex / Cursor / OpenCode skill that
teaches an agent to write CLIs against this standard — see [/skill](/skill).
