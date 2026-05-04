# Live-scoring sandbox image

Alpine + musl image for the live-scoring path. Carries the Cloudflare Sandbox SDK server, package managers
(cargo-binstall, pip, npm, go), and a pre-built musl `anc` baked in from agentnative-cli v0.3.1. NO COMPILERS, NO
TOOLCHAINS.

Plan reference:
[`docs/plans/2026-04-28-002-feat-live-scoring-cf-sandbox-plan.md`](../../docs/plans/2026-04-28-002-feat-live-scoring-cf-sandbox-plan.md)
U2.

## Build

From the repo root:

```sh
docker build -f docker/sandbox/Dockerfile -t anc-sandbox .
```

Verify the size budget (target <=350 MB compressed; fits CF Containers `basic`):

```sh
docker image inspect anc-sandbox --format '{{.Size}}' | numfmt --to=iec
```

Smoke-test the image:

```sh
# anc baked-in version check
docker run --rm anc-sandbox /usr/local/bin/anc --version
# expect: anc 0.3.1

# cargo-binstall path
docker run --rm anc-sandbox /usr/local/bin/cargo-binstall --version

# all expected pms on PATH
docker run --rm anc-sandbox sh -c \
  'cargo-binstall --version && pip --version && npm --version && go version'
```

End-to-end install probe (cargo-binstall path):

```sh
docker run --rm anc-sandbox sh -c \
  'cargo-binstall --no-confirm ripgrep && rg --version && anc check --command rg --output json | head -50'
```

## Push

The Worker references the image by digest, not tag, so pushes need the digest output captured:

```sh
docker tag anc-sandbox docker.io/brettdavies/anc-sandbox:latest
docker push docker.io/brettdavies/anc-sandbox:latest
```

`docker push` prints a `digest: sha256:...` line. Pin THAT digest in `wrangler.jsonc` `containers[].image` (U3) — never
the `latest` tag.

## SHA pinning

Three external assets are pinned by sha256 inside the Dockerfile:

| Asset                                               | Pinned at                                             |
| --------------------------------------------------- | ----------------------------------------------------- |
| `cloudflare/sandbox:0.9.2-musl`                     | image digest from Docker Hub                          |
| `alpine:3.21`                                       | multi-arch index digest from Docker Hub               |
| `cargo-binstall-x86_64-unknown-linux-musl.full.tgz` | sha256 of the GitHub release asset (computed locally) |
| `agentnative-x86_64-unknown-linux-musl.tar.gz`      | sha256 from the release's `sha256sum.txt`             |

To bump any pin, resolve the new sha and update both the URL line and the `echo '<sha> ...' | sha256sum -c -`
verification line. Keep them in sync.

To resolve the cloudflare/sandbox digest after a version bump:

```sh
curl -fsSL "https://hub.docker.com/v2/repositories/cloudflare/sandbox/tags/<tag>/" \
  | jaq -r '.images[0].digest'
```

## What's NOT in the image (and why)

- **brew.** Linuxbrew on Alpine + musl is not a supported configuration (linuxbrew assumes glibc symbols). User inputs
  that resolve to `pm: brew` via U4's chain hit U6's `chain_resolved_install_failed` bounce class.
- **C/C++/Rust toolchains.** `apk add build-base gcc rust` would balloon the image past the size budget AND violate
  Premise #2 (install-from-binary only). The `cargo install` (compile) path is intentionally absent — cargo-binstall's
  job is precompiled-only.
- **Specific source-only packages.** Anything that requires a compile during `pip install` (no wheel published) will
  fail at install-time. U6 `pip install --only-binary=:all:` makes that explicit.

## Two-phase egress

This image's role ends at "binary on PATH." Two-phase egress (Phase 1 allow-list to ecosystem hosts during install,
Phase 2 `noHttp` during `anc check`) is enforced at the Worker / DO layer in U6, not here. The sandbox SDK server
provides the `setOutbound*` primitives this image's `/sandbox` ENTRYPOINT exposes.
