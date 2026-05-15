# syntax=docker/dockerfile:1.7
#
# Live-scoring sandbox image (plan U2).
#
# Goal: Alpine + musl image carrying CF Sandbox 0.9.x-musl, package managers
# (cargo-binstall, pip, npm, go runtime), and a pre-built musl `anc` baked
# in from agentnative-cli v0.3.1. NO COMPILERS, NO TOOLCHAINS — install
# paths are: cargo binstall (precompiled), pip (wheels only), npm
# (--ignore-scripts), go install (downloads a precompiled artifact in
# practice for most modules; modules that build from source will fail
# install at U6 and bounce). Per Premise #2 of the 2026-04-17 CEO design.
#
# Image budget: <=350 MB compressed. Fits CF Containers `basic` instance
# type (1 GiB RAM / 4 GB disk). Verify locally:
#   docker build -f docker/sandbox/Dockerfile -t anc-sandbox .
#   docker image inspect anc-sandbox --format '{{.Size}}'
#
# Two-phase egress (R7) is enforced at the Worker / DO layer in U6; this
# image just provides the install + run substrate. PATH covers every
# location a binary might land after install via the supported pms.
#
# brew is intentionally OMITTED. Linuxbrew on Alpine + musl is not a
# supported configuration (linuxbrew assumes glibc symbols). User inputs
# that resolve to `pm: brew` via U4's chain hit U6's
# `chain_resolved_install_failed` bounce class and surface the
# install-anc-locally CTA. See plan U2 lines 945-988 for the rationale.

# ----------------------------------------------------------------------
# Stage 1: pull the CF Sandbox SDK server binary + its glibcxx dependency.
# Pinned to a digest so a forced re-tag of `0.9.2-musl` upstream cannot
# silently change what we're shipping.
# ----------------------------------------------------------------------
FROM docker.io/cloudflare/sandbox:0.9.2-musl@sha256:b4cb1d6996fa6be43bb4966bf3666db2d434f4d2a24dfb75e1d5e08194c5bd0a AS sandbox-base

# ----------------------------------------------------------------------
# Stage 2: Alpine 3.21 final image with pms + anc baked in.
# Multi-arch index digest pinned; Docker resolves to the amd64 child at
# pull time.
# ----------------------------------------------------------------------
FROM docker.io/library/alpine:3.21@sha256:48b0309ca019d89d40f670aa1bc06e426dc0931948452e8491e3d65087abc07d AS final

# Sandbox runtime: server binary + libstdc++ (the SDK server's only C++
# runtime dep). If Cloudflare drops the libstdc++ dep in a future SDK
# rev, the second COPY can be removed; the SDK server warns at startup
# if the lib is missing.
COPY --from=sandbox-base /container-server/sandbox /sandbox
COPY --from=sandbox-base /usr/lib/libstdc++.so.6 /usr/lib/libstdc++.so.6

# Package managers + interpreters. NO compilers (no build-base, no gcc,
# no rust toolchain, no go build-tools — just the go runtime so `go
# install` can download precompiled module artifacts).
#
# Why each:
# - bash: cargo-binstall + npm install scripts assume bash for $(...)
#   substitution; sh-only would surface as cryptic syntax errors.
# - ca-certificates: TLS for U6 Phase 1 outbound to ecosystem registries.
# - curl: U6 `direct` install path (curl ... | tar xz).
# - git: `go install` / npm postinstall fallback resolution.
# - go: `go install <module>@latest` requires the toolchain on PATH.
# - nodejs + npm: `npm i -g --ignore-scripts <pkg>`.
# - py3-pip + python3: `pip install --only-binary=:all: <pkg>`.
RUN apk add --no-cache \
        bash \
        ca-certificates \
        curl \
        git \
        go \
        nodejs \
        npm \
        py3-pip \
        python3

# cargo-binstall standalone (musl). Pinned URL + sha256.
RUN set -eux; \
    curl -fsSL -o /tmp/cb.tgz \
        https://github.com/cargo-bins/cargo-binstall/releases/download/v1.19.0/cargo-binstall-x86_64-unknown-linux-musl.full.tgz; \
    echo '15432865784b4aea8749673e7faf0f2939207f73f58c6aca4ba1b6b1e536df6a  /tmp/cb.tgz' | sha256sum -c -; \
    tar xzf /tmp/cb.tgz -C /usr/local/bin/ cargo-binstall; \
    rm /tmp/cb.tgz; \
    cargo-binstall -V

# `anc` musl bottle from agentnative-cli v0.3.1. Pinned URL + sha256
# from the release's sha256sum.txt.
RUN set -eux; \
    curl -fsSL -o /tmp/anc.tgz \
        https://github.com/brettdavies/agentnative-cli/releases/download/v0.3.1/agentnative-x86_64-unknown-linux-musl.tar.gz; \
    echo '90361f5bade856cfce3fc9e66703980f04f68e6f4fb86d48dfdb34f92e3b5785  /tmp/anc.tgz' | sha256sum -c -; \
    tar xzf /tmp/anc.tgz -C /tmp/; \
    install -m 0755 /tmp/agentnative-x86_64-unknown-linux-musl/anc /usr/local/bin/anc; \
    rm -rf /tmp/anc.tgz /tmp/agentnative-x86_64-unknown-linux-musl; \
    anc --version

ENV PATH="/usr/local/bin:/usr/local/cargo/bin:/usr/local/go/bin:/root/.local/bin:${PATH}"

ENTRYPOINT ["/sandbox"]
