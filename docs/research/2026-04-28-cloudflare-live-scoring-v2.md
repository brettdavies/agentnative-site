---
date: 2026-04-28
topic: cloudflare-stack-current-state
upstream: docs/brainstorms/live-scoring-spike.md (2026-04-17)
purpose: Verify CF Workers + Sandbox SDK + Containers + DO + R2 docs as of 2026-04-28 for live-scoring v2 plan
---

# Cloudflare Stack Research — Live Scoring v2

Research synthesized from Cloudflare developer docs MCP (current production docs). All URLs absolute. Items flagged
**CHANGED** differ from the 2026-04-17 brainstorm.

## TL;DR — what shifted since 2026-04-17

1. **Containers + Sandboxes are GA as of 2026-04-13** — no longer beta. Brainstorm's "Containers / Sandbox beta enabled"
   prerequisite is stale.
2. **Sandbox SDK and `@cloudflare/containers` package versions moved**. Outbound traffic dynamic handlers require
   `@cloudflare/sandbox@0.8.9+` or `@cloudflare/containers@0.3.0+`. Brainstorm pins `0.7.0`.
3. **TLS interception now default** for outbound Workers (per-instance ephemeral CA). Brainstorm doesn't address this.
4. **Container concurrent limits jumped 15x on 2026-02-25** — 6 TiB memory / 1,500 vCPU / 30 TB disk per account.
5. **Higher-tier instance types added 2025-10-01** — `standard-3` and `standard-4` exist now.
6. **Outbound Workers (2026-03-26)** lets containers call Worker functions and bindings (KV, R2) over HTTP — new
   capability the brainstorm doesn't use.
7. **Docker Hub support shipped 2026-03-24** — `image: "docker.io/<ns>/<repo>:<tag>"` works directly in wrangler config.
8. **Pricing model verified unchanged from brainstorm** — brainstorm's numbers are correct; CPU has been active-usage
   since 2025-11-21.

---

## 1. Sandbox SDK — current state

- **Package**: `@cloudflare/sandbox` on npm. Brainstorm's `0.7.0` is stale. Outbound traffic features used in the spike
  require `0.8.9+`. The most recent referenced image tag in CF docs is `docker.io/cloudflare/sandbox:0.7.18` (Mar 2026
  changelog), and a `0.7.4-musl` exists for Alpine/dind use cases. **Action: pin a current 0.8.x release** and match the
  Docker tag exactly (the SDK warns on mismatch).
- **Available on Workers Paid plan** only (no free tier).
- **Public API surface confirmed**: `getSandbox(env.Sandbox, id)`, `sandbox.exec(cmd)`, `sandbox.execStream(cmd)`,
  `sandbox.startProcess(cmd)`, `sandbox.mkdir`, `sandbox.writeFile`, `sandbox.readFile`, `sandbox.watch`,
  `sandbox.createCodeContext({language})`, `sandbox.runCode(...)`. Brainstorm's API expectations all check out.
- **Architecture**: three layers — Worker → Sandbox Durable Object (SQLite-backed, extends `DurableObject`) → isolated
  Ubuntu container. The DO routes RPC to the container over HTTP.
- **Sessions**: each `getSandbox(...)` call returns a stub keyed by ID; sessions provide state isolation within a single
  sandbox.

Sources:

- <https://developers.cloudflare.com/sandbox/>
- <https://developers.cloudflare.com/sandbox/concepts/architecture/>
- <https://developers.cloudflare.com/sandbox/guides/execute-commands/>
- <https://developers.cloudflare.com/sandbox/configuration/sandbox-options/>

## 2. Wrangler `containers` binding — verified syntax (2026-04)

JSONC (canonical Sandbox shape from current docs):

```jsonc
{
  "containers": [{
    "class_name": "Sandbox",
    "image": "./Dockerfile",          // or "docker.io/<ns>/<repo>:<tag>"
    "instance_type": "standard-1",    // lite | basic | standard-1..4 | custom object
    "max_instances": 10
  }],
  "durable_objects": {
    "bindings": [{ "class_name": "Sandbox", "name": "Sandbox" }]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Sandbox"] }]
}
```

- **`class_name`** must match the exported DO class.
- **`migrations` MUST use `new_sqlite_classes`**, not legacy `new_classes` — this is hard-required for container DOs.
- **`max_instances`** = max **concurrently running** instances. Stopped/sleeping instances don't count toward the cap.
- **`instance_type` options + provisioned resources** (these are billed-as-provisioned for memory + disk):

| type                            | vCPU | memory  | disk  |
| ------------------------------- | ---- | ------- | ----- |
| `lite` (alias `dev`)            | 1/16 | 256 MiB | 2 GB  |
| `basic`                         | 1/4  | 1 GiB   | 4 GB  |
| `standard-1` (alias `standard`) | 1/2  | 4 GiB   | 8 GB  |
| `standard-2`                    | 1    | 6 GiB   | 12 GB |
| `standard-3`                    | 2    | 8 GiB   | 16 GB |
| `standard-4`                    | 4    | 12 GiB  | 20 GB |

- **Custom instance type** (now available to all accounts as of 2026-01-05): `"instance_type": { "vcpu": 2,
  "memory_mib": 6144, "disk_mb": 12000 }`. Constraints: 1-4 vCPU, ≤12 GiB memory, ≤20 GB disk, ≥3 GiB memory per vCPU,
  ≤2 GB disk per 1 GiB memory.

**CHANGED vs brainstorm**: brainstorm only mentioned 5 instance types and an Enterprise-gated custom shape. The
brainstorm's table is correct for what it lists, but missing `standard-3`, `standard-4`, and the now-public custom
shape. For our pre-baked image (~3.5-4.5 GB), `standard-1` still fits and is the right default.

Sources:

- <https://developers.cloudflare.com/containers/get-started/>
- <https://developers.cloudflare.com/sandbox/get-started/>
- <https://developers.cloudflare.com/sandbox/configuration/wrangler/>
- <https://developers.cloudflare.com/workers/wrangler/configuration/#containers>
- <https://developers.cloudflare.com/changelog/post/2025-10-01-new-container-instance-types/>
- <https://developers.cloudflare.com/changelog/post/2026-01-05-custom-instance-types/>

## 3. Durable Objects + Containers pairing

- **One container per DO instance.** A given DO instance controls exactly one container. To run multiple containers
  concurrently, instantiate multiple DO IDs (e.g., `env.Sandbox.idFromName("user-123")` vs `"user-456"`).
- **DO must use SQLite backend** (`new_sqlite_classes`) — the key-value backend is not supported for container DOs.
- **`script_name` / cross-script bindings**: not required for the standard same-Worker pattern. Brainstorm's mention of
  `script_name` is for cross-Worker DO bindings; not needed for live-scoring.
- **Lifecycle hooks** on the `Container` class: `onStart()`, `onStop(exitCode, reason)`, `onActivityExpired()` (fires
  when `sleepAfter` elapses, default action is `stop()`), `onError()`. Use `schedule()` not raw `alarm()` — `Container`
  reserves the alarm handler for lifecycle.
- **Cold start**: 1-3 seconds typical for an already-deployed image, dominated by entrypoint startup. Keep entrypoints
  minimal.
- **Sleep behavior**: container goes to sleep after `sleepAfter` (default 10 minutes idle). On wake, **disk is reset to
  image baseline** — all runtime state (cloned repos, /tmp) is gone. This is by design; brainstorm's "pre-baked tools
  survive sleep" is correct because they're in the image, but cloned repos do NOT survive.
- **Keep-alive**: `keepAlive: true` sends 30-second heartbeats and prevents auto-sleep. Use only for long sessions —
  costs accrue continuously.

Sources:

- <https://developers.cloudflare.com/containers/container-class/>
- <https://developers.cloudflare.com/containers/platform-details/architecture/>
- <https://developers.cloudflare.com/containers/faq/>
- <https://developers.cloudflare.com/sandbox/configuration/sandbox-options/>

## 4. CF base image — what's actually bundled

- **Image registry**: `docker.io/cloudflare/sandbox:<version>`. Variants:
- `:0.7.0` (default) — Ubuntu 22.04 LTS, Node.js 20 LTS + npm, Bun 1.x, plus curl wget git jq zip unzip file procps
    ca-certificates.
- `:0.7.0-python` — adds Python 3.11 + pip + venv + matplotlib/numpy/pandas/ipython.
- `:0.7.0-opencode` — adds the OpenCode CLI.
- `:0.7.4-musl` — Alpine-compatible build (musl libc) for Docker-in-Docker scenarios.
- **Architecture**: `linux/amd64` only.
- **Bridge image** (the canonical sandbox-bridge Worker example) ships Python 3.13 + Node + Bun + git + ripgrep + curl
- wget + jq + tar + sed + gawk + procps. Useful reference for what "agent tooling" looks like in CF's own examples.

- **CHANGED vs brainstorm**: brainstorm assumes "Python 3.13" in the default base. Default base is **Python-less**; the
  `-python` variant ships **Python 3.11**, not 3.13. The 3.13 figure comes from the Bridge image, which is a separate
  higher-level Dockerfile. **Decision point for plan**: pick `:0.7.x-python` if Python tools are pre-baked, or extend
  default and apt-install python3 yourself.
- **Custom Debian/Ubuntu base**: supported. Use a multi-stage Dockerfile copying the sandbox binary in:

  ```dockerfile
  FROM debian:trixie-slim  # or any base
  COPY --from=docker.io/cloudflare/sandbox:0.7.x /container-server/sandbox /sandbox
  ENTRYPOINT ["/sandbox"]
  CMD ["your-command"]
  ```

  This satisfies the brainstorm's openness about Debian-trixie. The `-musl` variant is required for Alpine.

Sources:

- <https://developers.cloudflare.com/sandbox/configuration/dockerfile/>
- <https://developers.cloudflare.com/sandbox/concepts/sandboxes/>
- <https://developers.cloudflare.com/sandbox/bridge/>
- <https://developers.cloudflare.com/sandbox/guides/docker-in-docker/>

## 5. Network policy — `setOutboundHandler` and friends

The 2026-04-13 changelog post is the authoritative current shape. Three layers:

**Static allow/deny** on the class:

```ts
export class MySandbox extends Sandbox {
  allowedHosts = ["github.com", "npmjs.org"];   // deny-by-default allowlist when set
  // deniedHosts = ["..."];                      // glob patterns supported
}
```

**Named handlers** (define once, swap at runtime):

```ts
MySandbox.outboundHandlers = {
  allowHosts: async (req, env, ctx) => { /* ... */ },
  noHttp:     async () => new Response(null, { status: 403 }),
  authenticatedGithub: async (req, env, ctx) => { /* inject github token */ },
};
```

**Runtime API** (mid-session policy changes, exactly the github-clone-then-lockdown pattern in the brainstorm):

- `sandbox.setOutboundHandler(name, params?)` — apply globally
- `sandbox.setOutboundByHost(host, name, params?)` — apply per-host
- `sandbox.setOutboundByHosts(...)`, `sandbox.setAllowedHosts(...)`, `sandbox.setDeniedHosts(...)`,
  `sandbox.allowHost(...)`, `sandbox.denyHost(...)`, `sandbox.removeAllowedHost(...)`, `sandbox.removeDeniedHost(...)`,
  `sandbox.removeOutboundByHost(...)`.

Per-call vs sandbox-wide: handlers are **per-sandbox-instance**, applied/removed at runtime. There is no per-`exec()`
call scope — you set policy, run the command, change policy, run the next command.

**TLS interception is now default** for outbound Workers: each sandbox gets its own ephemeral CA + private key, trusted
in the container, never shared cross-instance, never leaves the runtime sidecar. This means HTTPS traffic is
transparently inspectable by your outbound Worker — important because the brainstorm's "lock down during scoring"
strategy now works for HTTPS, not just HTTP.

**New 2026-03-26**: `outbound` and `outboundByHost` static handlers can route container traffic into Worker functions
with full access to bindings (KV, R2, etc.). Useful for: containerized git clones routed through a Worker that injects a
GitHub App token from a binding without exposing it to the sandbox.

Sources:

- <https://developers.cloudflare.com/sandbox/guides/outbound-traffic/>
- <https://developers.cloudflare.com/changelog/post/2026-04-13-sandbox-outbound-workers-tls-auth/>
- <https://developers.cloudflare.com/changelog/post/2026-03-26-outbound-workers/>

## 6. Pricing — Workers Paid (2026, current)

**Verified unchanged from brainstorm.** Container compute, billed per 10 ms of active runtime, on Workers Paid ($5/mo
base):

| Resource | Included            | Overage                              |
| -------- | ------------------- | ------------------------------------ |
| Memory   | 25 GiB-hours/mo     | $0.0000025 / GiB-second              |
| CPU      | 375 vCPU-minutes/mo | $0.000020 / vCPU-second (active CPU) |
| Disk     | 200 GB-hours/mo     | $0.00000007 / GB-second              |

**Active CPU (since 2025-11-21)**: CPU billed on actual usage, not provisioned. Memory + disk still billed on
provisioned. CF's worked example: `standard-2` (1 vCPU) for 1 hour at 20% utilization = $0.0144 CPU (was $0.072 under
old pricing). Brainstorm's 50%-utilization invocation cost ($0.0005) is in the right ballpark.

**Free tier for Containers**: none. Workers Paid is required to use Containers or Sandbox SDK.

**Network egress** (per GB, separate from Workers request egress):

| Region                 | Price/GB | Included/mo |
| ---------------------- | -------- | ----------- |
| North America & Europe | $0.025   | 1 TB        |
| Oceania, Korea, Taiwan | $0.05    | 500 GB      |
| Everywhere Else        | $0.04    | 500 GB      |

Brainstorm only listed NA/EU. APAC ($0.05) and rest-of-world ($0.04) are separate tiers — relevant if scoring users
cluster outside NA/EU.

**Workers + DO billing layered on top**: each container instance has its own Durable Object; you pay for Workers
requests + DO compute + DO storage on top of container compute. DO compute is small (the SQLite-backed DO bills
similarly to Workers — see DO pricing for exact rates).

**Concurrent limits** (raised 2026-02-25) — well beyond what live-scoring needs:

- 6 TiB memory, 1,500 vCPU, 30 TB disk concurrent per account
- 15,000 `lite`, 6,000 `basic`, 1,500 `standard-1`, 1,000 `standard-2` instances concurrent

Sources:

- <https://developers.cloudflare.com/containers/pricing/>
- <https://developers.cloudflare.com/workers/platform/pricing/>
- <https://developers.cloudflare.com/changelog/post/2025-11-21-new-cpu-pricing/>
- <https://developers.cloudflare.com/changelog/post/2026-02-25-higher-container-resource-limits/>
- <https://developers.cloudflare.com/durable-objects/platform/pricing/>

## 7. R2 — pricing, latency, caching

**Pricing** (Standard storage, what we'd use for memoization):

| Item                               | Rate              | Free tier      |
| ---------------------------------- | ----------------- | -------------- |
| Storage                            | $0.015 / GB-month | 10 GB-month/mo |
| Class A ops (writes, lists)        | $4.50 / M req     | 1M req/mo      |
| Class B ops (reads)                | $0.36 / M req     | 10M req/mo     |
| Egress (data transfer to Internet) | **free**          | unlimited      |

Billing rounds **up** to next unit (1.1 GB-month → 2 GB-month).

**Latency from a Worker**: same-region reads sub-100 ms; cold tier reads from a different region 100-300 ms. For our use
(memoize scorecards keyed by `repo@sha`), cold reads dominate first-time, hot reads via Cache API are ms.

**Caching strategy** (what the plan should use):

- Custom domain on the bucket → Cloudflare CDN serves cached objects at edge.
- **Smart Tiered Cache** (auto-enabled for R2 origins as of 2024-11-20): CF picks an Upper Tier near your bucket, routes
  edge cache misses through it. Reduces R2 egress (already free) and improves hit ratio.
- For Worker-side caching, use `caches.default.match()` / `.put()` on a constructed Request. Set `Cache-Control:
  s-maxage=N` for TTL.
- Key shape for memoization: `{repo-owner}/{repo-name}/{commit-sha}.json` — content-addressed by commit SHA, never
  invalidated.

**Workers binding**: `env.MY_BUCKET.get(key)`, `.put(key, body)`, `.delete(key)`, `.list({ prefix })`. Strong
consistency per object.

Sources:

- <https://developers.cloudflare.com/r2/pricing/>
- <https://developers.cloudflare.com/r2/how-r2-works/>
- <https://developers.cloudflare.com/r2/examples/cache-api/>
- <https://developers.cloudflare.com/changelog/post/2024-11-20-smart-tiered-cache-for-r2/>

## 8. Rate limiting

Two viable options:

**Option A — Workers Rate Limiting binding** (recommended for MVP):

- Built-in binding, no DO scaffold required.
- Wrangler config:

  ```jsonc
  "ratelimits": [{
    "name": "SCORE_LIMITER",
    "namespace_id": "1001",
    "simple": { "limit": 10, "period": 60 }   // period MUST be 10 or 60
  }]
  ```

- Usage: `const { success } = await env.SCORE_LIMITER.limit({ key: ipAddress })`. Returns immediately (no network
  round-trip — counters are isolate-local, async-replicated within a CF location).
- **Locality caveat**: counters are **per-Cloudflare-location**, not global. A user hitting 10 different POPs gets 10x
  the limit. For abuse protection that's fine; for strict global limits, use option B.
- Requires Wrangler **4.36.0+**.

**Option B — Durable Object–based custom counter** (when global accuracy matters):

- Spin up a `RateLimiter` DO keyed by IP / user-id. Use SQLite-backed DO storage to track windowed counts.
- Globally consistent (DOs are single-instance). Costs more (DO compute + storage per request).
- Brainstorm doesn't specify which; recommend Option A for v2 launch, upgrade to B only if abuse seen.

**Free vs Paid**: rate limiting binding works on Workers Paid (which we already require for Containers). No separate
SKU.

Sources:

- <https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/>

## 9. Recent changes (last 6 months) affecting the design

Most-impactful first:

| Date       | Change                                                               | Impact                                                                                                       |
| ---------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 2026-04-13 | Containers + Sandboxes **GA**                                        | No more beta-account gating; the brainstorm's prerequisite about "beta enabled" is obsolete                  |
| 2026-04-13 | Outbound Workers + dynamic handlers + TLS interception               | Plan should use named handlers + per-host policy as the brainstorm's design intends; HTTPS now interceptable |
| 2026-03-26 | Outbound traffic to Workers + bindings                               | New: container HTTP → Worker → KV/R2/secrets. Useful for token-injection without exposing secrets to sandbox |
| 2026-03-24 | Docker Hub images directly                                           | Can use `docker.io/<ns>/<repo>:<tag>` in `image:` without push-to-CF-registry round-trip                     |
| 2026-03-12 | SSH support into live containers                                     | Debugging-only, not production path                                                                          |
| 2026-02-25 | 15x concurrent limit raise                                           | 1,000+ `standard-2` instances/account; not a constraint for our scale                                        |
| 2026-01-05 | Custom instance types public                                         | Right-sizing now possible without Enterprise contract                                                        |
| 2025-11-21 | Active-CPU pricing                                                   | Already reflected in brainstorm's cost model                                                                 |
| 2025-10-01 | `standard-3` / `standard-4` added; `standard-1` disk doubled to 8 GB | Brainstorm's "standard-1 = 8 GB" is correct (was 4 GB before this change)                                    |

**No `runtime: nvidia` legacy syntax** appears in current docs. The modern `deploy.resources.reservations.devices` form
referenced in the brainstorm doesn't surface either — neither shape is current Wrangler config for Containers.
GPU-on-Containers may be roadmap, but not in shipping docs as of 2026-04-28. **Action**: drop GPU references from the
plan unless a separate Workers AI binding handles the ML side.

Sources: all changelogs above, plus

- <https://developers.cloudflare.com/changelog/post/2026-04-13-containers-sandbox-ga/>
- <https://developers.cloudflare.com/changelog/post/2026-03-12-ssh-support/>
- <https://developers.cloudflare.com/changelog/post/2026-03-24-docker-hub-images/>

## 10. The `cf` beta CLI — flag

The Cloudflare developer docs return **no results** for a `cf` CLI in 2026 that interacts with the Sandbox SDK or
Workers for Containers. Cloudflare's official tooling remains:

- **`wrangler`** — primary CLI for Workers, Containers, Sandbox, R2, KV, DO, Queues, Workflows, etc.
- **`cloudflared`** — Cloudflare Tunnel / Access CLI (separate concern).
- **`create-cloudflare` / `npm create cloudflare`** — project scaffolder (also called `c3`).
- **Cloudflare One Client** (`warp-cli` on Linux) — Zero Trust client (separate concern).

The user's note "we just added it to our registry today" plus the `agentnative` context strongly suggests **`cf` is a
third-party agent-native CLI** (likely `brettdavies/cf` or community-published) added to the ANC scoring registry — not
a Cloudflare-published CLI. **Action for planner**: confirm the source. If it's a third-party CLI, no special plan
integration needed; it gets scored like any other registry tool. If the user actually means a CF-published beta tool,
they need to point at a specific URL/repo because docs MCP doesn't know about it.

## Plan synthesis — what to copy into the v2 plan

**External References section** (paste-ready):

- Sandbox SDK overview: <https://developers.cloudflare.com/sandbox/>
- Sandbox configuration (Wrangler): <https://developers.cloudflare.com/sandbox/configuration/wrangler/>
- Sandbox Dockerfile reference: <https://developers.cloudflare.com/sandbox/configuration/dockerfile/>
- Outbound traffic guide: <https://developers.cloudflare.com/sandbox/guides/outbound-traffic/>
- Containers pricing: <https://developers.cloudflare.com/containers/pricing/>
- Containers limits + instance types: <https://developers.cloudflare.com/containers/platform-details/limits/>
- Container class lifecycle: <https://developers.cloudflare.com/containers/container-class/>
- R2 pricing: <https://developers.cloudflare.com/r2/pricing/>
- Workers Rate Limiting binding: <https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/>
- 2026-04-13 GA + outbound handlers:
  <https://developers.cloudflare.com/changelog/post/2026-04-13-sandbox-outbound-workers-tls-auth/>

**Key Technical Decisions** (paste-ready bullets):

- Pin `@cloudflare/sandbox@0.8.x` (≥0.8.9 for runtime outbound handlers); **mirror tag exactly** in Dockerfile `FROM
  docker.io/cloudflare/sandbox:<same-version>` — the SDK warns on mismatch.
- Default to `standard-1` instance (1/2 vCPU, 4 GiB memory, 8 GB disk) for the pre-baked scoring image; consider custom
  instance type (`{ vcpu: 1, memory_mib: 4096, disk_mb: 6000 }`) if image stays under ~4 GB and we want lower memory
  bill.
- Use SQLite-backed DO (`new_sqlite_classes`); each scoring session = one `getSandbox(env.Sandbox, sessionId)` → one DO
  → one container.
- Outbound network policy: `setOutboundByHost("github.com", "authenticatedGithub")` during clone, then
  `setOutboundHandler("noHttp")` for scoring. Use a Worker `outboundByHost` handler to inject GitHub App token from a
  binding — token never enters the sandbox.
- Memoize scorecards in R2 keyed by `{owner}/{repo}/{commit-sha}.json`; serve via custom domain with Cache API
- Smart Tiered Cache for sub-50ms cache hits. Cost: effectively zero within free tier.

- Rate limit at the Worker: `SCORE_LIMITER` binding, 10 req/60s/IP for unauthenticated, separate higher limit for
  authenticated. Upgrade to DO-based limiter only if location-local counters prove insufficient.
- **Drop GPU/`runtime: nvidia` references** from the plan — not in current Containers config schema.
- **Drop "beta-account enabled" prerequisite** — Containers + Sandboxes are GA as of 2026-04-13.
- Confirm whether the registry's `cf` CLI is a Cloudflare-published tool or a third-party `brettdavies/cf` — research
  found no CF-published CLI by that name.
