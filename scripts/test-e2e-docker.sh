#!/usr/bin/env bash
# Run the Playwright e2e suite inside Microsoft's official Playwright image,
# which ships every browser system library CI needs. Use this when your
# local box is missing WebKit deps (no sudo, no apt access) — gets you
# exact env parity with the `playwright install --with-deps chromium webkit`
# step in .github/workflows/ci.yml.
#
# Bump the image tag in lockstep with @playwright/test in package.json.
# CI is pinned to Playwright 1.59.1, so this stays :v1.59.1-noble.

set -euo pipefail

IMAGE="mcr.microsoft.com/playwright:v1.59.1-noble"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

exec docker run --rm --ipc=host \
  -v "$REPO_ROOT:/app" \
  -w /app \
  -e CI=1 \
  "$IMAGE" bash -lc '
    set -euo pipefail
    curl -fsSL https://bun.sh/install | bash >/dev/null
    export PATH="$HOME/.bun/bin:$PATH"
    bun install --frozen-lockfile
    bun run build
    bun run test:e2e
  '
