# syntax=docker/dockerfile:1.7
#
# Batch-scoring image for the anc100 leaderboard.
#
# Goal: pre-bake every installable tool from registry.yaml + the `anc` linter,
# then run `scripts/score-anc100.sh` to write scorecards/<name>-v<version>.json
# for the whole registry. Output is bind-mounted back to the host.
#
# Constraints (per the live-scoring-spike + CEO design + 2026-04-28 launch-eve
# discussion):
#   - NO COMPILING. Allowed install paths only:
#       brew, cargo binstall, uv tool install, bun add -g, apt-get install
#     `cargo install` (compile) and `go install` (compile) are explicitly OUT.
#   - glibc base — no musl. Reuses the dev-machine `anc` build artifact.
#   - Same image structure as the future v2 CF Sandbox container — only the
#     final stage diverges (batch runner here vs. sandbox server there).
#
# Caching strategy:
#   The install-tools layer uses BuildKit `--mount=type=cache` directives
#   for each package manager's download cache. The actual installed
#   binaries land in the image (in /home/linuxbrew/.linuxbrew, ~/.local,
#   ~/.bun, ~/.cargo); only the DOWNLOAD caches persist across builds.
#   Effect: changing one tool in registry.yaml invalidates the install
#   layer (since registry.yaml is COPYed before it), but the re-install
#   reuses cached bottles/wheels/tarballs. Wall time drops from "redownload
#   everything" to "reinstall from local cache." First build is cold;
#   second-onwards builds are ~5-10x faster.
#
#   Requires BuildKit (Docker 18.09+, default in modern Docker + compose v2).
#
# Usage (from repo root):
#   docker build -f docker/score/Dockerfile -t anc-scorer .
#   docker run --rm \
#     -v "$(pwd)/registry.yaml:/work/registry.yaml:ro" \
#     -v "$(pwd)/scorecards:/work/scorecards" \
#     anc-scorer
#
# Or simpler via docker-compose: `docker compose -f docker/score/compose.yml run --rm scorer`.

FROM debian:bookworm-slim AS base

ENV DEBIAN_FRONTEND=noninteractive
ENV LANG=C.UTF-8 LC_ALL=C.UTF-8

# Core OS packages: build-essential is here ONLY because Linuxbrew bootstrap
# needs it for a few formulae's pre-built bottle resolution. We are NOT using
# it to compile target tools — every registry install is prebuilt-only.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl wget git xz-utils file procps locales \
      build-essential gnupg jq sudo \
    && rm -rf /var/lib/apt/lists/*

RUN locale-gen C.UTF-8

# Non-root user for brew (Linuxbrew refuses root). Sudo grants apt-get for
# Linuxbrew's internal package-manager fallback if it ever needs it.
RUN useradd -m -s /bin/bash -G sudo runner \
    && echo 'runner ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/runner

# Linuxbrew installs into /home/linuxbrew/.linuxbrew per upstream convention.
RUN mkdir -p /home/linuxbrew && chown runner:runner /home/linuxbrew

USER runner
WORKDIR /home/runner

# ---- Install Linuxbrew (the heaviest install layer) ------------------------
ENV NONINTERACTIVE=1
RUN /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
ENV PATH=/home/linuxbrew/.linuxbrew/bin:/home/linuxbrew/.linuxbrew/sbin:$PATH
RUN brew --version

# ---- Other package managers (all available via brew so the install is fast) -
# uv = Python tool runner; bun = JS runtime + package manager;
# cargo-binstall = Rust prebuilt-only installer.
# Cache mount on the brew bottle download dir so re-runs reuse downloads.
RUN --mount=type=cache,target=/home/runner/.cache/Homebrew,uid=1000,gid=1000 \
    brew install uv bun cargo-binstall

# ---- Ergonomic tools the runner script depends on --------------------------
# yq for parsing registry.yaml; jaq for JSON validation.
RUN --mount=type=cache,target=/home/runner/.cache/Homebrew,uid=1000,gid=1000 \
    brew install yq jaq

# ---- The anc binary (glibc, built from CLI dev RC) -------------------------
# Copied in from the build context. The wrapper script `docker/score/build.sh`
# verifies the binary exists before invoking docker build.
COPY --chown=runner:runner anc /home/runner/.local/bin/anc
RUN chmod +x /home/runner/.local/bin/anc \
    && /home/runner/.local/bin/anc --version
ENV PATH=/home/runner/.local/bin:$PATH

# ---- Pre-bake every registry tool ------------------------------------------
# Build-time registry lives at /build/registry.yaml — immutable, frozen at
# image-build. Runtime registry is bind-mounted to /work/registry.yaml by
# compose so the runner sees the host's current registry. The runner diffs
# the two and warns on drift (added/removed tools that didn't make it into
# the install layer).
#
# This layer takes the longest (~20-40 minutes first build); Docker caches
# it so subsequent rebuilds skip ahead unless registry.yaml changed.
#
# BuildKit cache mounts on every package manager's download cache: re-runs
# (when registry.yaml does change) reuse cached bottles/wheels/tarballs and
# skip the network downloads. The CACHED dirs do NOT carry into the final
# image — only the actually-installed binaries do.
COPY --chown=runner:runner registry.yaml /build/registry.yaml
COPY --chown=runner:runner docker/score/install-tools.sh /build/install-tools.sh
RUN --mount=type=cache,target=/home/runner/.cache/Homebrew,uid=1000,gid=1000 \
    --mount=type=cache,target=/home/runner/.cache/uv,uid=1000,gid=1000 \
    --mount=type=cache,target=/home/runner/.bun/install/cache,uid=1000,gid=1000 \
    --mount=type=cache,target=/home/runner/.cache/cargo-binstall,uid=1000,gid=1000 \
    bash /build/install-tools.sh

# ---- Scoring runner --------------------------------------------------------
COPY --chown=runner:runner docker/score/score-anc100.sh /work/score-anc100.sh
WORKDIR /work
ENTRYPOINT ["/bin/bash", "/work/score-anc100.sh"]
