# Concepts

Shared domain vocabulary for this project — entities, named processes, and status concepts with project-specific
meaning. Seeded with core domain vocabulary, then accretes as ce-compound and ce-compound-refresh process learnings;
direct edits are fine. Glossary only, not a spec or catch-all.

## Live scoring

### anc100

The curated registry of CLI tools used as the canonical scoring corpus. Lives in `registry.yaml` at the repo root and is
the source of truth for the leaderboard, per-tool scorecard pages, and the live-scoring sandbox's install table. Each
row is a registry entry. The name is fixed; the actual count drifts above and below 100 as tools join and leave.

### Registry entry

A single row in the anc100 registry. Carries the tool's URL-safe name, the binary it installs, the install command, the
project's tier (workhorse, agent, or notable), the creator, and the audit profile that shapes how `anc audit` scores it.
Lookup is dual-keyed by name (URL slug) and by GitHub owner/repo.

### Live-scoring sandbox

The system at `anc.dev` that accepts a user's install command, installs the named tool in an ephemeral container, runs
`anc audit` against the installed binary, and returns a scorecard. One container per scoring request — no shared state
across requests. The runtime is a Cloudflare Durable Object pool fronted by a Worker that resolves the input to an
install spec before dispatching to the container.

### Score (verb) / Scoring

Producing a scorecard by running `anc audit` against a tool. Score happens at two scales: batch scoring (the build-time
pipeline in `docker/score/` that scores the whole anc100 list once per release) and live scoring (per-request, on user
input, in the live-scoring sandbox).

### Scorecard

The structured JSON `anc audit` produces for a single tool, asserting which of the 8 agent-native principles the tool's
CLI meets and at what score. Each principle has weighted checks; the badge surfaces the percentage pass rate. Committed
scorecards live under `scorecards/` in the repo; live-scoring scorecards stream back to the user and are cached in R2.

### Install spec

The resolved, executable form of a user's input after the Worker's resolution layer (`src/worker/score/resolve-spec.ts`)
runs. Names a package manager (`brew`, `cargo-binstall`, `bun`, `pip`, `uv`, `npm`, `go`, `direct`, `git-clone`), a
package or URL, and the binary the post-install check verifies on `PATH`. The Durable Object only ever sees an install
spec, never the raw user input.
