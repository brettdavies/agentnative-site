# syntax=docker/dockerfile:1.7
#
# Live-scoring sandbox image. Carries the CF Sandbox SDK server plus
# package managers (cargo-binstall, pip, uv, npm, bun, go runtime) and
# a pre-built `anc` binary. No compilers — install paths must produce
# precompiled binaries or wheels.
#
# brew is NOT installed; `brew install <pkg>` user inputs are translated
# to an alternative PM via the discovery fallback in
# src/worker/score/do.ts:resolveSpec(). Brew-only formulae bounce as
# install_unsupported with pm=brew_only.
#
# Image budget: <=350 MB compressed. Verify locally:
#   docker build -f docker/sandbox/Dockerfile -t anc-sandbox .
#   docker image inspect anc-sandbox --format '{{.Size}}'

FROM docker.io/cloudflare/sandbox:0.9.4@sha256:f5f9a59ace0e364eb830464d31017515f8dc34837573da7386d2a59cebd360d0 AS sandbox-base

# Multi-arch index digest pinned; Docker resolves to the amd64 child at
# pull time.
FROM docker.io/library/debian:trixie-slim@sha256:109e2c65005bf160609e4ba6acf7783752f8502ad218e298253428690b9eaa4b AS final

COPY --from=sandbox-base /container-server/sandbox /sandbox

# bzip2 / unzip / xz-utils back the per-extension dispatch in
# sandbox-exec.ts directInstallCommand() for .tar.bz2 / .zip / .tar.xz
# releases. libstdc++6 satisfies the sandbox-server runtime dep.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash \
        bzip2 \
        ca-certificates \
        curl \
        git \
        golang-go \
        libstdc++6 \
        nodejs \
        npm \
        python3 \
        python3-pip \
        unzip \
        xz-utils \
    && rm -rf /var/lib/apt/lists/*

RUN set -eux; \
    curl -fsSL -o /tmp/cb.tgz \
        https://github.com/cargo-bins/cargo-binstall/releases/download/v1.19.0/cargo-binstall-x86_64-unknown-linux-gnu.full.tgz; \
    echo '651492fa1a5a57a8d5d8de38556c3cbb464d40fa82eda124780a61373783c157  /tmp/cb.tgz' | sha256sum -c -; \
    tar xzf /tmp/cb.tgz -C /usr/local/bin/ cargo-binstall; \
    rm /tmp/cb.tgz; \
    cargo-binstall -V

RUN set -eux; \
    curl -fsSL -o /tmp/anc.tgz \
        https://github.com/brettdavies/agentnative-cli/releases/download/v0.3.1/agentnative-x86_64-unknown-linux-gnu.tar.gz; \
    echo 'ab8696c2bc8e64bc47d7233136351e6325b7632b3d0e203c4b1bfd2bc6a24162  /tmp/anc.tgz' | sha256sum -c -; \
    tar xzf /tmp/anc.tgz -C /tmp/; \
    install -m 0755 /tmp/agentnative-x86_64-unknown-linux-gnu/anc /usr/local/bin/anc; \
    rm -rf /tmp/anc.tgz /tmp/agentnative-x86_64-unknown-linux-gnu; \
    anc --version

# `unzip -j` flattens the archive's `bun-linux-x64/` directory so the
# binary lands directly on PATH instead of in $HOME/.bun/bin.
RUN set -eux; \
    curl -fsSL -o /tmp/bun.zip \
        https://github.com/oven-sh/bun/releases/download/bun-v1.3.14/bun-linux-x64.zip; \
    echo '951ee2aee855f08595aeec6225226a298d3fea83a3dcd6465c09cbccdf7e848f  /tmp/bun.zip' | sha256sum -c -; \
    unzip -j /tmp/bun.zip 'bun-linux-x64/bun' -d /usr/local/bin/; \
    chmod 0755 /usr/local/bin/bun; \
    rm /tmp/bun.zip; \
    bun --version

# `uv tool install <pkg>` symlinks the installed binary into
# /root/.local/bin/<binary> (default UV_TOOL_BIN_DIR); the PATH below
# covers that directory.
RUN set -eux; \
    curl -fsSL -o /tmp/uv.tgz \
        https://github.com/astral-sh/uv/releases/download/0.11.15/uv-x86_64-unknown-linux-gnu.tar.gz; \
    echo 'b03e572f010bea94a4a52d42671ba72981e12894f71576181a1d26ff68546da7  /tmp/uv.tgz' | sha256sum -c -; \
    tar xzf /tmp/uv.tgz -C /tmp/; \
    install -m 0755 /tmp/uv-x86_64-unknown-linux-gnu/uv /usr/local/bin/uv; \
    install -m 0755 /tmp/uv-x86_64-unknown-linux-gnu/uvx /usr/local/bin/uvx; \
    rm -rf /tmp/uv.tgz /tmp/uv-x86_64-unknown-linux-gnu; \
    uv --version

ENV PATH="/usr/local/bin:/usr/local/cargo/bin:/usr/local/go/bin:/root/.local/bin:${PATH}"

# Port 3000 is reserved by the CF Sandbox SDK; pick a different port so
# `wrangler dev --local` accepts the container binding without
# colliding with the SDK's internal HTTP server.
EXPOSE 8080

ENTRYPOINT ["/sandbox"]
