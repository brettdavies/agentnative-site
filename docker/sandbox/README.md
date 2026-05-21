# Live-scoring sandbox image

Debian-trixie-slim + glibc image for the live-scoring path. Carries the Cloudflare Sandbox SDK server, package managers
(`cargo-binstall`, `pip`, `uv`, `npm`, `bun`, `go` runtime), and a pre-built `anc` binary from agentnative-cli v0.3.1.
NO COMPILERS, NO TOOLCHAINS.

Plan reference:
[`docs/plans/2026-04-28-002-feat-live-scoring-cf-sandbox-plan.md`](../../docs/plans/2026-04-28-002-feat-live-scoring-cf-sandbox-plan.md)
U2 + U6.

## Build and push

The Worker pins this image by tag in the Cloudflare managed registry, not by Docker Hub digest. Build and push happen in
a single local command via `wrangler containers build -p`; deploy never rebuilds.

From the repo root, on a clean working tree:

```sh
GIT_SHA=$(git rev-parse --short HEAD)
bun x wrangler containers build -p -t "anc-sandbox:$GIT_SHA" docker/sandbox/
```

This builds locally via Docker (the daemon must be running) and pushes the resulting image to
`registry.cloudflare.com/<account-id>/anc-sandbox:<git-sha>`, authenticated via `CLOUDFLARE_API_TOKEN`. Wrangler
resolves the account ID from auth at push time. Push output ends with a line like:

```text
<git-sha>: digest: sha256:... size: ...
```

Pin the resulting tag in `wrangler.jsonc`. The file holds two independent pins, and the choice of which one(s) to update
depends on the change:

- For a normal sandbox change (any commit past the base-image FROM line): update only `env.staging.containers[0].image`.
  The image soaks on staging, then a separate release PR to main promotes the top-level (prod) pin to match. This is the
  default and what the CI guard expects.
- For a low-risk bump (base-image security patch, dependency-only update with no behavior delta): update both pins in
  lockstep. The CI guard accepts equal pins too.

See [RELEASES.md § Sandbox image releases](../../RELEASES.md#sandbox-image-releases-live-scoring) for the full
soak-then-promote flow and the release-time invariant the main-targeting CI check enforces.

After pinning, deploy without rebuilding:

```sh
bun x wrangler deploy --env staging
# verify staging is healthy, then promote via the dev → main release flow
```

`wrangler deploy` against a fully-qualified `registry.cloudflare.com/...` URI does NOT rebuild. The image is already in
the registry from the build step.

### Sanity probes

Local smoke before pushing (optional but recommended on Dockerfile changes):

```sh
# anc baked-in version check
docker run --rm "anc-sandbox:$GIT_SHA" /usr/local/bin/anc --version
# expect: anc 0.3.1

# all expected pms on PATH
docker run --rm "anc-sandbox:$GIT_SHA" sh -c \
  'cargo-binstall --version && pip --version && uv --version && npm --version && bun --version && go version'
```

Image size against the budget (<=350 MB compressed; fits CF Containers `basic`):

```sh
docker image inspect "anc-sandbox:$GIT_SHA" --format '{{.Size}}' | numfmt --to=iec
```

End-to-end install probe (cargo-binstall path):

```sh
docker run --rm "anc-sandbox:$GIT_SHA" sh -c \
  'cargo-binstall --no-confirm ripgrep && rg --version && anc check --command rg --output json | head -50'
```

### List, verify, retain

After pushing, confirm the tag landed in the CF registry:

```sh
bun x wrangler containers images list
# look for the anc-sandbox row with the tag matching $GIT_SHA
```

### Image-retention discipline

NEVER delete a tag from the CF managed registry that backed a shipped Worker version. Deletion silently breaks `wrangler
rollback` for any version that referenced the deleted image, per
[Containers Limits](https://developers.cloudflare.com/containers/platform-details/limits/). The 50 GB account-wide cap
will eventually require a prune; treat it as a quarterly manual exercise paired with explicit review of which Worker
versions become unrollback-able. Pair every git release tag with the registry URI in `RELEASES.md` so the inventory
survives.

### Build-context exclusions

`docker/sandbox/.dockerignore` lists files that must not enter the build context. The current Dockerfile uses only
multi-stage `COPY --from=` (no copy from the build context), so `.dockerignore` is forward-looking: it protects any
future change that adds `COPY <ctx> ...` to the Dockerfile. `.ignored-sentinel.txt` is a regression probe: if it ever
appears in a deployed layer, `.dockerignore` has stopped being read by the builder.

### GHA fallback (offline-Brett case only)

If you cannot run `wrangler containers build` locally, set the `image:` field temporarily back to a Dockerfile path
(`./docker/sandbox/Dockerfile`) and let `cloudflare/wrangler-action` build inline on `ubuntu-latest`. Expect a ~60-130s
cold build per deploy (no GHA-side layer cache; `cloudflare/wrangler-action` shells out to plain `docker build`). The
registry-side push is auto-skipped when the resulting image already exists at the same tag (`"Image already exists
remotely, skipping push"`). This is a fallback; the primary path is the local build above.

## SHA pinning

Each external asset baked into the image is pinned by sha256 inside the Dockerfile:

| Asset                                              | Pinned at                                             |
| -------------------------------------------------- | ----------------------------------------------------- |
| `cloudflare/sandbox:0.9.4`                         | image digest from Docker Hub                          |
| `debian:trixie-slim`                               | multi-arch index digest from Docker Hub               |
| `cargo-binstall-x86_64-unknown-linux-gnu.full.tgz` | sha256 of the GitHub release asset (computed locally) |
| `agentnative-x86_64-unknown-linux-gnu.tar.gz`      | sha256 from the release's `sha256sum.txt`             |
| `bun-linux-x64.zip` (bun-v1.3.14)                  | sha256 from the release's `SHASUMS256.txt`            |
| `uv-x86_64-unknown-linux-gnu.tar.gz` (0.11.15)     | sha256 from the release's `<asset>.sha256` file       |

To bump any pin, resolve the new sha and update both the URL line and the `echo '<sha> ...' | sha256sum -c -`
verification line. Keep them in sync.

To resolve the cloudflare/sandbox digest after a version bump:

```sh
curl -fsSL "https://hub.docker.com/v2/repositories/cloudflare/sandbox/tags/<tag>/" \
  | jaq -r '.digest'
```

For other GitHub-hosted releases (`agentnative-cli`, `cargo-binstall`, `uv`) the sha256 ships next to the binary
(`sha256sum.txt`, `<asset>.sha256`). For `bun`, the release page ships a `SHASUMS256.txt`. Always read the upstream
checksum file rather than computing locally, because the upstream value is what you're trusting.

## What's NOT in the image (and why)

- **brew.** Linuxbrew on Linux takes 20-60 s per install for most formulae; complex formulae exceed the 60 s install +
  score budget. `brew install <pkg>` user inputs route through the discovery-fallback in
  `src/worker/score/do.ts:resolveSpec()`: fetch the formula metadata from `formulae.brew.sh`, parse the homepage as a
  GitHub URL, run the existing `discoverBinary` chain to find an alternative (crates, npm, PyPI, go, direct). Formulae
  without a peer PM bounce as `install_unsupported pm=brew_only`.
- **C/C++/Rust toolchains.** `apt-get install build-essential gcc rustc` would balloon the image past the size budget
  AND violate Premise #2 (install-from-binary only). The `cargo install` (compile) path is intentionally absent because
  cargo-binstall's job is precompiled-only.
- **Specific source-only packages.** Anything that requires compilation during `pip install` (no wheel published) will
  fail at install-time. U6 `pip install --only-binary=:all:` makes that explicit.

## Two-phase egress

This image's role ends at "binary on PATH." Two-phase egress (Phase 1 allow-list to ecosystem hosts during install,
Phase 2 `noHttp` during `anc check`) is enforced at the Worker / DO layer in U6, not here. The sandbox SDK server
provides the `setOutbound*` primitives this image's `/sandbox` ENTRYPOINT exposes.
