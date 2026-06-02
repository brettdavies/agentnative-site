# Pre-release verification: `agentnative-site`

Operational pre-flight checklist. Runs **before** step 1 of
[`RELEASES.md` § Releasing dev to main](./RELEASES.md#releasing-dev-to-main). Gates the cut of the
`release/<YYYY-MM-DD>-<slug>` branch, not the daily dev integration. Each box is an explicit go/no-go. If any item is
unchecked or red, hold the release.

CI (`lint · build · test · wrangler`, the post-deploy smoke against the registry-fast-path, prose-scrub on `*.md`)
catches mechanical regressions inside this repo. This checklist covers what CI structurally can't:

- The live-scoring Sandbox DO path. CI smoke only exercises the registry-fast-path slug (`ripgrep`) — a curated
  scorecard that never invokes the container. The first non-registry input after a release goes live is the surface that
  exposes any drift between the Worker's CLI invocation and the container's baked `anc` binary. This category of bug
  shipped silently for three days in 2026-05 / 2026-06 (see
  [`docs/solutions/integration-issues/sandbox-image-anc-cli-rename-coordination-2026-06-01.md`](./docs/solutions/integration-issues/sandbox-image-anc-cli-rename-coordination-2026-06-01.md))
  and is the reason this preflight exists.
- Cross-repo version coherence (vendored spec, vendored skill manifest, baked anc CLI vs Worker invocation).
- Container rollout state. Cloudflare reports `wrangler deploy` success the moment the application manifest is updated
  while instances drain asynchronously. A smoke that races the rollout sees an OLD-image instance and looks identical to
  a real bug (see
  [`docs/solutions/workflow-issues/cloudflare-container-rollout-readiness-before-smoke.md`](./docs/solutions/workflow-issues/cloudflare-container-rollout-readiness-before-smoke.md)).
- Distribution surfaces that only exercise on real artifacts (markdown twins, canonical redirects, Static-Assets cache
  headers, skill manifest live render).

## Establish the surface

Everything below assumes you know what's changing. Run this first.

```bash
LAST_RELEASE=$(git log origin/main --oneline -n 1 --format='%H')
git log "$LAST_RELEASE..origin/dev" --oneline                    # commits going out
git diff "$LAST_RELEASE..origin/dev" --stat                      # file-level scope
git diff "$LAST_RELEASE..origin/dev" -- wrangler.jsonc           # bindings, pins, env drift
git diff "$LAST_RELEASE..origin/dev" -- src/worker/score/        # live-scoring surface
git diff "$LAST_RELEASE..origin/dev" -- docker/sandbox/          # container image
git diff "$LAST_RELEASE..origin/dev" -- src/data/                # vendored spec / anc / skill VERSIONs
git diff "$LAST_RELEASE..origin/dev" -- scorecards/              # scored corpus changes
git diff "$LAST_RELEASE..origin/dev" -- registry.yaml            # editorial changes
```

Note which of `wrangler.jsonc`, `docker/sandbox/`, `src/data/spec/VERSION`, `src/data/anc/VERSION`,
`src/data/skill/skill.json`, or `src/worker/score/sandbox-exec.ts` changed. Each one drives a specific check below.

## Checklist

### Cross-repo coordination

This is the section where rename-class coordination bugs live. The fixes are mechanical but the failure mode is silent
until traffic exercises the affected surface.

- [ ] **`anc` CLI baked in the staging container matches the Worker's invocation vocabulary.** Pull the staging image
  pin from `wrangler.jsonc` (`env.staging.containers[0].image`) and confirm the baked binary supports the subcommand the
  Worker shells out to:

  ```bash
  STAGING_PIN=$(jq -r '.env.staging.containers[0].image' wrangler.jsonc)
  docker pull "$STAGING_PIN"
  docker run --rm --entrypoint /usr/local/bin/anc "$STAGING_PIN" --version
  docker run --rm --entrypoint /usr/local/bin/anc "$STAGING_PIN" --help | grep -E '^  (audit|check) '
  grep -nE "anc (audit|check)" src/worker/score/sandbox-exec.ts
  ```

  The subcommand the Worker shells out to MUST be one of the subcommands listed in the baked binary's `--help`. The
  one-line failure case: Worker invokes `anc audit ...` against a container that still bakes the pre-rename `anc`
  (which only knows `check`). Result: 500 on every non-registry input.

- [ ] **Production container pin baked anc supports the same vocabulary.** Repeat the check above against the top-level
  `containers[0].image` pin if production scoring is enabled OR if this release will lockstep-bump both pins.
- [ ] **Vendored spec VERSION coherence.** `src/data/spec/VERSION` must match the expected spec version for this
  release. If the spec repo cut a new VERSION, this site needs the vendored copy updated and committed in the same
  release window. Confirm:

  ```bash
  cat src/data/spec/VERSION
  cat src/data/anc/VERSION
  cat content/principles/VERSION
  ```

  The site footer renders `spec/VERSION`; the `/api/score` response envelope embeds `site_spec_version` from
  `content/principles/VERSION`. Drift between the two is a footer-vs-API contradiction. The Worker's build-time
  `SPEC_VERSION` constant in `src/worker/spec-version.gen.ts` is regenerated from `src/data/spec/VERSION`; if you
  bumped one without regenerating the other, the build will fail loud — confirm `bun run build` ran clean during CI.
- [ ] **Vendored skill manifest version coherence.** `src/data/skill/skill.json` `version` field must match the live
  `agent-native-cli` release in `brettdavies/agentnative-skill`. If only the per-host install commands changed upstream,
  the manifest still needs the matching version bump. CHECK:

  ```bash
  jq -r '.version, .name' src/data/skill/skill.json
  curl -fsSL https://api.github.com/repos/brettdavies/agentnative-skill/releases/latest | jq -r '.tag_name'
  ```

  If the manifest version is BEHIND the skill repo's latest release, follow
  [`RELEASES.md` § Skill releases](./RELEASES.md#skill-releases) to land the bump before tagging this release.
- [ ] **CLI release URL in `docker/sandbox/Dockerfile` resolves.** The Dockerfile fetches a specific anc release tarball
  at build time. Confirm the URL is reachable and that the recorded sha256 matches:

  ```bash
  URL=$(grep -oE 'https://github.com/[^ ]*agentnative-x86_64-unknown-linux-gnu.tar.gz' docker/sandbox/Dockerfile)
  SHA=$(grep -oE "[a-f0-9]{64}" docker/sandbox/Dockerfile | head -1)
  curl -fsSL "$URL" -o /tmp/anc.tgz && sha256sum /tmp/anc.tgz && echo "Expected: $SHA"
  ```

  Bit-rot here means the next image rebuild will fail at the integrity check — caught loud but only when the rebuild
  is actually attempted.

### Build and asset integrity

Catches build-time invariant drift before it reaches a deploy.

- [ ] **`bun run build` exits 0 from a clean working tree.** Watches for invariant violations in
  `runScorecardInvariants` (every scorecard file in `scorecards/` must match its filename slug to a `registry.yaml`
  entry, every scorecard must declare a supported `schema_version`, `tool.version` from the filename must align with the
  scorecard body).

  ```bash
  bun run build
  ```

- [ ] **Scorecard corpus integrity.** Confirm no scorecard is below the supported `schema_version` floor and no registry
  entry is orphaned:

  ```bash
  ls scorecards/*.json | wc -l            # all curated scorecards
  bun run build 2>&1 | grep -i "WARNINGS_JSON"
  ```

  `WARNINGS_JSON` should be `{"scorecardOrphans":[],"registryOrphans":[]}`. Anything else means the curated corpus and
  the registry have drifted and the leaderboard will silently exclude rows.
- [ ] **Badge SVGs exist for every registry tool.** The build emits `dist/badge/<name>.svg` per scored tool. A missing
  SVG ships as a broken image on the embedded badge anywhere consumers reference it. After `bun run build`:

  ```bash
  diff <(ls scorecards/ | sed -E 's/-v[^/]+\.json$//' | sort -u) \
       <(ls dist/badge/ | sed -E 's/\.svg$//' | sort -u)
  ```

  Empty diff is green. Any registry entry without a badge SVG is a regression.
- [ ] **Markdown twins exist for every emitted HTML page.** Every page on the site ships a `.md` twin (`Accept:
  text/markdown` and the URL-suffix path both resolve). After build:

  ```bash
  diff <(find dist -name '*.html' -not -path 'dist/_internal/*' | sed -E 's/\.html$//' | sort) \
       <(find dist -name '*.md' | sed -E 's/\.md$//' | sort)
  ```

  Empty diff is green. Pages without twins break the content-negotiation invariant.

### Live-scoring Sandbox DO path (mandatory)

The reason this preflight file exists. CI cannot catch this category, and the cost of letting it ship is a user-facing
500 on every non-registry input. **Do not skip these checks. Do not accept "but it worked last release."**

- [ ] **Pick a fresh non-registry binary for this release.** Do not re-use a fixture indefinitely — once a binary is
  added to `registry.yaml`, it stops exercising the DO path because the registry-fast-path short-circuits before the
  Sandbox is invoked. Confirm the binary is NOT in the registry:

  ```bash
  BINARY=cowsay   # rotate per release; pick something tiny and stable
  grep -E "^- name: ${BINARY}$" registry.yaml && echo "FAIL: already in registry, pick another" || echo "ok"
  ```

  Suggested rotation list (small, stable, npm/cargo-available): `cowsay`, `figlet`, `sl`, `lolcat`. If all four end up
  registered, pick another small tool with a public GitHub URL.
- [ ] **Container app is in `ready` state on staging.** If any commit in this release modifies `docker/sandbox/` or
  advances `env.staging.containers[0].image` in `wrangler.jsonc`, the staging container app rolls asynchronously after
  deploy. Wait for `ready` before smoking. Full pattern in
  [`docs/solutions/workflow-issues/cloudflare-container-rollout-readiness-before-smoke.md`](./docs/solutions/workflow-issues/cloudflare-container-rollout-readiness-before-smoke.md);
  one-liner:

  ```bash
  bun x wrangler containers list | grep agentnative-site-staging-sandbox-staging
  # STATE must read `ready`, not `provisioning`
  ```

  Loop until `ready` or escalate after ~5 minutes. A smoke during `provisioning` is inconclusive and will land on
  warm OLD-image instances.
- [ ] **Live DO smoke against staging returns a full scorecard.** With CF Access service-token headers from 1Password
  (see [`RELEASES.md` § Staging access](./RELEASES.md#staging-access-cloudflare-access)):

  ```bash
  curl -fSsL -H "Content-Type: application/json" \
    -H "CF-Access-Client-Id: ${CF_ACCESS_CLIENT_ID}" \
    -H "CF-Access-Client-Secret: ${CF_ACCESS_CLIENT_SECRET}" \
    -d "{\"input\":\"https://github.com/<owner>/${BINARY}\",\"turnstile_token\":\"x\"}" \
    https://agentnative-site-staging.brettdavies.workers.dev/api/score \
    | jq '{
        ok:           (.scorecard != null and .scorecard.tool.binary != null),
        binary:       .scorecard.tool.binary,
        score_pct:    .scorecard.badge.score_pct,
        anc_version:  .anc_version,
        spec_version: .spec_version,
        share_url:    .share_url,
        error:        .error
      }'
  ```

  Green outcome (all must be true):

- `ok: true`, no `error`
- `binary` matches the input
- `anc_version` and `spec_version` populated
- `share_url` shaped `/score/live/<binary>`

  Red outcomes (block the release):

- HTTP 500, `error.code: "incomplete_response_contract"` →
- `details: anc_audit_failed: ...` → CLI invocation incompatible with the container's `anc` binary. Bump the container
  image and the staging pin, redeploy, re-run this check after the rollout reaches `ready`.
- `details: chain_resolved_install_failed: pm=<pm>` → install pipeline broke for that package manager inside the
  sandbox. Investigate the install layer.
- `details: timeout` → DO budget exceeded. Check install or audit duration in observability.
- HTTP 503 `sandbox_unavailable` → container app not bound. Verify the staging `containers[]` block and `wrangler
  containers list`.
- [ ] **Share-URL renders the full scorecard.** Confirm the live-scored share URL the smoke just minted renders:

  ```bash
  curl -fSsL -H "CF-Access-Client-Id: ${CF_ACCESS_CLIENT_ID}" \
    -H "CF-Access-Client-Secret: ${CF_ACCESS_CLIENT_SECRET}" \
    https://agentnative-site-staging.brettdavies.workers.dev/score/live/${BINARY} \
    | grep -E 'scorecard-(summary|audits|meta|embed)'
  ```

  At least four classes (`scorecard-summary`, `scorecard-audits`, `scorecard-meta`, `scorecard-embed`) should appear,
  proving the shared renderer is producing parity sections.
- [ ] **Curated-tool redirect at `/score/live/<curated-binary>` still 301s to `/score/<slug>`.** This is the
  defense-in-depth redirect for stale cache entries and direct URL construction. Pick any registry binary (e.g., `anc`,
  `rg`):

  ```bash
  curl -sSI -H "CF-Access-Client-Id: ${CF_ACCESS_CLIENT_ID}" \
    -H "CF-Access-Client-Secret: ${CF_ACCESS_CLIENT_SECRET}" \
    https://agentnative-site-staging.brettdavies.workers.dev/score/live/anc \
    | grep -E '^(HTTP|location:)'
  ```

  Expect `HTTP/2 301` and `location: /score/anc`. A 200 here means a curated tool would render twice — once at the
  live path and once at the static path — with no canonical hint.

### Distribution and asset serving

Surfaces that don't fail unit tests but break the user experience.

- [ ] **`/check` → `/audit` redirect still serves.** The 2026-05-29 rename PR added a 301 from the prior URL. Confirm
  against staging:

  ```bash
  curl -sSI -H "CF-Access-Client-Id: ${CF_ACCESS_CLIENT_ID}" \
    -H "CF-Access-Client-Secret: ${CF_ACCESS_CLIENT_SECRET}" \
    https://agentnative-site-staging.brettdavies.workers.dev/check | head -3
  # HTTP/2 301
  # location: /audit
  ```

- [ ] **Skill manifest endpoint serves the bumped version.** If `src/data/skill/skill.json` changed in this release:

  ```bash
  curl -fSsL -H "CF-Access-Client-Id: ${CF_ACCESS_CLIENT_ID}" \
    -H "CF-Access-Client-Secret: ${CF_ACCESS_CLIENT_SECRET}" \
    https://agentnative-site-staging.brettdavies.workers.dev/skill.json | jq '.version, .name'
  ```

  Must match the version in `src/data/skill/skill.json`. Mismatch means the asset cache is stale; purge via
  the cache-purge API (see [`RELEASES.md` § Skill releases](./RELEASES.md#skill-releases) step 5).
- [ ] **Staging Worker carries `X-Robots-Tag: noindex`.** Prevents the staging clone from being indexed. Verify on any
  page:

  ```bash
  curl -sSI -H "CF-Access-Client-Id: ${CF_ACCESS_CLIENT_ID}" \
    -H "CF-Access-Client-Secret: ${CF_ACCESS_CLIENT_SECRET}" \
    https://agentnative-site-staging.brettdavies.workers.dev/ | grep -i x-robots-tag
  # x-robots-tag: noindex
  ```

  If absent on staging, the staging-host guard in `src/worker/headers.ts` regressed.

### Release mechanics sanity

These items duplicate steps from `RELEASES.md` deliberately: easy to skip, expensive to recover from. Confirm
explicitly.

- [ ] **Leak check before pushing the release branch.** No guarded path may surface in the cherry-picked diff (these
  paths are `dev`-direct per the branching rule):

  ```bash
  git diff origin/main..HEAD --name-only \
    | grep -E '^(docs/plans|docs/brainstorms|docs/ideation|docs/reviews|docs/solutions|\.context)' \
    && echo "LEAKED: reset and redo" || echo "(clean)"
  ```

- [ ] **Triple-diff verification clean.** Per `RELEASES.md` § Releasing dev to main:

  ```bash
  git diff origin/main..HEAD --stat                                              # A: ship surface
  git diff HEAD..origin/dev --name-only | grep -v '^docs/' || echo "(none)"      # B: no missed picks
  git diff origin/dev..origin/main --stat | tail -5                              # C: phantom-commits sanity
  ```

- [ ] **PR body scrubbed via `/unslop`.** Author in `/tmp/`, run Vale + LanguageTool + `/unslop`, submit via
  `--body-file`. Never inline `--body` / `-m` / heredoc (the `heredoc-pr-guard.sh` PreToolUse hook will reject it). Full
  procedure: [`RELEASES.md` § Prose scrubbing](./RELEASES.md#prose-scrubbing).
- [ ] **No em-dashes in the PR body.** Strip `—` before submission. Use colons, periods, or parentheses.

### Post-tag verification

Run immediately after the `release/*` PR merges to `main`. The production deploy fires automatically; this checklist
confirms it worked.

- [ ] **Production deploy green end-to-end.** `gh run watch <run-id> --exit-status`, then verify explicitly per
  `~/.claude/ci-watch-prompt.sh`:

  ```bash
  gh pr view <num> --json statusCheckRollup,mergeStateStatus \
    --jq '{merge: .mergeStateStatus, checks: [.statusCheckRollup[] | {name, conclusion}]}'
  ```

  Every conclusion must be `SUCCESS`. The watcher exit code alone is not authoritative.
- [ ] **Production container app reaches `ready`.** Same pattern as staging — if the release advanced the production
  pin, wait for the rollout:

  ```bash
  bun x wrangler containers list | grep agentnative-site-sandbox
  ```

  State must be `ready` before smoking the live path.
- [ ] **`anc.dev` front page + leaderboard render.** Smoke against the production custom domain (no CF Access on
  production):

  ```bash
  curl -fSsL https://anc.dev/ | grep -q '<title>' && echo "home: ok"
  curl -fSsL https://anc.dev/scorecards | grep -q 'leaderboard-table' && echo "leaderboard: ok"
  curl -fSsL https://anc.dev/api/score -X POST \
    -H 'Content-Type: application/json' \
    -d '{"input":"ripgrep","turnstile_token":"x"}' \
    | jq '.scorecard.kind, .anc_version, .spec_version'
  # "registry_hit"
  # <anc_version>
  # <spec_version>
  ```

- [ ] **Production live-DO smoke against a non-registry binary.** Production binds the real Turnstile site key + secret
  (staging uses Cloudflare's always-pass test pair), so the staging-style curl recipe with `turnstile_token:"x"` returns
  `turnstile_failed` against `anc.dev`. Pick one of two paths:

- **Manual (operator-only path).** Open `https://anc.dev/` in a browser, paste the same fresh non-registry binary picked
  for staging into the form (e.g., `npm install -g cowsay`), submit, watch the live run complete, then visit the
  resulting share URL (`/score/live/<binary>`) and confirm the four scorecard classes render (`scorecard-summary`,
  `scorecard-audits`, `scorecard-meta`, `scorecard-embed`).
- **Service-token (CI / scripted path).** Once the service-token bypass lands per the plan at
  [`docs/plans/2026-06-01-003-feat-production-live-do-smoke-bypass-plan.md`](./docs/plans/2026-06-01-003-feat-production-live-do-smoke-bypass-plan.md),
  re-use the staging smoke recipe with an added `X-Anc-Smoke-Token: ${SMOKE_SERVICE_TOKEN}` header. The bypass skips
  Turnstile only; rate-limit + kill-switch stay enforced; bypassed runs emit a distinct telemetry tag (`freshness:
  "live-smoke"`) so they stay separable from user traffic in Analytics Engine.

  Either path satisfies the box. Until the bypass ships, the manual browser path is the only option.
- [ ] **Cache-purge after deploys that change `/skill`, `/skill.json`, `/skill.md`.** Cloudflare's edge cache holds
  these for the configured TTL; manual purge brings the new version live immediately. Token in 1Password
  (`scripts/staging-cache-smoke.sh` references the item).

## Related docs

- [`RELEASES.md`](./RELEASES.md): operational runbook this checklist gates. The "Releasing dev to main" section
  references back here as step 0.
- [`RELEASES-RATIONALE.md`](./RELEASES-RATIONALE.md): release-flow rationale (branching model, soak-then-promote, CI
  smoke scope).
-

[`docs/solutions/integration-issues/sandbox-image-anc-cli-rename-coordination-2026-06-01.md`](./docs/solutions/integration-issues/sandbox-image-anc-cli-rename-coordination-2026-06-01.md):
the coordination trap this checklist exists to prevent. -
[`docs/solutions/workflow-issues/cloudflare-container-rollout-readiness-before-smoke.md`](./docs/solutions/workflow-issues/cloudflare-container-rollout-readiness-before-smoke.md):
the rollout-readiness discipline that gates the live-DO smoke.

- [`docs/runbooks/live-scoring-monitoring.md`](./docs/runbooks/live-scoring-monitoring.md): operator telemetry,
  error-tier breakdown, kill-switch flip.
