---
date: 2026-04-17
topic: live-scoring-spike
---

# Live Scoring Spike: "Paste a Repo URL, Get a Score"

## Context

SSL Labs / Lighthouse pattern for ANC — users paste a GitHub repo URL and get an agent-native CLI scorecard on the spot.
The site already runs on Cloudflare Workers.

## Key Insight: Behavioral Checks Don't Require Compiling From Source

The original framing assumed behavioral checks require compiling the target project from source — making live scoring
expensive (install toolchains, compile, then test). This is wrong.

**Behavioral checks need an installed binary, not a compiled-from-source binary.** For any tool available via a standard
package manager, the binary is already packaged:

```bash
brew install ripgrep       → rg binary ready in ~5s
cargo binstall bird        → bird binary ready in ~3s (prebuilt)
cargo install agentnative  → anc binary ready in ~30-60s (compile)
pip install datasette      → datasette binary ready in ~5s
go install gh@latest       → gh binary ready in ~10s
npm install -g wrangler    → wrangler binary ready in ~5s
```

This means full behavioral + source + project scoring is viable for live scoring at reasonable latency (15-60 seconds)
for any tool with a standard install path.

## Revised Architecture

### The Install Registry

A lookup table mapping tools to their install method:

```yaml
ripgrep:
  install: brew install ripgrep
  binary: rg
  language: rust
  repo: BurntSushi/ripgrep

bird:
  install: cargo install bird
  binary: bird
  language: rust
  repo: brettdavies/bird

datasette:
  install: pip install datasette
  binary: datasette
  language: python
  repo: simonw/datasette
```

For **known tools** (in the registry): install method is predetermined. For **unknown tools** (user submits a new repo):
detect from `Cargo.toml` / `pyproject.toml` / `go.mod` / `package.json` and attempt install. Fall back to source-only if
install fails.

### Supported Install Paths

| Method | Speed | Coverage | Notes |
|--------|-------|----------|-------|
| `brew install` | 3-10s | Broadest — most popular CLIs | Requires Homebrew in container |
| `cargo binstall` | 2-5s | Rust tools with prebuilt binaries | Falls back to `cargo install` |
| `cargo install` | 30-120s | All Rust tools on crates.io | Compile from source, slowest |
| `pip install` / `pipx install` | 3-10s | Python CLI tools on PyPI | Usually pre-built wheels |
| `go install` | 5-15s | Go tools | Compiles from source but fast |
| `npm install -g` | 3-10s | Node CLI tools on npm | Script-based, no compile |

### Container Image Strategy

**Pre-bake the top 100 tools** into the Docker/Sandbox image. These are already installed — scoring them is instant
(just run `anc check <binary>`). The pre-computed leaderboard is just a scheduled run of `anc check` against every
pre-installed binary.

**For new tools**: the container has all package managers installed (brew, cargo, pip, go, npm). When a user submits a
repo URL not in the pre-baked set, the container installs it on the fly. If install fails, fall back to source-only
scoring.

## Cloudflare Platform Architecture (from CF docs research)

### Why Sandbox SDK, not raw Containers

CF offers two abstractions: **Containers** (low-level Docker + Durable Objects) and **Sandbox SDK** (higher-level API on
top of Containers with `exec()`, file ops, sessions). Both use the same underlying infrastructure and pricing.

Sandbox SDK is the right pick because:

- `sandbox.exec('anc check /usr/bin/rg --output json')` is a single API call
- Built-in session management, file I/O, streaming output
- Dynamic outbound handlers for network security (allow github.com during clone, lock down during scoring)
- Base images extend Ubuntu with common tools already installed (`docker.io/cloudflare/sandbox:0.7.0`)

### Building the Image: Pre-Bake Everything

The Dockerfile extends the official Sandbox base image. The base already includes Python 3.13, Node.js, Bun, git,
ripgrep, curl, wget, jq.

```dockerfile
FROM docker.io/cloudflare/sandbox:0.7.0

# Package managers
RUN apt-get update && apt-get install -y \
    build-essential pkg-config libssl-dev \
    && rm -rf /var/lib/apt/lists/*

# Rust toolchain + cargo-binstall (for fast binary installs)
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y \
    && . $HOME/.cargo/env \
    && cargo install cargo-binstall

# Go toolchain
RUN curl -fsSL https://go.dev/dl/go1.24.2.linux-amd64.tar.gz | tar -C /usr/local -xzf -
ENV PATH="/usr/local/go/bin:$HOME/go/bin:${PATH}"

# Pre-install anc (the scorer itself)
RUN . $HOME/.cargo/env && cargo install agentnative

# Pre-install all 100 registry tools (apt-based)
RUN apt-get update && apt-get install -y \
    fd-find bat tmux fzf gh docker.io \
    && rm -rf /var/lib/apt/lists/*

# Pre-install Rust tools via cargo-binstall (prebuilt binaries, fast)
RUN . $HOME/.cargo/env && cargo binstall -y \
    bird xurl-rs bat fd-find ripgrep hyperfine sd tokei

# Pre-install Go tools
RUN go install github.com/mikefarah/yq/v4@latest \
    && go install github.com/boyter/scc/v3@latest

# Pre-install Python tools
RUN pip install --no-cache-dir datasette sqlite-utils llm httpie

# Pre-install Node tools
RUN npm install -g wrangler
```

### Image Size Budget

Image size is capped by instance disk space. Pre-baked tools survive container sleep because they're part of the image —
only runtime state (cloned repos, temp files) resets.

| Instance Type | vCPU | Memory | Disk (= max image) | Fits our image? |
|---------------|------|--------|---------------------|-----------------|
| `lite` | 1/16 | 256 MiB | 2 GB | No — too small |
| `basic` | 1/4 | 1 GiB | 4 GB | Tight — binaries only, no toolchains |
| `standard-1` | 1/2 | 4 GiB | 8 GB | Yes — base + tools + 1-2 toolchains |
| `standard-2` | 1 | 6 GiB | 12 GB | Comfortable — all toolchains + 100 tools |
| Custom | tunable | tunable | tunable | Match to actual image size |

**Estimated image size breakdown:**

- Sandbox base image: ~800MB
- Rust toolchain (rustup + cargo): ~1.5GB
- Go toolchain: ~500MB
- Pre-installed binaries (100 tools): ~500MB–1GB
- Python packages (datasette, llm, httpie, etc.): ~300MB
- Node packages (wrangler, etc.): ~200MB
- **Total: ~3.5–4.5GB → fits `standard-1` (8 GB) comfortably**

Custom instance types are available: `instance_type = { vcpu = 1, memory_mib = 4096, disk_mb = 6000 }` to right-size
exactly. Total image storage per account: 50 GB limit (plenty for one image).

### Pricing (Verified from CF Docs)

Workers Paid plan ($5/mo base) includes generous free tiers:

| Resource | Free included | Overage rate |
|----------|---------------|-------------|
| Memory | 25 GiB-hours/mo | $0.0000025/GiB-sec |
| CPU | 375 vCPU-min/mo | $0.000020/vCPU-sec (active usage only) |
| Disk | 200 GB-hours/mo | $0.00000007/GB-sec |
| Egress (NA/EU) | 1 TB/mo | $0.025/GB |

**CPU is billed on active usage only** — not provisioned. If a `standard-1` (0.5 vCPU) runs for 30 seconds but only uses
50% CPU, you pay for 15 vCPU-seconds, not 30.

**Cost per scoring invocation** (standard-1, 30-second run, 50% CPU utilization):

- Memory: 4 GiB × 30s × $0.0000025 = $0.0003
- CPU: 0.5 vCPU × 30s × 50% × $0.000020 = $0.00015
- Disk: 8 GB × 30s × $0.00000007 = $0.0000168
- **Total: ~$0.0005/invocation**

**Monthly cost estimates (after free tier):**

| Daily requests | Invocations/mo | Raw cost | With free tier |
|---------------|----------------|----------|----------------|
| 50 | 1,500 | $0.75 | **Free** (within included allotments) |
| 100 | 3,000 | $1.50 | **~$0** (mostly free tier) |
| 500 | 15,000 | $7.50 | **~$3–5** |
| 1,000 | 30,000 | $15 | **~$10** |
| 5,000 | 150,000 | $75 | **~$65** |

The free tier covers light usage entirely. At Show HN launch traffic levels (~500-1000/day), this costs $5-10/mo.

### Container Lifecycle: Sleep + Wake = Perfect Fit

Sandbox containers sleep after configurable inactivity (default 10 minutes). On wake:

- **Image state is preserved** — all pre-installed tools are still there (they're in the Docker image)
- **Runtime state is lost** — cloned repos, temp files, running processes are gone
- **Cold start: 1-3 seconds** depending on image size

This is exactly what we want. The container wakes, `anc check /usr/bin/rg --output json` runs against a pre-installed
binary, returns in 2-5 seconds, then the container sleeps again. No wasted idle cost.

For sustained traffic (Show HN spike), the container stays warm and scoring is instant — no cold start.

### Security: Dynamic Outbound Handlers

CF Sandbox supports runtime-configurable network policy — perfect for our use case:

```typescript
// During repo clone: allow github.com only
await sandbox.setOutboundHandler("allowHosts", {
  allowedHostnames: ["github.com", "crates.io", "pypi.org", "npmjs.org"],
});
await sandbox.exec("git clone https://github.com/user/repo /tmp/repo");

// During scoring: lock down network entirely
await sandbox.setOutboundHandler("noHttp");
const result = await sandbox.exec("anc check /tmp/repo --output json");
```

This prevents supply-chain attacks during scoring — cloned code cannot phone home.

### Wrangler Configuration

```jsonc
// wrangler.jsonc
{
  "name": "anc-scorer",
  "main": "src/index.ts",
  "containers": [{
    "class_name": "ScorerSandbox",
    "image": "./Dockerfile",
    "instance_type": "standard-1",
    "max_instances": 5
  }],
  "durable_objects": {
    "bindings": [{
      "class_name": "ScorerSandbox",
      "name": "SCORER"
    }]
  },
  "migrations": [{
    "new_sqlite_classes": ["ScorerSandbox"],
    "tag": "v1"
  }]
}
```

### Worker Code Sketch

```typescript
import { getSandbox } from "@cloudflare/sandbox";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/api/score") return new Response("Not found", { status: 404 });

    const { repo } = await request.json();

    // Single shared sandbox — all tools pre-installed
    const sandbox = getSandbox(env.SCORER, "anc-scorer", {
      sleepAfter: "15m",
    });

    // Clone the repo for source checks
    await sandbox.exec(`git clone --depth 1 https://github.com/${repo} /tmp/repo`);

    // Look up pre-installed binary from registry
    const binary = REGISTRY[repo]?.binary;
    const cmd = binary
      ? `anc check --binary /usr/bin/${binary} --repo /tmp/repo --output json`
      : `anc check /tmp/repo --output json`; // source+project only

    const result = await sandbox.exec(cmd, { timeout: 60_000 });
    return Response.json(JSON.parse(result.stdout));
  },
};
```

## Revised Recommendation

| Component | How | Cost | Latency |
|-----------|-----|------|---------|
| **Pre-computed leaderboard** | GitHub Actions nightly cron. Scores all 100 registry tools. Commits JSON. | Free | Async |
| **Live scoring (known tools)** | CF Sandbox `standard-1`. Binary pre-installed in image. | Free tier for <100/day | 2-5s |
| **Live scoring (new tools)** | Same Sandbox. Clone repo, detect install path, install, score. | ~$5-10/mo at 500/day | 15-120s |
| **Fallback (install fails)** | Same Sandbox. Source+project checks only (no binary). | Same | 5-15s |
| **Cache** | R2. Keyed by (repo, version). 24h TTL. Free egress. | Free tier | Instant |

### Prerequisites

- `anc` needs `--binary <path>` mode for scoring pre-installed binaries (verify this exists).
- `anc` needs `--source-only` fallback for when install fails (verify or add).
- Dockerfile must fit within `standard-1` disk (8 GB). Estimated ~4 GB — comfortable.
- Rate limiting on the live scoring endpoint (prevent abuse).
- R2 bucket for scorecard cache (free tier: 10 GB storage, 10M reads/mo).

### Why This Is Cheaper Than Expected

Three factors compound to make this nearly free at launch scale:

1. **CPU billed on active usage** — a 30s scoring run at 50% utilization pays for 15 vCPU-seconds, not 30
2. **Free tier covers light usage** — 375 vCPU-minutes = ~750 scoring runs/month before any charges
3. **Cache eliminates repeat work** — R2 has free egress, so cached scorecards cost nothing to serve
4. **Pre-baked binaries skip install** — known tools score in 2-5 seconds, not 30-120

## Prior Art: ACFS Manifest as Container Template

Dicklesworthstone's [Agentic Coding Flywheel Setup](https://github.com/Dicklesworthstone/agentic_coding_flywheel_setup)
(ACFS) is a production VPS bootstrap that installs 67 modules into a complete multi-agent dev environment. Its
`acfs.manifest.yaml` is a structured registry of tools with install commands, verification checks, dependencies, and
phase ordering — essentially the same registry pattern we need for the ANC scoring container.

### What ACFS installs (relevant to ANC)

**Standard dev tools (`cli.modern`):** ripgrep, fd, bat, fzf, jq, gh, tmux, lsd/eza, btop, dust, docker, lazygit,
lazydocker, ast-grep, atuin, zoxide, neovim

**Cloud CLIs:** wrangler, supabase, vercel

**AI coding agents:** Claude Code, Codex CLI, Gemini CLI, OpenCode

**Language toolchains:** Rust (nightly + cargo), Go, Node.js (nvm), Bun, Python (uv)

### What to borrow for our container image

The ACFS manifest structure (`id`, `install`, `verify`, `dependencies`, `installed_check`) maps directly to what our
install registry needs. Rather than inventing a new format, we can adapt the ACFS manifest schema:

```yaml
# Our registry borrows ACFS's structure
- id: ripgrep
  install: apt-get install -y ripgrep
  binary: rg
  verify: rg --version
  language: rust
  repo: BurntSushi/ripgrep
  tier: workhorse
```

The key differences from ACFS:

- **We don't need the full VPS setup** — no user management, filesystem layout, shell config, systemd timers, SSH,
  Tailscale, PostgreSQL, or Vault. Just the tool installs.
- **We add ANC-specific fields** — `binary` (the executable name), `tier` (workhorse/agent/notable), `repo` (GitHub URL
  for source checks), `language` (for source check applicability).
- **Our container is ephemeral** — ACFS builds a persistent VPS; our Sandbox container spins up, scores, and dies. No
  state persistence needed.

### Concrete reuse path

1. Extract the `cli.modern`, `tools.*`, `cloud.*`, `agents.*`, and `lang.*` module install commands from
   `acfs.manifest.yaml`.
2. Translate into a Dockerfile that pre-installs all package managers + the top 100 tools.
3. Bake `anc` (pre-compiled for linux-amd64) into the image.
4. The result is a container that can score any pre-installed tool instantly and install new tools on-the-fly via the
   same package managers ACFS uses.

The ACFS manifest also serves as a curated "what tools do agent-heavy developers actually use" signal — it's a
real-world answer to "which tools should be in the ANC 100" from someone running 5-10 agents simultaneously.
