# anc100 batch-scoring image

Pre-bakes every tool from `registry.yaml`, then runs `anc audit` against each to write
`scorecards/<name>-v<version>.json` back to the host repo. Used to populate the `/scorecards` leaderboard for launch.

## Layout

```text
docker/score/
├── Dockerfile            # Debian-slim + Linuxbrew + uv + bun + cargo-binstall + anc
├── compose.yml           # Bind-mounts + NVIDIA GPU passthrough
├── build.sh              # Wrapper: build image, optionally run
├── install-tools.sh      # First-stage: install every registry tool
├── score-anc100.sh       # Second-stage: iterate registry, write scorecards
├── compare.sh            # Before/after harness: two anc builds, one image, a row diff
├── compare-container.sh  # In-container half of compare.sh: scoring and help capture
├── compare-diff.mjs      # Row diff, majority vote and noise list over a run directory
├── compare-render.mjs    # Text and markdown renderings of the row diff
├── out/                  # (gitignored) per-run logs, plus compare.sh builds, runs and captures
├── setup-host.sh         # One-time: install Docker Engine + nvidia-container-toolkit
└── README.md             # this file
```

## Prerequisites (host)

- **Docker Engine + Compose v2.** Engine only, NOT Docker Desktop. Install via `bash docker/score/setup-host.sh`
  (Ubuntu) or follow Docker's apt-repo instructions for your distro.
- **For `nvidia-smi` scoring:** NVIDIA driver + `nvidia-container-toolkit` configured against the Docker daemon. The
  setup-host.sh script handles this if a host GPU is detected. Without it, `nvidia-smi` falls back to `install-missing`
  and the other 99 tools still score.

`anc` is brew-installed inside the image from `brettdavies/tap/agentnative`. No local CLI checkout required.

## One-time host setup

```bash
# Engine only (no Docker Desktop) + nvidia-container-toolkit on Ubuntu:
bash docker/score/setup-host.sh

# After install, log out + back in (or `newgrp docker`) so the docker
# group membership takes effect without sudo.
```

## Usage

```bash
# Build only (brew-installed anc):
bash docker/score/build.sh

# Build + score all 100 tools (writes scorecards/*.json on host):
bash docker/score/build.sh --run

# Inspect the running container interactively:
docker compose -f docker/score/compose.yml run --rm scorer bash
```

### Scoring against an unreleased anc

When you need to test a feature branch in agentnative-cli before it gets tagged and bottled, use `--from-source` to
cargo-build the binary on the host and inject it into the image (skipping brew install):

```bash
# Build anc from a local CLI checkout + bake into the image:
bash docker/score/build.sh --from-source ~/dev/agentnative-cli

# Build + run in one step:
bash docker/score/build.sh --from-source ~/dev/agentnative-cli --run
```

Inject mode caveats:

- The host must be Linux with cargo + a glibc that can produce a binary the container's Debian trixie base (glibc 2.41)
  can load. Recent Debian/Ubuntu hosts satisfy this. macOS-built binaries do not work.
- The injected binary lives in `docker/score/inject/anc` (gitignored). The directory is tracked via `.gitkeep` so the
  COPY layer always succeeds.
- Layer cache invalidates when `ANC_SOURCE` changes or when the injected binary content changes (Docker checksums the
  COPY source). Switching between brew and inject modes re-runs only the anc-install layer; the heavy install-tools
  layer stays cached.
- Inject mode skips the brew tap lookup entirely. The image will report `anc --version` matching whatever your local
  cargo build produced, regardless of what version is currently published to brew.

## Comparing two anc builds

`compare.sh` scores the registry with two builds of `anc` inside one scorer image and reports every row that moved
between them. It writes under the gitignored `docker/score/out/` only. It never writes to `scorecards/`, and it never
builds an image, pulls one, or moves a tag.

It needs a Linux host with Docker, cargo, `jq` and `bun` (after `bun install`), a local `agentnative-cli` checkout, and
a scorer image that `build.sh` already built. No per-tool update step runs, so each tool scores at the version the image
holds.

```bash
# The image to pin. Pass its ID to every command below.
docker image inspect --format '{{.Id}}' anc-scorer:latest

# Build anc at a ref. A commit that is already built is reused.
bash docker/score/compare.sh build --cli ~/dev/agentnative-cli dev

# A/A: run one build twice and record the rows that differ between identical runs.
bash docker/score/compare.sh aa --cli ~/dev/agentnative-cli --image <image-id> dev

# Before/after: report the rows that move from <base-ref> to <head-ref>.
bash docker/score/compare.sh diff --cli ~/dev/agentnative-cli --image <image-id> \
  --noise docker/score/out/compare/<aa-label>/noise.tsv <base-ref> <head-ref>
```

`--only a,b,c` limits a run to those registry names. `--jobs <n>` sets how many tools run at once (default 4).
`--timeout <seconds>` bounds each `anc audit` (default 300). `--network <mode>` sets the Docker network mode for every
container (default `bridge`). `--label <name>` names the run directory. `bash docker/score/compare.sh --help` lists
every option.

### How a run works

- **Builds.** Each ref resolves to a commit in the CLI checkout. `compare.sh` builds that commit from a detached
  worktree at `docker/score/out/compare/worktree`, removes the worktree, and stores the binary beside a manifest that
  records the commit and the binary's sha256. `anc --version` prints only the crate version, so the manifest is what
  identifies a build. Before a container starts, the harness checks both binaries against their manifests and refuses to
  run on a mismatch, naming the `compare.sh build` command that rebuilds the binary.
- **Containers.** `--image` accepts any ref. The harness resolves it to an image ID once, records the ID, and starts
  every container from that ID with `docker run`: no TTY, the registry mounted read-only, and `AGENTNATIVE_HOME_CONFIG`
  pointing at an empty file. Each build gets a container of its own, and the two start together. A tool can change its
  own state on its first run (broot installs a shell launcher, glow opens a log file), so two audits of one tool in one
  container would not see the same tool.
- **Scoring.** In each container, one build runs `anc audit --command <binary> --output json` for every registry entry,
  with the entry's `--audit-profile`. The harness calls the build by an absolute path of its own. `anc` on `PATH` is the
  base build in both containers, so the registry's `anc` entry audits one fixed target while the auditor varies.
- **Diff.** The diff keys rows by `(tool, id, audit_id)` and compares their `status`, `evidence` and `confidence`. Per
  scorecard it also compares `audience`, `audience_reason`, `badge.score_pct`, `badge.eligible`, the cohort band and the
  `summary` counts. The band is the score range that shares one badge fill in `src/build/badge.mjs`. `run.started_at`,
  `run.duration_ms` and `run.invocation` differ on every run, so the diff leaves them out.
- **Reruns.** In a before/after, every tool with a moved row and every tool the noise list names runs three more times
  per build. A row's result under a build is the `(status, evidence, confidence)` value that two or more of those three
  runs agree on, and the row moves when the two builds' results differ. Reruns only measure again: a noise-listed row
  always reruns and always appears in the report with its per-run results.

### Reading the report

The report prints to stdout, and the run directory holds it as `diff.json` and `diff.md`. Its sections are:

- **Moved rows.** One line per row. A note marks a row that only one build emits (`row added`, `row removed`) and a row
  `propagated from` an antecedent audit that moved in the same run. In an A/A run these are the rows `noise.tsv`
  records.
- **Derived fields moved.** The scorecard-level fields, per tool.
- **Unstable.** A rerun row with no majority under one build. The report lists every result and picks none.
- **Re-measured, not moved.** A rerun row whose majority is the same under both builds: every noise-listed row, and any
  row that differed in some run.
- **Harness bugs.** A scorecard pair whose derived fields differ while every row matches. `anc` computes the derived
  fields from the rows, so this means the row diff missed something.
- **Did not run under either build** and **Scoring failures under one build only.** A tool whose binary is absent from
  the image, or whose audit timed out, exited above 2, or printed invalid JSON. The report never counts either as a
  moved row.

### Output layout

```text
docker/score/out/
├── compare/
│   ├── builds/<commit>/anc            # built binary
│   ├── builds/<commit>/manifest.json  # commit and sha256 of the binary
│   ├── target/                        # cargo target directory shared by every build
│   └── <label>/                       # one run
│       ├── manifest.json              # image, registry sha256, builds, network, terminal, jobs, --only, times
│       ├── runs/0/                    # first run over the selected tools
│       │   ├── status.tsv             # tool, base status, head status (joined from status-<build>.tsv)
│       │   ├── base/<tool>.json       # scorecard from the base build
│       │   └── head/<tool>.json       # scorecard from the head build
│       ├── runs/1/ ... runs/3/        # reruns, before/after only
│       ├── diff.json                  # the report, machine-readable
│       ├── diff.md                    # the report as markdown tables
│       └── noise.tsv                  # A/A only: tool, id, audit_id, fields
└── captures/
    ├── _index.tsv                     # file, name, binary, args, exit, bytes
    ├── _manifest-<phase>.json         # image, registry sha256, network, terminal, jobs, --only, times
    └── <binary>__<args joined by _>.txt
```

A status is `ok`, `binary-absent`, `timeout`, `anc-exit-<code>` or `invalid-json`. When an audit writes to stderr, the
harness keeps the text beside the scorecard as `<tool>.stderr`.

### Capturing help output

`capture` saves the help text `anc` reads, taken inside the same pinned image. Each command runs the way `anc` runs it:
the binary by its resolved path, `NO_COLOR=1 TERM=dumb COLUMNS=80 PAGER=cat`, stdin closed, a 5-second limit, and stdout
followed by stderr.

```bash
# Phase 1: the top-level help of every registry tool.
bash docker/score/compare.sh capture --image <image-id>

# Phase 2: one `<binary> <subcommand> --help` per line of a binary<TAB>subcommand list.
bash docker/score/compare.sh capture --image <image-id> --subcommands subcommands.tsv
```

The subcommand list comes from running the CLI's help parser over the phase 1 captures. Each file takes the name
`<binary>__<args joined by _>.txt`, such as `terraform__--help.txt` and `terraform__init_--help.txt`. During a capture,
`anc` on `PATH` is the image's own.

## Image structure

The Dockerfile is layered so the v2 Cloudflare Sandbox image (live "paste-a- URL" scoring, post-launch) can extend the
same base by adding one final stage with the CF sandbox binary + Worker bindings. Today's launch image stops at the
`score-anc100.sh` entrypoint.

Layer order:

1. Base Debian-slim + OS essentials (curl, git, jq, sudo, ca-certificates).
2. Non-root `runner` user.
3. Linuxbrew (the heaviest single layer; cached aggressively).
4. Other package managers: `uv`, `bun`, `cargo-binstall`. All installed via brew, so they're prebuilt + cached.
5. Tooling for the runner: `yq`, `jaq`.
6. The `anc` binary, installed via one of two modes selected by the `ANC_SOURCE` build argument: `brew` (default;
   installs from `brettdavies/tap/agentnative`, same path users get on macOS / Linux) or `inject` (copies a host-built
   binary from `docker/score/inject/anc`, used by `build.sh --from-source`).
7. `install-tools.sh` runs once at image build time, reading the build-time registry baked at `/build/registry.yaml` and
   installing every entry. Failures are logged to `/build/install-log.txt` but do NOT abort the build. Tools that fail
   to install end up missing from PATH and the runner records them as `install-missing`.
8. `score-anc100.sh` is the entrypoint; iterates the run-time registry at `/work/registry.yaml` (compose bind-mount from
   the host). If the run-time registry diverges from the baked one, the runner emits a drift warning, so the operator
   knows new tools won't be installed without a rebuild.

## Failure handling

The runner classifies each registry entry as one of:

- **OK**: installed at build time, scored at run time. Scorecard written to `/work/scorecards/<name>-v<version>.json`
  (bind-mounted to host).
- **install-missing**: install command at build time exited zero but the expected `binary` is not in PATH (or installed
  cleanly but only as a library, etc.). No scorecard written; the leaderboard renders the registry's existing fallback
  row ("not yet scored").
- **score-failed**: binary present, but `anc audit` produced invalid JSON or exited >1 (real error, not the standard
  "checks failed" exit 1). No scorecard written; entry logged in `/work/scoring-failures.txt`.
- **skipped**: install method outside the allowed set (e.g., the `included` value used for `nvidia-smi`'s "comes with
  the driver"). The runner records and moves on.

After a successful run, host's `scorecards/` has the new JSONs. Re-run `bun run build` on the host to regenerate
`dist/scorecards.html` with full data.

## Reuse for v2 Cloudflare Sandbox

This image is intentionally a strict subset of the v2 sandbox image. The v2 path:

1. Same Dockerfile layers 1–7.
2. Replace the entrypoint (`score-anc100.sh`) with the CF Sandbox server binary + a `score-one.sh` thin wrapper that
   handles a single tool on demand.
3. Add `wrangler.jsonc` with the `containers` binding, the Durable Object class, and the worker code at
   `src/worker/score.ts`.
4. Configure dynamic outbound handlers for network policy.

`anc` rebuild is not needed; same glibc binary serves both contexts.

## Update workflow

1. **CLI changed (new release):** rerun `bash docker/score/build.sh --run`. The `anc` brew layer is invalidated when the
   formula's pinned version moves; brew pulls the new bottle and only scoring runs again. Faster than a full image
   rebuild.
2. **Registry changed (added/removed/edited a tool):** rerun the same command. The install layer is invalidated for the
   affected tool; brew re-resolves; scoring re-runs.
3. **Tool released a new version:** the runner's version-extract logic pulls the actually-installed version at score
   time and writes `<name>-v<NEWVERSION>.json`. The old scorecard file stays on disk; `trash`-clean it manually.
