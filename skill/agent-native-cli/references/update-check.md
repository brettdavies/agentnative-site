# Update check — operational details

The `bin/check-update` script compares this bundle's `VERSION` against the version pointer anc.dev publishes at
`https://anc.dev/.well-known/agent-skills/agent-native-cli/VERSION`. Exit code is always `0`; network failures, broken
installs, and disabled checks all degrade silently. SKILL.md only documents the agent-visible surface; this file
documents the script's contract for anyone debugging it.

## Output contract

| Stdout                               | Meaning                                                                       |
| ------------------------------------ | ----------------------------------------------------------------------------- |
| (empty)                              | Up to date, snoozed, disabled, or check skipped (broken install, no network). |
| `UPGRADE_AVAILABLE <local> <remote>` | anc.dev publishes a different version. Trigger the upgrade prompt below.      |

## Prompt the user via `AskUserQuestion`

> `agent-native-cli` **v{remote}** is available (you're on v{local}). Upgrade now?

Three options:

- **"Yes, upgrade now"** — first work out how this copy was installed. A symlinked `<skill-dir>`, or one that matches
  none of the six destinations in the table below, is another tool's copy: ask the user. When nobody can answer, skip
  the upgrade and mention `v{remote}` once.
  - Installed with `npx skills add`: run `npx skills update -g -y` and stop.
  - Otherwise run `anc --version`.
  - Below 0.8.0, or no `anc` on `PATH`: do not run `anc skill update`. Those versions delete the install before they
    fetch a replacement. Ask before changing the user's `anc`, then upgrade it with the tool that installed it
    (`command -v anc` shows where it lives): `brew upgrade brettdavies/tap/agentnative` for Homebrew, or
    `cargo install agentnative` for cargo. With no `anc` on `PATH`, install it with
    `brew install brettdavies/tap/agentnative` or `cargo install agentnative`. Or follow the manual install on
    <https://anc.dev/skill>.
  - At 0.8.0 or later: run `anc skill update <host>`, where `<host>` is the slug in the table below whose destination is
    this bundle's root (the parent of `bin/`). Never run `--all`: it installs a fresh copy into every host that lacks
    one.
  - A host `anc` does not map gets the manual install on <https://anc.dev/skill>.
  - If a command fails, show its error and stop. After an update succeeds, re-read `SKILL.md`: the copy loaded in this
    session is the old one.
- **"Not now"** — write `$HOME/.cache/agent-native-cli/update-snoozed` in the format `<remote> <level> <epoch>`, where
  `<level>` is `1` (24h reminder), `2` (48h), or `3` (7 days), escalating each time the user defers. Tell the user the
  next reminder window.
- **"Never ask again"** — `touch $HOME/.cache/agent-native-cli/disabled` and tell the user how to re-enable (`rm
  $HOME/.cache/agent-native-cli/disabled`).

## Host slugs

`anc skill update` takes the slug whose destination is this bundle's root:

| Slug          | Destination                                  |
| ------------- | -------------------------------------------- |
| `claude_code` | `~/.claude/skills/agent-native-cli`          |
| `codex`       | `~/.codex/skills/agent-native-cli`           |
| `cursor`      | `~/.cursor/skills/agent-native-cli`          |
| `factory`     | `~/.factory/skills/agent-native-cli`         |
| `kiro`        | `~/.kiro/skills/agent-native-cli`            |
| `opencode`    | `~/.config/opencode/skills/agent-native-cli` |

## State directory

`$HOME/.cache/agent-native-cli/` holds three files: `last-update-check`, `update-snoozed`, `disabled`. The script
auto-creates the directory on first slow-path fetch.
