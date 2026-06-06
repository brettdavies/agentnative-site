#!/usr/bin/env bash
# Live MCP surface smoke. Runs three gates against `<base-url>/mcp`:
#
#   1. Transport: POST initialize + tools/list, confirm server=anc, protocol=2025-06-18,
#      tools.length=9.
#   2. Symmetry contract: get_scorecard and score_cli against the curated slug `ripgrep`
#      must BOTH return source="registry" (lookupOnly + runFreshOnly compose the same
#      registry-hit branch). score_cli must bounce with next_tool="get_scorecard".
#   3. Live audit: score_cli against `--mcp-binary` (a fresh non-registry binary) must
#      complete with audited=true, source="live", anc_version populated, no error.
#
# Same three gates against any base URL. Callers:
#   - scripts/release/preflight.sh mcp                   -> http://localhost:8787 (local wrangler dev)
#   - scripts/release/postflight.sh --env staging mcp    -> staging Worker (through CF Access)
#   - scripts/release/postflight.sh --env prod mcp       -> https://anc.dev (no auth)
#
# Usage:
#   scripts/release/mcp-smoke.sh <base-url> [--mcp-binary <binary>] [--result-file PATH]
#
# Flags:
#   --mcp-binary <binary>  Fresh non-registry binary for the live audit (default:
#                          $MCP_BINARY or `figlet`)
#   --result-file PATH     When set, the script writes "<pass> <fail> <skip>" to PATH
#                          at exit so a parent orchestrator script can aggregate
#                          counters across its own gates. Without this flag, prints
#                          a colored summary line instead.
#
# Auth (optional, env-driven):
#   When CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET are both set in the
#   environment, the script attaches CF Access service-token headers to every
#   curl invocation. This makes the same suite usable against CF-Access-gated
#   surfaces (staging) without changing the call shape. Unset env -> no headers
#   (local wrangler dev, prod anc.dev).
#
# Exit codes:
#   0 = all gates passed (or skipped)
#   1 = one or more gates failed
#   2 = setup error (missing dep, no base URL, etc.)
#
# Dependencies:
#   - curl, jq on PATH

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
readonly REPO_ROOT

# Shared output helpers, gate counters, dependency checks ------------------

. "$REPO_ROOT/scripts/release/_lib.sh"

# Argument parsing -----------------------------------------------------------

BASE_URL=""
MCP_BINARY="${MCP_BINARY:-figlet}"
RESULT_FILE=""

usage() {
    sed -n '2,41p' "$0" | sed 's/^# \?//'
    exit 2
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --mcp-binary)  MCP_BINARY="$2"; shift 2;;
        --result-file) RESULT_FILE="$2"; shift 2;;
        -h|--help)     usage;;
        -*)            echo "unknown flag: $1" >&2; usage;;
        *)             [[ -z "$BASE_URL" ]] && BASE_URL="$1" || { echo "unexpected arg: $1" >&2; usage; }; shift;;
    esac
done

[[ -n "$BASE_URL" ]] || { echo "base URL required" >&2; usage; }

require_bin curl
require_bin jq

# Strip any trailing slash from BASE_URL so `${BASE_URL}/mcp` is always clean.
BASE_URL="${BASE_URL%/}"

# Auth headers (optional). Staged into a mode-600 curl config file when both
# CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET are present in the environment;
# every curl invocation below passes `-K "$CF_CONFIG"` so the values never reach
# argv. Empty config file when no auth env vars are set; curl -K reads an empty
# file as a no-op.
CF_CONFIG="$(mktemp)"
chmod 600 "$CF_CONFIG"
trap 'rm -f "$CF_CONFIG"' EXIT
if [[ -n "${CF_ACCESS_CLIENT_ID:-}" && -n "${CF_ACCESS_CLIENT_SECRET:-}" ]]; then
    printf 'header = "CF-Access-Client-Id: %s"\n' "$CF_ACCESS_CLIENT_ID" >> "$CF_CONFIG"
    printf 'header = "CF-Access-Client-Secret: %s"\n' "$CF_ACCESS_CLIENT_SECRET" >> "$CF_CONFIG"
fi

emit_summary_or_result() {
    if [[ -n "$RESULT_FILE" ]]; then
        printf "%d %d %d\n" "$PASS_COUNT" "$FAIL_COUNT" "$SKIP_COUNT" > "$RESULT_FILE"
    else
        print_summary
    fi
}

# Gates ----------------------------------------------------------------------

run_gate_transport() {
    local init_resp server protocol tool_count
    init_resp=$(curl -fsSL -K "$CF_CONFIG" -m 15 -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
        -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"mcp-smoke","version":"1"}}}' \
        "${BASE_URL}/mcp" 2>/dev/null || true)
    server=$(printf '%s' "$init_resp" | jq -r '.result.serverInfo.name // empty' 2>/dev/null || true)
    protocol=$(printf '%s' "$init_resp" | jq -r '.result.protocolVersion // empty' 2>/dev/null || true)
    if [[ "$server" == "anc" && "$protocol" == "2025-06-18" ]]; then
        gate_pass "/mcp initialize: server=anc protocol=$protocol"
    else
        gate_fail "/mcp initialize" "server=$server protocol=$protocol (MCP_ENABLED off? transport regression?)"
    fi

    tool_count=$(curl -fsSL -K "$CF_CONFIG" -m 15 -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
        -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
        "${BASE_URL}/mcp" 2>/dev/null | jq '.result.tools | length' 2>/dev/null || echo "0")
    if [[ "$tool_count" == "9" ]]; then
        gate_pass "tools/list reports 9-tool surface"
    else
        gate_fail "tools/list" "expected 9 tools, got $tool_count (tool-wiring regression)"
    fi
}

run_gate_symmetry() {
    local read_source audit_source audit_next
    read_source=$(curl -fsSL -K "$CF_CONFIG" -m 15 -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
        -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_scorecard","arguments":{"slug":"ripgrep"}}}' \
        "${BASE_URL}/mcp" 2>/dev/null \
        | jq -r '.result.content[0].text' 2>/dev/null \
        | jq -r '.source // empty' 2>/dev/null || true)
    audit_source=$(curl -fsSL -K "$CF_CONFIG" -m 15 -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
        -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"score_cli","arguments":{"slug":"ripgrep"}}}' \
        "${BASE_URL}/mcp" 2>/dev/null \
        | jq -r '.result.content[0].text' 2>/dev/null \
        | jq -r '.source // empty' 2>/dev/null || true)
    audit_next=$(curl -fsSL -K "$CF_CONFIG" -m 15 -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
        -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"score_cli","arguments":{"slug":"ripgrep"}}}' \
        "${BASE_URL}/mcp" 2>/dev/null \
        | jq -r '.result.content[0].text' 2>/dev/null \
        | jq -r '.next_tool // empty' 2>/dev/null || true)

    if [[ "$read_source" == "registry" && "$audit_source" == "registry" && "$audit_next" == "get_scorecard" ]]; then
        gate_pass "symmetry contract: both scorecard tools return source=registry on curated slug"
    else
        gate_fail "symmetry contract" \
            "get_scorecard.source=$read_source score_cli.source=$audit_source next_tool=$audit_next"
    fi
}

run_gate_live_audit() {
    if grep -E "^- name: ${MCP_BINARY}$" "$REPO_ROOT/registry.yaml" >/dev/null 2>&1; then
        gate_fail "MCP audit binary selection" "$MCP_BINARY is in registry.yaml; pick another via --mcp-binary"
        return
    fi

    local audit_body rpc_err_code result_text audited has_scorecard live_source live_anc_v live_err
    audit_body=$(curl -fsSL -K "$CF_CONFIG" -m 60 -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
        -d "{\"jsonrpc\":\"2.0\",\"id\":5,\"method\":\"tools/call\",\"params\":{\"name\":\"score_cli\",\"arguments\":{\"install\":\"npm install -g ${MCP_BINARY}\"}}}" \
        "${BASE_URL}/mcp" 2>/dev/null || true)
    rpc_err_code=$(printf '%s' "$audit_body" | jq -r '.error.code // empty' 2>/dev/null || true)
    if [[ "$rpc_err_code" == "-32099" ]]; then
        gate_fail "live MCP audit on $MCP_BINARY" \
            "JSON-RPC -32099 rate-limit breach (MCP_AUDIT_LIMITER misconfigured OR per-IP KV hourly ceiling consumed)"
        return
    fi
    result_text=$(printf '%s' "$audit_body" | jq -r '.result.content[0].text // empty' 2>/dev/null || true)
    if [[ -z "$result_text" ]]; then
        gate_fail "live MCP audit on $MCP_BINARY" "no result body or unexpected envelope: $(printf '%s' "$audit_body" | head -c 200)"
        return
    fi
    # `.field // empty` treats JSON booleans (true/false) as nullish, so a
    # legitimate `"audited": false` would silently round-trip through `// empty`
    # as the empty string. Use `if has(...)` to preserve the boolean payload.
    audited=$(printf '%s' "$result_text" | jq -r 'if has("audited") then .audited|tostring else "" end' 2>/dev/null || true)
    has_scorecard=$(printf '%s' "$result_text" | jq -r '.scorecard != null | tostring' 2>/dev/null || echo "false")
    live_source=$(printf '%s' "$result_text" | jq -r '.source // empty' 2>/dev/null || true)
    live_anc_v=$(printf '%s' "$result_text" | jq -r '.anc_version // empty' 2>/dev/null || true)
    live_err=$(printf '%s' "$result_text" | jq -r '.error.code // empty' 2>/dev/null || true)
    local next_tool
    next_tool=$(printf '%s' "$result_text" | jq -r '.next_tool // empty' 2>/dev/null || true)

    # Two healthy outcomes from score_cli on a non-registry input:
    #   1. fresh-audit: the live container path ran end-to-end and wrote a scorecard
    #      to R2. Envelope: audited=true, source=fresh-audit, scorecard present,
    #      anc_version populated.
    #   2. live-cache: a prior run cached the binary in R2 within the cache TTL,
    #      so score_cli short-circuits with a bounce envelope. Envelope:
    #      audited=false, source=live-cache, next_tool=get_scorecard, scorecard_url present.
    # Both prove the orchestrator wiring works. To force a fresh-audit (e.g., to
    # validate a new container pin), rotate --mcp-binary to a binary not in the
    # cache.
    if [[ -n "$live_err" ]]; then
        gate_fail "live MCP audit on $MCP_BINARY" "error: $live_err"
    elif [[ "$live_source" == "fresh-audit" && "$audited" == "true" && "$has_scorecard" == "true" && -n "$live_anc_v" ]]; then
        gate_pass "live MCP audit on $MCP_BINARY: source=fresh-audit anc=$live_anc_v (full DO path exercised)"
    elif [[ "$live_source" == "live-cache" && "$audited" == "false" && "$next_tool" == "get_scorecard" ]]; then
        gate_pass "live MCP audit on $MCP_BINARY: source=live-cache (cached from prior run; rotate --mcp-binary to force fresh audit)"
    else
        gate_fail "live MCP audit on $MCP_BINARY" \
            "audited=$audited has_scorecard=$has_scorecard source=$live_source next_tool=$next_tool anc=$live_anc_v err=$live_err"
    fi
}

# Main -----------------------------------------------------------------------

header "Live MCP surface against $BASE_URL"
run_gate_transport
run_gate_symmetry
run_gate_live_audit

emit_summary_or_result

[[ $FAIL_COUNT -eq 0 ]] || exit 1
