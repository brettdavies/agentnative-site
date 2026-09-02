# Live-surface sweep runbook

How the deployed staging and production surfaces are probed on a schedule and after every production deploy, and the
burn-in contract that governs the production post-deploy smoke. Pairs with the [MCP operator runbook](./mcp-operator.md)
(kill switches, `wrangler tail`) and the [web-audit operations runbook](./web-audit-operations.md) (environments table,
rescore operations).

## The gates

| Gate                   | Where                             | Trigger                       | Blocking?                         |
| ---------------------- | --------------------------------- | ----------------------------- | --------------------------------- |
| `sweep-staging` leg    | `.github/workflows/mcp-sweep.yml` | daily 13:37 UTC + dispatch    | yes (gates nothing downstream)    |
| `sweep-production` leg | `.github/workflows/mcp-sweep.yml` | daily 13:37 UTC + dispatch    | yes (gates nothing downstream)    |
| `production-smoke` job | `.github/workflows/deploy.yml`    | after every production deploy | no (`continue-on-error`, burn-in) |

Each sweep leg runs the core MCP checks (`scripts/release/mcp-smoke.sh --core-only`) plus one homepage HTML probe
(explicit `Accept: text/html`, HTTP 200, `hero__title` marker in a captured body). The staging leg first preflights the
CF Access service token so credential rot is diagnosed as credentials, not as a broken surface. The production smoke
adds `scripts/smoke-api-score.sh https://anc.dev` (registry fast-path) after a propagation-settle retry loop.

The sweep legs carry no `continue-on-error`: they gate nothing downstream, so a red leg simply shows red in the Actions
tab and emails the run owner. The production smoke is the one governed soft-fail, and the contract below is what makes
that legitimate.

## Burn-in contract for `production-smoke`

### Flip criterion

The smoke becomes blocking after **5 consecutive green runs** of the `production-smoke` job.

- Real runs count: production deploys from a `main` push, and full runs seeded via `gh workflow run deploy.yml -f
  environment=production`.
- Skipped runs (any deploy run where the production job did not run) and cancelled runs count for nothing: they prove
  nothing about the gate.
- The flip is a one-line deletion: remove `continue-on-error: true` from the `production-smoke` job in
  `.github/workflows/deploy.yml`. Before flipping, re-check every trigger path that runs the job (push to `main`,
  `workflow_dispatch` with `environment=production`), because the deletion changes semantics for all of them.

### Red-run policy

A red smoke resets the consecutive-green count to zero. The repo operator triages it before any further release
activity:

- A red smoke blocks the release process regardless of the run conclusion: do not cut or refresh a `release/*` branch
  from a commit whose deploy run shows a red `production-smoke` job.
- Fix forward on `dev` and ship through the normal release flow, which redeploys production and re-runs the smoke. Never
  blind re-run the job hoping for green without a diagnosis; the one sanctioned re-run is the mid-deploy case below.

### Canned diagnoses

Start from these signatures before treating a red run as a broken deploy:

- **HTTP 503 on the MCP checks**: the `MCP_ENABLED` kill switch is engaged. See the
  [MCP operator runbook](./mcp-operator.md) for the switch and its re-enable path.
- **CF Access redirect (302 to `*.cloudflareaccess.com`) or early 401/403 on the staging leg**: stale or unadmitted
  service token. The `sweep-staging` credential preflight fails with this diagnosis before the MCP checks run; rotate or
  re-admit the `ANC_STAGING_ACCESS_*` repo secrets (source: the 1Password item for the staging service token), then
  re-run.
- **`sweep-staging` red immediately after a push to `dev`**: likely a mid-deploy flip; the leg probed the staging Worker
  while `deploy.yml` was replacing it. Re-run the sweep once; escalate only if it stays red.
- Anything else: the smoke scripts print per-check failures and their response-capture directory; read the job log
  before touching infrastructure.

### Job-level verification

`continue-on-error: true` keeps the run conclusion green, so the run list, the checks rollup, and `gh run watch
--exit-status` all say nothing about the smoke. Check the job itself:

```bash
gh run view <run-id> --json jobs --jq '.jobs[] | {name, conclusion}'
```

and assert the `smoke production surface` job's conclusion is `success`. A smoke that burns red for weeks unnoticed also
silently stalls the flip criterion.

### Terminal step (deferred)

The contract ends with the flip-to-blocking edit: delete `continue-on-error: true` from the `production-smoke` job once
the flip criterion is met. That edit is deliberately deferred work, not part of landing the gate.

## Scheduling reality

Scheduled workflows fire only from the default branch's copy of the workflow file. `mcp-sweep.yml` and the
`production-smoke` job are inert on `dev`: they run for the first time after the next release ships them to `main`. The
burn-in clock starts at that first `main`-resident run, not at the `dev` merge. To seed green runs after the release
lands, dispatch the sweep manually (`gh workflow run mcp-sweep.yml`) and, for the smoke, dispatch a production deploy.

The workflow-shape contracts above (two independent sweep legs, `dev` checkout on the staging leg, no soft-fail in the
sweep, the smoke's `needs`/concurrency/`continue-on-error` triple) are enforced by `tests/workflow-gates.test.ts`.
