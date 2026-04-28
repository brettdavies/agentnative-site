# anc100 batch-scoring image

Pre-bakes every tool from `registry.yaml`, then runs `anc check` against each to write
`scorecards/<name>-v<version>.json` back to the host repo. Used to populate the `/scorecards` leaderboard for launch.

## Layout

```text
docker/score/
├── Dockerfile          # Debian-slim + Linuxbrew + uv + bun + cargo-binstall
├── compose.yml         # Bind-mounts + NVIDIA GPU passthrough
├── build.sh            # Wrapper: build anc, build image, optionally run
├── install-tools.sh    # First-stage: install every registry tool
├── score-anc100.sh     # Second-stage: iterate registry, write scorecards
├── anc                 # (gitignored) staged anc binary, written by build.sh
├── out/                # (gitignored) per-run logs from inside the container
└── README.md           # this file
```

## Prerequisites (host)

- Docker + Docker Compose v2.
- A `~/dev/agentnative-cli/` checkout with `cargo` available. Override path with `ANC_CLI_ROOT=…`.
- For `nvidia-smi` scoring: NVIDIA driver + `nvidia-container-toolkit` configured against the Docker daemon. Without it,
  `nvidia-smi` falls back to `install-missing` and the other 99 tools still score.

## Usage

```bash
# Build only:
bash docker/score/build.sh

# Build + score all 100 tools (writes scorecards/*.json on host):
bash docker/score/build.sh --run

# Inspect the running container interactively:
docker compose -f docker/score/compose.yml run --rm scorer bash
```

## Image structure

The Dockerfile is layered so the v2 Cloudflare Sandbox image (live "paste-a- URL" scoring, post-launch) can extend the
same base by adding one final stage with the CF sandbox binary + Worker bindings. Today's launch image stops at the
`score-anc100.sh` entrypoint.

Layer order:

1. Base Debian-slim + OS essentials (curl, git, jq, sudo, ca-certificates).
2. Non-root `runner` user.
3. Linuxbrew (the heaviest single layer; cached aggressively).
4. Other package managers: `uv`, `bun`, `cargo-binstall` — all installed via brew so they're prebuilt + cached.
5. Tooling for the runner: `yq`, `jaq`.
6. The `anc` binary, copied in from the build context (built by `build.sh` from
   `~/dev/agentnative-cli/target/release/anc`).
7. `install-tools.sh` runs once at image build time, installing every registry tool. Failures are logged to
   `/work/install-log.txt` but do NOT abort the build — tools that fail to install simply end up missing from PATH and
   the runner records them as `install-missing`.
8. `score-anc100.sh` is the entrypoint; iterates the registry at run time.

## Failure handling

The runner classifies each registry entry as one of:

- **OK** — installed at build time, scored at run time. Scorecard written to `/work/scorecards/<name>-v<version>.json`
  (bind-mounted to host).
- **install-missing** — install command at build time exited zero but the expected `binary` is not in PATH (or installed
  cleanly but only as a library, etc.). No scorecard written; the leaderboard renders the registry's existing fallback
  row ("not yet scored").
- **score-failed** — binary present, but `anc check` produced invalid JSON or exited >1 (real error, not the standard
  "checks failed" exit 1). No scorecard written; entry logged in `/work/scoring-failures.txt`.
- **skipped** — install method outside the allowed set (e.g., the `included` value used for `nvidia-smi`'s "comes with
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

1. **CLI changed (new release):** rerun `bash docker/score/build.sh --run`. The `anc` binary gets rebuilt; the install
   layer is cached; only scoring runs again. Faster than a full image rebuild.
2. **Registry changed (added/removed/edited a tool):** rerun the same command. The install layer is invalidated for the
   affected tool; brew re-resolves; scoring re-runs.
3. **Tool released a new version:** the runner's version-extract logic pulls the actually-installed version at score
   time and writes `<name>-v<NEWVERSION>.json`. The old scorecard file stays on disk — `trash`-clean it manually.
