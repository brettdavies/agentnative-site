# Homebrew 6.0 live-scoring spike — artifact index

Measurement artifacts and decision-feeding report for the three-arm wall-clock spike against the full anc100 list under
Homebrew 6.0.

Plan:
[`docs/plans/2026-06-12-001-feat-brew-v6-live-scoring-spike-plan.md`](../../plans/2026-06-12-001-feat-brew-v6-live-scoring-spike-plan.md)

Brainstorm:
[`docs/brainstorms/2026-06-12-brew-v6-live-scoring-spike-requirements.md`](../../brainstorms/2026-06-12-brew-v6-live-scoring-spike-requirements.md)

Harness: [`docker/spike/`](../../../docker/spike/)

## Do not deploy this image to production

The spike image (`anc-sandbox-spike:<git-sha>`) is measurement-only. It carries Linuxbrew + supply-chain env vars
configured for measurement parity (tap-trust enforcement off, no freshness gate, no audit trail), NOT the security
posture production needs. Pushing the spike image into the production registry inverts the decision-making the spike
exists to inform.

Two layers enforce this:

1. The Dockerfile sets `LABEL com.agentnative.image-class=spike`, propagated through `docker tag`.
2. [`.github/workflows/spike-image-firewall.yml`](../../../.github/workflows/spike-image-firewall.yml) validates the
   label on every change to `docker/spike/**` and serves as the gate any image-push workflow must consult.

The third layer is the convention: dispose of the local image after the report writes (`run-spike.sh --dispose`).

## Files in this directory

| File                  | Source                  | Description                                                                                                                                                                              |
| --------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `README.md`           | U7                      | This file.                                                                                                                                                                               |
| `report.md`           | U6 (`report.sh`)        | Spike report consumed by the shape-decision discussion. Per-entry comparison table, summary band, headroom panel, decision-matrix verdict, supply-chain summary, v5-era closure verdict. |
| `probe-result.json`   | U2 (`probe.sh`)         | R6 outcome — does anc audit see a brew-exec'd binary? One of `succeeded`, `succeeded-with-shim`, `failed`. Gates arm 2.                                                                  |
| `arm1-results.json`   | U4 (`run-arm1.sh`)      | Per-entry wall-clocks for arm 1 (registry-pinned install command). JSON array; one row per registry entry.                                                                               |
| `arm2-results.json`   | U4 (`run-arm2.sh`)      | Per-entry wall-clocks for arm 2 (`brew exec --formulae=<pkg> -- <binary>`). Present only when the probe recorded `succeeded` or `succeeded-with-shim`.                                   |
| `arm2-cancelled.json` | U4 (`run-arm2.sh`)      | Present only when arm 2 was cancelled per the R6 / KTD3 strict gate. Records the probe outcome that triggered the cancellation.                                                          |
| `arm3-results.json`   | U4 (`run-arm3.sh`)      | Per-entry wall-clocks for arm 3 (`brew install <pkg>` per registry entry). Implements R15 failure handling for entries with no matching brew formula.                                    |
| `egress-hosts.json`   | U5 (`capture-hosts.sh`) | Deduplicated egress host list per arm, captured via `HOMEBREW_CURL_VERBOSE=1`. Feeds the `INSTALL_HOSTS` allow-list during any shape adoption.                                           |

## Per-entry JSON schema (arm{1,2,3}-results.json)

Each array element matches the schema U3's `measure-entry.sh` emits:

```json
{
  "arm": "arm1" | "arm2" | "arm3",
  "entry": "<registry name>",
  "install_cmd": "<bash command>",
  "audit_cmd": "<bash command>",
  "install_rc": 0,
  "install_elapsed": 5.305,
  "audit_rc": 2,
  "audit_elapsed": 0.777,
  "total_elapsed": 6.082,
  "dnf": false,
  "brew_version": "Homebrew 6.0.1",
  "audit_result": { /* anc audit scorecard */ },
  "env_snapshot": "HOMEBREW_NO_ANALYTICS=1\nHOMEBREW_NO_AUTO_UPDATE=1\n...",
  "trust_state": { "taps": [], "formulae": [], "casks": [], "commands": [] },
  "install_stderr_tail": "",
  "audit_stderr_tail": "",
  "error": null
}
```

`dnf: true` whenever `total_elapsed > 60` (per R2 — long runs complete, but the analysis groups them as "Did Not Finish
under the production budget"). `error` is populated when install fails (`install_rc != 0`) or when anc audit produced no
parseable JSON; an anc-audit exit code of 1 or 2 with valid JSON is NOT an error (the scorecard is valid, the score just
sits below the bar).

Skipped entries (e.g., `nvidia-smi` registered as `included with NVIDIA GPU driver`, or non-brew entries excluded from
arm 2) have a minimal shape:

```json
{
  "arm": "arm1",
  "entry": "nvidia-smi",
  "install_cmd": "<original install field>",
  "skipped": true,
  "skip_reason": "<why this arm skipped the entry>"
}
```

## Re-running the spike

From the repo root:

```sh
bash docker/spike/run-spike.sh                       # full anc100 list
bash docker/spike/run-spike.sh --limit 10            # first 10 registry entries
bash docker/spike/run-spike.sh --only ripgrep,bat,fd # named entries
bash docker/spike/run-spike.sh --dispose             # dispose spike image after report writes
bash docker/spike/run-spike.sh --skip-build          # reuse existing spike image
```

The orchestrator runs the sequence: build → probe → arms 1 + 3 in parallel → arm 2 (sequential after probe) → host
capture → report. CF Sandbox mode (`--cf-sandbox`) is the deferred follow-up sub-plan per KTD5; v1 ships local-only.

To re-run a single phase without re-running the rest:

```sh
bash docker/spike/probe.sh                       # re-run R6 probe
bash docker/spike/run-arm1.sh                    # re-run arm 1 only
bash docker/spike/run-arm2.sh                    # re-run arm 2 (probe-gated)
bash docker/spike/run-arm3.sh                    # re-run arm 3 only
bash docker/spike/capture-hosts.sh               # re-run egress capture only
bash docker/spike/report.sh                      # regenerate report from existing JSONs
```

Re-running an arm overwrites the corresponding `arm{N}-results.json`. The report reads whatever artifacts are currently
in this directory, so a partial re-run produces a partial report (the report acknowledges missing artifacts explicitly).

## Disposal after the spike

After the report lands and the shape decision discussion concludes, dispose of the local spike image:

```sh
docker image rm anc-sandbox-spike:$(git rev-parse --short HEAD)
# Or run with --dispose during the spike: bash docker/spike/run-spike.sh --dispose
```

Disposal is best-effort cleanup. The KD1 firewall (label + CI gate) is the load-bearing protection against accidental
push to the production registry.

## CF Sandbox follow-up sub-plan status

KTD5 in the plan staged the CF Sandbox harness as a separate sub-plan that runs only if the local data warrants
production-fidelity numbers. The sub-plan adds a throwaway Worker, a wrangler `[[containers]]` binding, CF Containers
registry upload (with the spike image's KD1 label intact), and per-entry RPC dispatch from the harness to that Worker.
If/when it lands, this README gains a `cf-sandbox-results.md` companion alongside the local artifacts.

## anc100 vs brew_only caveat

Per R8 and the plan's scope boundaries, this spike's data does NOT answer the `pm=brew_only` tail-coverage question. The
deferred second-pass spike against the brew-only tail is the gate for A+D / B adoption; the local-mode data here only
tells the shape-C-vs-status-quo story for the common case.
