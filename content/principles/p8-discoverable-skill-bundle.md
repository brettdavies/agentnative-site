# P8: Discoverable Through Agent Skill Bundles

## Definition

Without a skill bundle, every fresh agent invocation begins the same way: pull `--help`, infer the idioms, try a
command, parse the error, try again. A skill bundle (canonical names `AGENTS.md` or `SKILL.md`) collapses that loop —
agent-discoverable through filesystem convention rather than through `--help`, loaded once, recognized thereafter.

## Why Agents Need It

`--help` describes what is *possible* (the flag and subcommand surface); a skill bundle describes what to *do* (workflow
knowledge, common compositions, recovery patterns). Workflow knowledge does not fit in `after_help` examples. The bundle
is also where conventions that span multiple subcommands live — exit-code tables, output-channel discipline, retry
semantics — context that `--help` for a single subcommand cannot carry on its own. Without one, the agent has nowhere to
durably register what it learned, and re-pays the discovery cost on every fresh session.

## Requirements

**MUST:**

- *(Applies when: CLI ships a skill bundle.)* An install path that registers the bundle with installed agent runtimes.
  The canonical form is a `tool skill install [<host>]` subcommand that writes into the runtime's filesystem cascade
  (`~/.claude/skills/`, `~/.cursor/skills/`, `~/.codex/skills/`, etc.). Non-canonical alternatives (`tool init --skill`,
  `tool skills add`, `tool agents add`) are acceptable but should migrate toward `tool skill install`. A bundle without
  an install path sits unread until a human manually copies it; the install path is what turns the bundle from
  documentation into discoverable runtime knowledge.

**SHOULD:**

- A top-level agent-discoverable markdown bundle. Canonical filenames are `AGENTS.md` or `SKILL.md`, both recognized by
  major agent runtimes. The bundle's first job is to be findable by filesystem convention; its second is to teach the
  agent how to invoke the tool well. YAML frontmatter at minimum names the tool and a one-line capability summary so
  agents can scan and route without reading the full body.

**MAY:**

- *(Applies when: CLI ships a skill bundle.)* An `--all` mode auto-detects installed agent runtimes (Claude Code,
  Cursor, Codex, OpenCode, and others as the ecosystem evolves) and installs the bundle across each. A user setting up a
  new machine with multiple coding agents installs once and gets coverage everywhere.
- *(Applies when: CLI ships a skill bundle.)* An `update` (or `upgrade`) subcommand under `tool skill` pulls the latest
  bundle version, so agents stay current with the CLI's evolving surface without a full reinstall.

## Evidence

- A top-level `AGENTS.md` or `SKILL.md` in the CLI's source tree, shipped in the release artifact, with YAML frontmatter
  declaring at least the tool name and a one-line capability summary.
- A `skill` subcommand group in the CLI (e.g., `tool skill install`, `tool skill update`, `tool skill list`).
- An installer that writes directly to the runtime cascade (`~/.claude/skills/<tool>/`, `~/.cursor/skills/<tool>/`)
  rather than requiring the runtime to be running.
- Bundle content versioned alongside the CLI's release: the bundle ships from the same commit as the binary, not from a
  separate documentation tree that drifts.

## Anti-Patterns

- A CLI shipping a skill bundle with no install path. The bundle sits unread until a human copies it manually.
- An install path that requires the agent runtime to be running. The runtime cascade is filesystem-resident; writing to
  it should not need an active session.
- A bundle whose contents drift from the CLI's actual surface — a skill bundle in a docs subtree maintained by a
  different cadence than the binary itself, naming flags or subcommands that no longer exist.

Requirement IDs `p8-must-bundle-install`, `p8-should-bundle-exists`, `p8-may-install-all`, and `p8-may-bundle-update`
define the contract; behavioral checks land as the linter grows P8 coverage. Run `anc check --principle 8 .` against
your CLI to see what's measured today.
