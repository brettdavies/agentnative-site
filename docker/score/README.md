# anc100 batch-scoring image

Pre-bakes every tool from `registry.yaml`, then runs `anc audit` against each to write
`scorecards/<name>-v<version>.json` back to the host repo. Used to populate the `/scorecards` leaderboard for launch.

## Layout

```text
docker/score/
├── Dockerfile          # Debian-slim + Linuxbrew + uv + bun + cargo-binstall + anc
├── compose.yml         # Bind-mounts + NVIDIA GPU passthrough
├── build.sh            # Wrapper: build image, optionally run
├── install-tools.sh    # First-stage: install every registry tool
├── score-anc100.sh     # Second-stage: iterate registry, write scorecards
├── out/                # (gitignored) per-run logs from inside the container
├── setup-host.sh       # One-time: install Docker Engine + nvidia-container-toolkit
└── README.md           # this file
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
