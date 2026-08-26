#!/usr/bin/env bash
# Live MCP surface smoke. Runs dual-stack checks 1–6 plus anc-specific extensions
# against `<base-url>/mcp`:
#
#   1. server-card: protocolVersion=2026-07-28, mcp_endpoint points at {base}/mcp
#   2. legacy-initialize: client 2025-06-18, instructions mention 2026-07-28
#   3. legacy-tools-list: 13 tools with core names
#   4. legacy-get-scorecard: registry hit on curated slug ripgrep
#   5. modern-tools-list: _meta + headers, ttlMs=3600000, cacheScope=public
#   6. modern-get-scorecard: hit on ripgrep + miss on unknown slug
#
# Anc-specific extensions (after check 6):
#   - Symmetry contract: get_scorecard and score_cli on ripgrep both return
#     source=registry; score_cli bounces with next_tool=get_scorecard.
#   - Live audit: score_cli against `--mcp-binary` (fresh non-registry binary)
#     completes with audited=true, source=live, anc_version populated, no error.
#
# Same suite against any base URL. Callers:
#   - scripts/release/preflight.sh mcp                   -> http://localhost:8787 (local wrangler dev)
#   - scripts/release/postflight.sh --env staging mcp    -> staging Worker (through CF Access)
#   - scripts/release/postflight.sh --env prod mcp       -> https://anc.dev (no auth)
#
# Usage:
#   scripts/release/mcp-smoke.sh [<base-url>] [--mcp-binary <binary>]
#                                [--full-cache-coverage] [--result-file PATH]
#
# Environment:
#   MCP_SMOKE_BASE         Aliases positional <base-url> when set and no URL arg given.
#
# Flags:
#   --mcp-binary <binary>  Fresh non-registry binary for the live audit (default:
#                          $MCP_BINARY or `figlet`). Must be in the bin-producing
#                          allowlist; library-only packages (lodash, chalk, etc.)
#                          install cleanly but produce no executable, and the
#                          sandbox correctly returns chain_resolved_no_binary_produced.
#   --full-cache-coverage  Run the live-audit gate as TWO sub-gates instead of one:
#                          first call with `bypass_cache: true` -> assert
#                          source=fresh-audit (exercises the container DO path);
#                          second call on the same binary without bypass -> assert
#                          source=live-cache (exercises the R2 read-tier short-circuit
#                          on the binary the first call just populated). Both paths
#                          must produce their expected outcome for the gate to pass.
#                          Refused when the base URL hostname matches a prod surface
#                          (anc.dev). The bypass argument is silently ignored by the
#                          Worker unless MCP_CACHE_BYPASS_ALLOWED="true" is bound
#                          (staging env only), so even bypassing the script's
#                          hostname check cannot change prod behavior.
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

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
readonly REPO_ROOT

# Shared output helpers, gate counters, dependency checks ------------------

. "$REPO_ROOT/scripts/release/_lib.sh"

# Modern-era _meta envelope (embedded in JSON-RPC params). -----------------

META='"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientInfo":{"name":"anc-mcp-smoke","version":"0"},"io.modelcontextprotocol/clientCapabilities":{}}'

# Argument parsing -----------------------------------------------------------

BASE_URL=""
MCP_BINARY="${MCP_BINARY:-figlet}"
RESULT_FILE=""
FULL_CACHE_COVERAGE=0

# Bin-producing npm allowlist. Add only after confirming `npm view <pkg> bin`
# returns a non-empty bin map; library-only packages produce no executable and
# the sandbox correctly returns chain_resolved_no_binary_produced for them.
readonly MCP_BINARY_ALLOWLIST=(figlet prettier tsx nodemon npm-check-updates)

# Hostnames considered "prod" for the --full-cache-coverage refusal rule. Grow
# this list if additional production surfaces are added.
readonly MCP_PROD_HOSTS=(anc.dev www.anc.dev)

usage() {
    sed -n '2,65p' "$0" | sed 's/^# \?//'
    exit 2
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --mcp-binary)          MCP_BINARY="$2"; shift 2;;
        --full-cache-coverage) FULL_CACHE_COVERAGE=1; shift;;
        --result-file)         RESULT_FILE="$2"; shift 2;;
        -h|--help)             usage;;
        -*)                    echo "unknown flag: $1" >&2; usage;;
        *)                     [[ -z "$BASE_URL" ]] && BASE_URL="$1" || { echo "unexpected arg: $1" >&2; usage; }; shift;;
    esac
done

[[ -n "$BASE_URL" ]] || BASE_URL="${MCP_SMOKE_BASE:-}"
[[ -n "$BASE_URL" ]] || { echo "base URL required (positional arg or MCP_SMOKE_BASE)" >&2; usage; }

require_bin curl
require_bin jq

# Strip any trailing slash from BASE_URL so `${BASE_URL}/mcp` is always clean.
BASE_URL="${BASE_URL%/}"

# Validate --mcp-binary against the bin-producing allowlist.
in_allowlist() {
    local needle=$1 hay
    for hay in "${MCP_BINARY_ALLOWLIST[@]}"; do
        [[ "$hay" == "$needle" ]] && return 0
    done
    return 1
}
if ! in_allowlist "$MCP_BINARY"; then
    echo "--mcp-binary '$MCP_BINARY' is not in the bin-producing allowlist." >&2
    echo "Allowed: ${MCP_BINARY_ALLOWLIST[*]}" >&2
    echo "Library-only packages install cleanly but produce no executable; the sandbox" >&2
    echo "returns chain_resolved_no_binary_produced and the live-audit gate cannot pass." >&2
    exit 2
fi

# Refuse --full-cache-coverage against prod surfaces. The script-side hostname
# match is the first layer; the second layer is the Worker-side gating
# (MCP_CACHE_BYPASS_ALLOWED env var bound only on staging), so even if a caller
# bypasses the script and forges `bypass_cache: true` against prod the Worker
# silently ignores it.
if [[ "$FULL_CACHE_COVERAGE" -eq 1 ]]; then
    base_host=$(printf '%s' "$BASE_URL" | sed -E 's|^[a-z]+://||; s|/.*$||; s|:.*$||')
    for prod_host in "${MCP_PROD_HOSTS[@]}"; do
        if [[ "$base_host" == "$prod_host" ]]; then
            echo "--full-cache-coverage is refused against prod ($base_host)." >&2
            echo "Prod runs accept live-cache; the cache-miss-via-bypass leg requires" >&2
            echo "MCP_CACHE_BYPASS_ALLOWED bound at the Worker, which is staging-only." >&2
            exit 2
        fi
    done
fi

# Response capture dir and auth headers (optional). Staged into a mode-600 curl
# config file when both CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET are
# present; every curl invocation passes `-K "$CF_CONFIG"`.
OUT="$(mktemp -d)"
CF_CONFIG="$(mktemp)"
chmod 600 "$CF_CONFIG"
trap 'rm -rf "$OUT" "$CF_CONFIG"' EXIT
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

# Dual-stack check reporter. Updates PASS_COUNT / FAIL_COUNT for --result-file
# aggregation alongside gate_pass / gate_fail from anc-specific extensions.
report() {
    local num=$1 name=$2 status=$3 detail=$4
    if [[ "$status" == "ok" ]]; then
        printf "  CHECK %s [%s]: PASS %s\n" "$num" "$name" "$detail"
        PASS_COUNT=$((PASS_COUNT + 1))
    else
        printf "  CHECK %s [%s]: FAIL %s\n" "$num" "$name" "$detail"
        FAIL_COUNT=$((FAIL_COUNT + 1))
    fi
}

# Scripted checks 1–6 --------------------------------------------------------

run_check_1_server_card() {
    local http_code protocol endpoint
    http_code=$(curl -sS -w '%{http_code}' -o "$OUT/1-card.json" -K "$CF_CONFIG" -m 15 \
        "${BASE_URL}/.well-known/mcp/server-card.json" 2>/dev/null || echo "000")
    protocol=$(jq -r '.protocolVersion // empty' "$OUT/1-card.json" 2>/dev/null || true)
    endpoint=$(jq -r '.mcp_endpoint // empty' "$OUT/1-card.json" 2>/dev/null || true)

    if [[ "$http_code" == "503" ]]; then
        report 1 server-card no "HTTP 503 (MCP_ENABLED off?)"
        return
    fi
    if [[ "$http_code" == "200" && "$protocol" == "2026-07-28" && "$endpoint" == "${BASE_URL}/mcp" ]]; then
        report 1 server-card ok "protocolVersion=$protocol mcp_endpoint=$endpoint"
    else
        report 1 server-card no \
            "http=$http_code protocolVersion=$protocol mcp_endpoint=$endpoint (expected ${BASE_URL}/mcp)"
    fi
}

run_check_2_legacy_initialize() {
    local http_code server instructions
    http_code=$(curl -sS -w '%{http_code}' -o "$OUT/2-init.json" -K "$CF_CONFIG" -m 15 \
        -H 'Content-Type: application/json' -H 'Accept: application/json' \
        -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"anc-mcp-smoke","version":"0"}}}' \
        "${BASE_URL}/mcp" 2>/dev/null || echo "000")
    server=$(jq -r '.result.serverInfo.name // empty' "$OUT/2-init.json" 2>/dev/null || true)
    instructions=$(jq -r '.result.instructions // empty' "$OUT/2-init.json" 2>/dev/null || true)

    if [[ "$http_code" == "503" ]]; then
        report 2 legacy-initialize no "HTTP 503 (MCP_ENABLED off?)"
        return
    fi
    if [[ "$http_code" == "200" && "$server" == "anc" && "$instructions" == *2026-07-28* ]]; then
        report 2 legacy-initialize ok "server=$server instructions mention 2026-07-28"
    else
        report 2 legacy-initialize no \
            "http=$http_code server=$server instructions_2026-07-28=$([[ "$instructions" == *2026-07-28* ]] && echo yes || echo no)"
    fi
}

run_check_3_legacy_tools_list() {
    local http_code tool_count missing=() name
    http_code=$(curl -sS -w '%{http_code}' -o "$OUT/3-tools-list.json" -K "$CF_CONFIG" -m 15 \
        -H 'Content-Type: application/json' -H 'Accept: application/json' \
        -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
        "${BASE_URL}/mcp" 2>/dev/null || echo "000")
    tool_count=$(jq '.result.tools | length' "$OUT/3-tools-list.json" 2>/dev/null || echo "0")

    for name in get_scorecard list_principles score_cli; do
        if ! jq -e --arg n "$name" '.result.tools[] | select(.name == $n)' "$OUT/3-tools-list.json" >/dev/null 2>&1; then
            missing+=("$name")
        fi
    done

    if [[ "$http_code" == "503" ]]; then
        report 3 legacy-tools-list no "HTTP 503 (MCP_ENABLED off?)"
        return
    fi
    if [[ "$http_code" == "200" && "$tool_count" == "13" && ${#missing[@]} -eq 0 ]]; then
        report 3 legacy-tools-list ok "13 tools, core names present"
    else
        report 3 legacy-tools-list no "http=$http_code count=$tool_count missing=${missing[*]:-none}"
    fi
}

run_check_4_legacy_get_scorecard() {
    local http_code inner source has_scorecard
    http_code=$(curl -sS -w '%{http_code}' -o "$OUT/4-get-scorecard.json" -K "$CF_CONFIG" -m 15 \
        -H 'Content-Type: application/json' -H 'Accept: application/json' \
        -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_scorecard","arguments":{"slug":"ripgrep"}}}' \
        "${BASE_URL}/mcp" 2>/dev/null || echo "000")
    inner=$(jq -r '.result.content[0].text // empty' "$OUT/4-get-scorecard.json" 2>/dev/null || true)
    source=$(printf '%s' "$inner" | jq -r '.source // empty' 2>/dev/null || true)
    has_scorecard=$(printf '%s' "$inner" | jq -r '.scorecard != null' 2>/dev/null || echo "false")

    if [[ "$http_code" == "503" ]]; then
        report 4 legacy-get-scorecard no "HTTP 503 (MCP_ENABLED off?)"
        return
    fi
    if [[ "$http_code" == "200" && ( "$source" == "registry" || "$has_scorecard" == "true" ) ]]; then
        report 4 legacy-get-scorecard ok "source=$source registry hit on ripgrep"
    else
        report 4 legacy-get-scorecard no "http=$http_code source=$source has_scorecard=$has_scorecard"
    fi
}

run_check_5_modern_tools_list() {
    local http_code tool_count ttl cache_scope
    http_code=$(curl -sS -w '%{http_code}' -o "$OUT/5-modern-list.json" -K "$CF_CONFIG" -m 15 \
        -H 'Content-Type: application/json' -H 'Accept: application/json' \
        -H 'MCP-Protocol-Version: 2026-07-28' -H 'Mcp-Method: tools/list' \
        -d "{\"jsonrpc\":\"2.0\",\"id\":10,\"method\":\"tools/list\",\"params\":{$META}}" \
        "${BASE_URL}/mcp" 2>/dev/null || echo "000")
    tool_count=$(jq '.result.tools | length' "$OUT/5-modern-list.json" 2>/dev/null || echo "0")
    # -r: cacheScope is a JSON string; without raw output the value is `"public"`
    # (quoted) and the == public comparison fails even when the field is correct.
    ttl=$(jq -r '[.. | objects | .ttlMs? // empty] | first // empty' "$OUT/5-modern-list.json" 2>/dev/null || true)
    cache_scope=$(jq -r '[.. | objects | .cacheScope? // empty] | first // empty' "$OUT/5-modern-list.json" 2>/dev/null || true)

    if [[ "$http_code" == "503" ]]; then
        report 5 modern-tools-list no "HTTP 503 (MCP_ENABLED off?)"
        return
    fi
    if [[ "$http_code" == "200" && "$tool_count" == "13" && "$ttl" == "3600000" && "$cache_scope" == "public" ]]; then
        report 5 modern-tools-list ok "13 tools ttlMs=$ttl cacheScope=$cache_scope"
    else
        report 5 modern-tools-list no "http=$http_code count=$tool_count ttlMs=$ttl cacheScope=$cache_scope"
    fi
}

run_check_6_modern_get_scorecard() {
    local http_hit http_miss inner_hit inner_miss source has_sc found hit_ok miss_ok
    http_hit=$(curl -sS -w '%{http_code}' -o "$OUT/6-modern-hit.json" -K "$CF_CONFIG" -m 15 \
        -H 'Content-Type: application/json' -H 'Accept: application/json' \
        -H 'MCP-Protocol-Version: 2026-07-28' -H 'Mcp-Method: tools/call' -H 'Mcp-Name: get_scorecard' \
        -d "{\"jsonrpc\":\"2.0\",\"id\":11,\"method\":\"tools/call\",\"params\":{\"name\":\"get_scorecard\",\"arguments\":{\"slug\":\"ripgrep\"},$META}}" \
        "${BASE_URL}/mcp" 2>/dev/null || echo "000")
    inner_hit=$(jq -r '.result.content[0].text // empty' "$OUT/6-modern-hit.json" 2>/dev/null || true)
    source=$(printf '%s' "$inner_hit" | jq -r '.source // empty' 2>/dev/null || true)
    has_sc=$(printf '%s' "$inner_hit" | jq -r '.scorecard != null' 2>/dev/null || echo "false")

    http_miss=$(curl -sS -w '%{http_code}' -o "$OUT/6-modern-miss.json" -K "$CF_CONFIG" -m 15 \
        -H 'Content-Type: application/json' -H 'Accept: application/json' \
        -H 'MCP-Protocol-Version: 2026-07-28' -H 'Mcp-Method: tools/call' -H 'Mcp-Name: get_scorecard' \
        -d "{\"jsonrpc\":\"2.0\",\"id\":12,\"method\":\"tools/call\",\"params\":{\"name\":\"get_scorecard\",\"arguments\":{\"slug\":\"nope-not-a-tool\"},$META}}" \
        "${BASE_URL}/mcp" 2>/dev/null || echo "000")
    inner_miss=$(jq -r '.result.content[0].text // empty' "$OUT/6-modern-miss.json" 2>/dev/null || true)
    found=$(printf '%s' "$inner_miss" | jq -r 'if has("found") then .found|tostring else "" end' 2>/dev/null || true)

    if [[ "$http_hit" == "503" || "$http_miss" == "503" ]]; then
        report 6 modern-get-scorecard no "HTTP 503 (MCP_ENABLED off?)"
        return
    fi

    hit_ok=0
    miss_ok=0
    if [[ "$http_hit" == "200" && ( "$source" == "registry" || "$has_sc" == "true" ) ]]; then
        hit_ok=1
    fi
    if [[ "$http_miss" == "200" && "$found" == "false" ]]; then
        miss_ok=1
    fi

    if [[ "$hit_ok" -eq 1 && "$miss_ok" -eq 1 ]]; then
        report 6 modern-get-scorecard ok "hit source=$source; miss found=false"
    else
        report 6 modern-get-scorecard no \
            "hit http=$http_hit source=$source has_scorecard=$has_sc; miss http=$http_miss found=$found"
    fi
}

# Anc-specific extensions (symmetry + live audit) ----------------------------

run_gate_symmetry() {
    local read_source audit_source audit_next
    read_source=$(curl -fsSL -K "$CF_CONFIG" -m 15 -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
        -d '{"jsonrpc":"2.0","id":20,"method":"tools/call","params":{"name":"get_scorecard","arguments":{"slug":"ripgrep"}}}' \
        "${BASE_URL}/mcp" 2>/dev/null \
        | jq -r '.result.content[0].text' 2>/dev/null \
        | jq -r '.source // empty' 2>/dev/null || true)
    audit_source=$(curl -fsSL -K "$CF_CONFIG" -m 15 -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
        -d '{"jsonrpc":"2.0","id":21,"method":"tools/call","params":{"name":"score_cli","arguments":{"slug":"ripgrep"}}}' \
        "${BASE_URL}/mcp" 2>/dev/null \
        | jq -r '.result.content[0].text' 2>/dev/null \
        | jq -r '.source // empty' 2>/dev/null || true)
    audit_next=$(curl -fsSL -K "$CF_CONFIG" -m 15 -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
        -d '{"jsonrpc":"2.0","id":21,"method":"tools/call","params":{"name":"score_cli","arguments":{"slug":"ripgrep"}}}' \
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

# Issue one `score_cli tools/call` and populate the SCORE_CLI_* shell vars with
# the parsed envelope fields. Callers grade those vars; this helper does not
# call gate_pass / gate_fail itself.
#
# Args:
#   $1  bypass_cache (0 or 1) -> sent as `"bypass_cache": true|false` in arguments
#   $2  request id (integer) -> JSON-RPC id, for distinguishing the two sub-calls
#
# Sets:
#   SCORE_CLI_RAW         the raw response body (first 200 bytes used on failure)
#   SCORE_CLI_RPC_ERR     `.error.code` from the JSON-RPC envelope (e.g., -32099)
#   SCORE_CLI_RESULT_TEXT `.result.content[0].text` (the inner orchestrator envelope)
#   SCORE_CLI_AUDITED     audited boolean as string ("true"/"false"/"")
#   SCORE_CLI_HAS_SC      "true"/"false" -> .scorecard != null
#   SCORE_CLI_SOURCE      .source ("registry" | "live-cache" | "fresh-audit" | "")
#   SCORE_CLI_ANC         .anc_version
#   SCORE_CLI_NEXT        .next_tool
#   SCORE_CLI_ERR         .error (string form, .code, .message, or "")
do_score_cli_call() {
    local bypass=$1 rpc_id=$2
    local bypass_json=false
    [[ "$bypass" -eq 1 ]] && bypass_json=true
    local body
    body=$(curl -fsSL -K "$CF_CONFIG" -m 60 -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
        -d "{\"jsonrpc\":\"2.0\",\"id\":${rpc_id},\"method\":\"tools/call\",\"params\":{\"name\":\"score_cli\",\"arguments\":{\"install\":\"npm install -g ${MCP_BINARY}\",\"bypass_cache\":${bypass_json}}}}" \
        "${BASE_URL}/mcp" 2>/dev/null || true)
    SCORE_CLI_RAW=$body
    SCORE_CLI_RPC_ERR=$(printf '%s' "$body" | jq -r '.error.code // empty' 2>/dev/null || true)
    SCORE_CLI_RESULT_TEXT=$(printf '%s' "$body" | jq -r '.result.content[0].text // empty' 2>/dev/null || true)
    # `.field // empty` treats JSON booleans (true/false) as nullish, so a
    # legitimate `"audited": false` would silently round-trip through `// empty`
    # as the empty string. Use `if has(...)` to preserve the boolean payload.
    SCORE_CLI_AUDITED=$(printf '%s' "$SCORE_CLI_RESULT_TEXT" | jq -r 'if has("audited") then .audited|tostring else "" end' 2>/dev/null || true)
    SCORE_CLI_HAS_SC=$(printf '%s' "$SCORE_CLI_RESULT_TEXT" | jq -r '.scorecard != null | tostring' 2>/dev/null || echo "false")
    SCORE_CLI_SOURCE=$(printf '%s' "$SCORE_CLI_RESULT_TEXT" | jq -r '.source // empty' 2>/dev/null || true)
    SCORE_CLI_ANC=$(printf '%s' "$SCORE_CLI_RESULT_TEXT" | jq -r '.anc_version // empty' 2>/dev/null || true)
    SCORE_CLI_NEXT=$(printf '%s' "$SCORE_CLI_RESULT_TEXT" | jq -r '.next_tool // empty' 2>/dev/null || true)
    # `.error` can arrive as:
    #   - missing (no field) -> empty
    #   - an object (`{"code": -1, "message": "..."}`) -> prefer `.code` then `.message`
    #   - a string (sandbox returns `"error": "chain_resolved_no_binary_produced"`) -> use as-is
    # Earlier shape `.error.code // empty` silently swallowed the string form, so a
    # legit sandbox failure surfaced as empty fields with no diagnostic.
    SCORE_CLI_ERR=$(printf '%s' "$SCORE_CLI_RESULT_TEXT" | jq -r '
        if (has("error") | not) or .error == null then ""
        elif (.error | type) == "string" then .error
        elif (.error | type) == "object" then (.error.code // .error.message // (.error | tostring))
        else (.error | tostring)
        end' 2>/dev/null || true)
}

# Grade the most recent do_score_cli_call against a required source:
#   $1  gate label (printed on pass / fail)
#   $2  required source: "fresh-audit" | "live-cache" | "any"
# "any" passes on either fresh-audit OR live-cache (the existing relaxed shape;
# used by the prod-side single-gate path).
grade_score_cli() {
    local label=$1 required=$2
    if [[ "$SCORE_CLI_RPC_ERR" == "-32099" ]]; then
        gate_fail "$label" \
            "JSON-RPC -32099 rate-limit breach (MCP_AUDIT_LIMITER misconfigured OR per-IP KV hourly ceiling consumed)"
        return
    fi
    if [[ -z "$SCORE_CLI_RESULT_TEXT" ]]; then
        gate_fail "$label" "no result body or unexpected envelope: $(printf '%s' "$SCORE_CLI_RAW" | head -c 200)"
        return
    fi
    if [[ -n "$SCORE_CLI_ERR" ]]; then
        gate_fail "$label" "error: $SCORE_CLI_ERR"
        return
    fi
    case "$required" in
        fresh-audit)
            if [[ "$SCORE_CLI_SOURCE" == "fresh-audit" && "$SCORE_CLI_AUDITED" == "true" && "$SCORE_CLI_HAS_SC" == "true" && -n "$SCORE_CLI_ANC" ]]; then
                gate_pass "$label: source=fresh-audit anc=$SCORE_CLI_ANC (full DO path exercised)"
            elif [[ "$SCORE_CLI_SOURCE" == "live-cache" ]]; then
                gate_fail "$label" \
                    "expected source=fresh-audit but got live-cache. MCP_CACHE_BYPASS_ALLOWED not bound? (staging env.staging.vars; absent on prod). Or bypass_cache silently ignored by an older deploy."
            else
                gate_fail "$label" \
                    "audited=$SCORE_CLI_AUDITED has_scorecard=$SCORE_CLI_HAS_SC source=$SCORE_CLI_SOURCE next_tool=$SCORE_CLI_NEXT anc=$SCORE_CLI_ANC err=$SCORE_CLI_ERR"
            fi
            ;;
        live-cache)
            if [[ "$SCORE_CLI_SOURCE" == "live-cache" && "$SCORE_CLI_AUDITED" == "false" && "$SCORE_CLI_NEXT" == "get_scorecard" ]]; then
                gate_pass "$label: source=live-cache next_tool=get_scorecard (R2 short-circuit exercised)"
            else
                gate_fail "$label" \
                    "expected source=live-cache but got audited=$SCORE_CLI_AUDITED source=$SCORE_CLI_SOURCE next_tool=$SCORE_CLI_NEXT (R2 write from the prior call did not land? cache key drift?)"
            fi
            ;;
        any)
            if [[ "$SCORE_CLI_SOURCE" == "fresh-audit" && "$SCORE_CLI_AUDITED" == "true" && "$SCORE_CLI_HAS_SC" == "true" && -n "$SCORE_CLI_ANC" ]]; then
                gate_pass "$label: source=fresh-audit anc=$SCORE_CLI_ANC (full DO path exercised)"
            elif [[ "$SCORE_CLI_SOURCE" == "live-cache" && "$SCORE_CLI_AUDITED" == "false" && "$SCORE_CLI_NEXT" == "get_scorecard" ]]; then
                gate_pass "$label: source=live-cache (cached from prior run; pass --full-cache-coverage to also exercise the live container path via bypass_cache)"
            else
                gate_fail "$label" \
                    "audited=$SCORE_CLI_AUDITED has_scorecard=$SCORE_CLI_HAS_SC source=$SCORE_CLI_SOURCE next_tool=$SCORE_CLI_NEXT anc=$SCORE_CLI_ANC err=$SCORE_CLI_ERR"
            fi
            ;;
    esac
}

run_gate_live_audit() {
    if grep -E "^- name: ${MCP_BINARY}$" "$REPO_ROOT/registry.yaml" >/dev/null 2>&1; then
        gate_fail "MCP audit binary selection" "$MCP_BINARY is in registry.yaml; pick another via --mcp-binary"
        return
    fi

    if [[ "$FULL_CACHE_COVERAGE" -eq 1 ]]; then
        # Sub-gate A: cache-miss via bypass_cache. score_cli sees bypass_cache=true
        # AND MCP_CACHE_BYPASS_ALLOWED=true on the Worker, skips both R2 tiers,
        # runs the container DO end-to-end, and writes the cache as a side effect.
        # Consumes one unit of the per-IP audit budget (5 per 60s burst, 5 per
        # hour KV-backed). Expected: source=fresh-audit.
        do_score_cli_call 1 30
        grade_score_cli "live MCP audit on $MCP_BINARY (cache-miss via bypass_cache=true)" fresh-audit
        # Sub-gate B: cache-hit on the same binary. The previous call just wrote
        # the cache, so lookupOnly's R2 tier is now warm. Expected: source=live-cache.
        # Does not consume audit budget (lookupOnly short-circuits before the
        # MCP_AUDIT_LIMITER gate).
        do_score_cli_call 0 31
        grade_score_cli "live MCP audit on $MCP_BINARY (cache-hit, no bypass)" live-cache
    else
        # Single relaxed gate (prod runs; local runs without coverage). Accepts
        # either fresh-audit (uncached binary) or live-cache (R2 short-circuit).
        do_score_cli_call 0 30
        grade_score_cli "live MCP audit on $MCP_BINARY" any
    fi
}

# Main -----------------------------------------------------------------------

header "Live MCP surface against $BASE_URL"
run_check_1_server_card
run_check_2_legacy_initialize
run_check_3_legacy_tools_list
run_check_4_legacy_get_scorecard
run_check_5_modern_tools_list
run_check_6_modern_get_scorecard
run_gate_symmetry
run_gate_live_audit

printf "\nRESULT: %d pass / %d fail\n" "$PASS_COUNT" "$FAIL_COUNT"
printf "Response capture dir: %s\n" "$OUT"

emit_summary_or_result

[[ $FAIL_COUNT -eq 0 ]] || exit 1
