# Update check — operational details

The `bin/check-update` script compares this bundle's `VERSION` against `main` on GitHub. Exit code is always `0`;
network failures, broken installs, and disabled checks all degrade silently. SKILL.md only documents the agent-visible
surface; this file documents the script's contract for anyone debugging it.

## Output contract

| Stdout                               | Meaning                                                                       |
| ------------------------------------ | ----------------------------------------------------------------------------- |
| (empty)                              | Up to date, snoozed, disabled, or check skipped (broken install, no network). |
| `UPGRADE_AVAILABLE <local> <remote>` | A newer release is on `main`. Trigger the upgrade prompt below.               |

## Prompt the user via `AskUserQuestion`

> `agent-native-cli` **v{remote}** is available (you're on v{local}). Upgrade now?

Three options:

- **"Yes, upgrade now"** — run `git -C <bundle-parent-dir> pull --ff-only`. The bundle root is the parent of `bin/`;
  `git -C ../.. pull --ff-only` from `bin/` works for the default install layout (`~/<host>/skills/agent-native-cli/`).
  If `--ff-only` rejects (uncommitted edits or divergent history), surface git's error verbatim and stop — do not
  auto-stash.
- **"Not now"** — write `$HOME/.cache/agent-native-cli/update-snoozed` in the format `<remote> <level> <epoch>`, where
  `<level>` is `1` (24h reminder), `2` (48h), or `3` (7 days), escalating each time the user defers. Tell the user the
  next reminder window.
- **"Never ask again"** — `touch $HOME/.cache/agent-native-cli/disabled` and tell the user how to re-enable (`rm
  $HOME/.cache/agent-native-cli/disabled`).

## State directory

`$HOME/.cache/agent-native-cli/` holds three files: `last-update-check`, `update-snoozed`, `disabled`. The script
auto-creates the directory on first slow-path fetch.
