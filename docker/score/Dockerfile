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

# Bookworm (Debian 12) ships GLIBC 2.36, which is older than what Cargo
# emits when building anc on the host (Ubuntu 24.04 / GLIBC 2.39). Trixie
# (Debian 13) ships GLIBC 2.41 — satisfies the binary's GLIBC_2.39
# requirement without forcing us to switch base distros.
FROM debian:trixie-slim AS base

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

# ---- Other package managers ------------------------------------------------
# uv = Python tool runner; bun = JS runtime + package manager;
# cargo-binstall = Rust prebuilt-only installer.
#
# `bun` is not in homebrew-core on Linux — only the macOS formula. The
# canonical Linux brew install is via the official `oven-sh/bun` tap, which
# `brew install` auto-taps when given the fully-qualified `tap/formula`
# spec. uv + cargo-binstall are in homebrew-core, no tap needed.
#
# Cache mount on the brew bottle download dir so re-runs reuse downloads.
RUN --mount=type=cache,target=/home/runner/.cache/Homebrew,uid=1000,gid=1000 \
    brew install uv cargo-binstall oven-sh/bun/bun

# ---- Ergonomic tools the runner script depends on --------------------------
# yq for parsing registry.yaml; jaq for JSON validation.
RUN --mount=type=cache,target=/home/runner/.cache/Homebrew,uid=1000,gid=1000 \
    brew install yq jaq

# uv tool install drops binaries in ~/.local/bin; bun add -g drops them in
# ~/.bun/bin; cargo-binstall in ~/.cargo/bin. All three need to be on PATH so
# the post-install `command -v <binary>` check (in install-tools.sh) and the
# scoring runtime can resolve them. /home/runner/.local/bin sits first so
# inject-mode's anc binary at that path wins over anything install-tools.sh
# later brews into /home/linuxbrew/.linuxbrew/bin (notably the registry's
# own `anc` entry which runs `brew install brettdavies/tap/agentnative`).
ENV PATH=/home/runner/.local/bin:/home/runner/.bun/bin:/home/runner/.cargo/bin:$PATH

# ---- Pre-bake every registry tool ------------------------------------------
# Build-time registry lives at /build/registry.yaml — immutable, frozen at
# image-build. Runtime registry is bind-mounted to /work/registry.yaml by
# compose so the runner sees the host's current registry. The runner diffs
# the two and warns on drift (added/removed tools that didn't make it into
# the install layer).
#
# This layer takes the longest (~5-7 minutes warm, ~20-40 minutes cold).
# Docker caches it so subsequent rebuilds skip ahead unless registry.yaml
# or install-tools.sh changed. The anc-install layer below it intentionally
# does NOT precede this one — putting anc above install-tools meant every
# `--from-source` build dirtied install-tools too, paying the full reinstall
# cost. With install-tools BEFORE anc-install, only the anc layer
# invalidates on cargo rebuilds.
#
# Tool freshness is handled at run time by score-anc100.sh's per-tool
# update step (brew upgrade / uv tool upgrade / bun add -g re-resolution
# / cargo binstall --force) rather than by busting this layer's cache.
# That way the heavy install step runs only when registry.yaml changes,
# and "always test against latest" still holds via the run-time refresh.
#
# BuildKit cache mounts on every package manager's download cache: re-runs
# (when registry.yaml does change) reuse cached bottles/wheels/tarballs and
# skip the network downloads. The CACHED dirs do NOT carry into the final
# image — only the actually-installed binaries do.
COPY --chown=runner:runner registry.yaml /build/registry.yaml
COPY --chown=runner:runner docker/score/install-tools.sh /build/install-tools.sh
RUN --mount=type=cache,target=/home/runner/.cache/Homebrew,uid=1000,gid=1000 \
    --mount=type=cache,target=/home/runner/.cache/uv,uid=1000,gid=1000 \
    --mount=type=cache,target=/home/runner/.cache/cargo-binstall,uid=1000,gid=1000 \
    bash /build/install-tools.sh
# Note: bun install cache mount is intentionally omitted. With a persistent
# `--mount=type=cache,target=~/.bun/install/cache`, repeated `bun add -g`
# installs in the install-tools layer fail with "AccessDenied" (verified
# 2026-04-28 — the same install commands succeed reliably in a fresh
# container with no cache). Wall-time cost of redownloading bun packages
# at build time is small (~5s per package, well under a minute total).

# ---- The anc binary ---------------------------------------------------------
# Sits AFTER install-tools so cargo-rebuilds (--from-source) only invalidate
# this layer, not the heavy install-tools layer above. Two modes, selected
# by build arg ANC_SOURCE (default: brew):
#
#   ANC_SOURCE=brew   — brew-install from brettdavies/tap/agentnative. Same
#                        install path users get on macOS / Linux; the brewed
#                        binary lives in /home/linuxbrew/.linuxbrew/bin and
#                        resolves to a release tag's bottle.
#   ANC_SOURCE=inject — copy a host-built binary from docker/score/inject/anc
#                        into /home/runner/.local/bin/anc, which is first in
#                        PATH. Bypasses brew install entirely. Use for
#                        testing an unreleased anc (feature branch in
#                        agentnative-cli) without waiting on a tag + bottle.
#                        docker/score/build.sh --from-source <path-to-cli-repo>
#                        orchestrates the cargo build + image build in one step.
#
# Inject lands at /home/runner/.local/bin/anc because install-tools.sh above
# may have brewed the registry's `anc` entry, leaving /home/linuxbrew/...bin/anc.
# /home/runner/.local/bin sits first in PATH, so the inject binary wins.
ARG ANC_SOURCE=brew

COPY --chown=runner:runner docker/score/inject/ /tmp/anc-inject/

RUN --mount=type=cache,target=/home/runner/.cache/Homebrew,uid=1000,gid=1000 \
    case "$ANC_SOURCE" in \
      brew) \
        brew install brettdavies/tap/agentnative ;; \
      inject) \
        if [ ! -f /tmp/anc-inject/anc ]; then \
          echo "error: ANC_SOURCE=inject but docker/score/inject/anc is missing in build context" >&2; \
          echo "       run via: docker/score/build.sh --from-source <path-to-cli-repo>" >&2; \
          exit 1; \
        fi && \
        install -m 0755 /tmp/anc-inject/anc /home/runner/.local/bin/anc ;; \
      *) \
        echo "error: ANC_SOURCE must be 'brew' or 'inject' (got: $ANC_SOURCE)" >&2; \
        exit 1 ;; \
    esac && \
    anc --version

# ---- Scoring runner --------------------------------------------------------
COPY --chown=runner:runner docker/score/score-anc100.sh /work/score-anc100.sh
WORKDIR /work
ENTRYPOINT ["/bin/bash", "/work/score-anc100.sh"]
