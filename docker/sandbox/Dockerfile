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

FROM docker.io/cloudflare/sandbox:0.9.2@sha256:3a8626db5d3d838d947abadd37b818e48628b17f12cf2e87d89b8e83a6676482 AS sandbox-base

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
        libstdc++6 \
        nodejs \
        npm \
        python3 \
        python3-pip \
        unzip \
        xz-utils \
    && rm -rf /var/lib/apt/lists/*

# Upstream Go (NOT Debian's golang-go). Debian builds Go with
# CGO_ENABLED=0, which makes GODEBUG=netdns=cgo silently fall back to
# Go's pure-Go resolver. The pure-Go resolver's IPv6 dual-stack
# behavior hangs on CF Containers (outbound IPv6 is unreliable),
# producing 60 s timeouts on `go install`. The official tarball ships
# with CGO enabled, so cgo resolver works and honors /etc/gai.conf's
# IPv4 precedence.
RUN set -eux; \
    curl -fsSL -o /tmp/go.tgz \
        https://go.dev/dl/go1.26.3.linux-amd64.tar.gz; \
    echo '2b2cfc7148493da5e73981bffbf3353af381d5f93e789c82c79aff64962eb556  /tmp/go.tgz' | sha256sum -c -; \
    tar xzf /tmp/go.tgz -C /usr/local/; \
    rm /tmp/go.tgz; \
    /usr/local/go/bin/go version

# Force IPv4 precedence in glibc's getaddrinfo. CF Containers' outbound
# IPv6 path is unreliable for many upstream endpoints; tools whose HTTP
# clients default to AAAA-first (cargo-binstall, go module proxy, curl,
# uv) otherwise hang on the IPv6 attempt before falling back to A.
# Python urllib3, npm, and bun happen to prefer A records and work
# without this. Uncomment the IPv4-mapped precedence line in
# /etc/gai.conf — glibc treats this as "rank IPv4 addresses above IPv6".
RUN sed -i 's/^#\(precedence ::ffff:0:0\/96  100\)/\1/' /etc/gai.conf

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

# Every PM's install destination redirected to /usr/local/bin so the
# post-install `which <binary>` gate in sandbox-exec.ts always looks in
# the same place. Mirrors the per-command flags
# (cargo-binstall --install-path, GOBIN=...) for the ENV-configurable
# package managers (bun, uv) so the convention is consistent across
# the entire install table.
ENV BUN_INSTALL=/usr/local
ENV UV_TOOL_BIN_DIR=/usr/local/bin
# Go's runtime DNS resolver bypasses glibc by default and ignores the
# IPv4-precedence fix in /etc/gai.conf above. Force the cgo resolver so
# `go install` honors the system address-selection policy.
ENV GODEBUG=netdns=cgo

ENV PATH="/usr/local/bin:/usr/local/cargo/bin:/usr/local/go/bin:${PATH}"

# Port 3000 is reserved by the CF Sandbox SDK; pick a different port so
# `wrangler dev --local` accepts the container binding without
# colliding with the SDK's internal HTTP server.
EXPOSE 8080

ENTRYPOINT ["/sandbox"]
