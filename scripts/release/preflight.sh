#!/usr/bin/env bash
# Run release preflight gates against the current checkout, plus the chosen
# preflight target environment (--env local or --env staging; default staging).
#
# Usage:
#   scripts/release/preflight.sh <subcommand>
#
# Subcommands:
#   coord     Cross-repo coordination — vendored spec VERSION, skill manifest version, Dockerfile
#             release URL + sha, and (when docker is available) the staging container pin's baked
#             anc binary vocabulary vs the Worker's invocation site. Not env-dependent.
#   build     bun run build + scorecard corpus integrity + badge SVGs + markdown twins. Local only.
#   do-smoke  Live-scoring DO smoke against the --env target.
#               - staging: hits agentnative-site-staging through CF Access (reads the service
#                 token from 1Password via the /1password skill).
#               - local:   hits $LOCAL_URL (no auth); requires `bunx wrangler dev --env staging
#                 --local` running in another terminal.
#   mcp       Live MCP suite against the --env target. Three gates: transport + 9-tool surface,
#             registry-tier symmetry contract, live audit via score_cli against $MCP_BINARY.
#             Same env semantics as do-smoke. Always passes --full-cache-coverage to mcp-smoke.sh
#             so the live-audit gate runs as two sub-gates: cache-miss via bypass_cache=true
#             (asserts source=fresh-audit) + cache-hit on the same binary without bypass
#             (asserts source=live-cache). Both paths must produce their expected outcome; the
#             cache-miss leg requires MCP_CACHE_BYPASS_ALLOWED bound at the Worker (staging-only).
#   dist      Distribution surfaces against the --env target — /check -> /audit redirect,
#             skill.json served version vs source. The X-Robots-Tag: noindex check runs only in
#             staging mode (the staging-host guard does not fire for localhost in local mode).
#   mechanics Release mechanics sanity — leak check (no guarded paths in cherry-picked diff),
#             triple-diff against origin/main. Not env-dependent.
#   all       Run every above sequentially. Sub-gates within each section continue past individual
#             failures so the operator sees the full picture; the script exits 1 if any gate failed.
#
# Flags:
#   --env <env>          Preflight target: `staging` (default) or `local`. Also honored as $ENV.
#                        Drives do-smoke, mcp, and dist URL + auth selection.
#   --binary <name>      Fresh non-registry binary for do-smoke (default: $BINARY or `emoj`). The name
#                        resolves to a GitHub owner/repo via do_fixture_repo (emoj -> sindresorhus/emoj,
#                        cowsay -> piuccio/cowsay; otherwise sindresorhus/<name>).
#   --mcp-binary <name>  Fresh non-registry binary for mcp audit (default: $MCP_BINARY or `figlet`)
#   --staging-url <url>  Override staging URL (default: https://agentnative-site-staging.brettdavies.workers.dev)
#   --local-url <url>    Override local wrangler dev URL (default: http://localhost:8787)
#
# Exit codes:
#   0 = all gates passed (or skipped with reason)
#   1 = one or more gates failed
#   2 = setup error (missing required dependency, unauthenticated gh, etc.)
#
# Dependencies:
#   - bun, bunx, git, gh, jq, jaq, curl, grep on PATH
#   - docker (optional; coord's pull-and-inspect gate skips if absent)
#   - ~/.claude/skills/1password/scripts/read_field.sh (for --env staging CF Access token)
#
# Companion to scripts/release/postflight.sh (runs AFTER release/* merges to main). Postflight
# uses --env staging|prod with the same shape.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
readonly REPO_ROOT
readonly OP_SKILL="$HOME/.claude/skills/1password/scripts"
readonly OP_ITEM_TOKEN="Cloudflare Access Service Token - agentnative-site-staging"
readonly DEFAULT_STAGING_URL="https://agentnative-site-staging.brettdavies.workers.dev"
readonly DEFAULT_LOCAL_URL="http://localhost:8787"

# Shared output helpers, gate counters, dependency checks ------------------

. "$REPO_ROOT/scripts/release/_lib.sh"

# Argument parsing -----------------------------------------------------------

SUBCMD=""
BINARY="${BINARY:-emoj}"
MCP_BINARY="${MCP_BINARY:-figlet}"
ENV="${ENV:-staging}"
STAGING_URL="$DEFAULT_STAGING_URL"
LOCAL_URL="$DEFAULT_LOCAL_URL"

usage() {
    sed -n '2,41p' "$0" | sed 's/^# \?//'
    exit 2
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --env)          ENV="$2"; shift 2;;
        --binary)       BINARY="$2"; shift 2;;
        --mcp-binary)   MCP_BINARY="$2"; shift 2;;
        --staging-url)  STAGING_URL="$2"; shift 2;;
        --local-url)    LOCAL_URL="$2"; shift 2;;
        -h|--help)      usage;;
        coord|build|do-smoke|mcp|dist|mechanics|all) SUBCMD="$1"; shift;;
        *) echo "unknown arg: $1" >&2; usage;;
    esac
done

[[ -n "$SUBCMD" ]] || usage

case "$ENV" in
    local|staging) ;;
    *) echo "invalid --env: $ENV (must be 'local' or 'staging')" >&2; exit 2;;
esac

# Derived per-env values used by gate_do_smoke, gate_mcp, gate_dist.
case "$ENV" in
    staging) ENV_URL="$STAGING_URL"; ENV_AUTH_NEEDED=1;;
    local)   ENV_URL="$LOCAL_URL";   ENV_AUTH_NEEDED=0;;
esac

# 1Password helpers (read-only) ---------------------------------------------

read_op_field() {
    [[ -x "$OP_SKILL/read_field.sh" ]] || { echo "1Password skill not found at $OP_SKILL" >&2; return 2; }
    "$OP_SKILL/read_field.sh" "$1" "$2" 2>/dev/null
}

# Stages CF Access service-token headers into a curl config file. Caller passes the
# config path; the function fills it with `header = "..."` lines. Values flow through
# bash-builtin printf — no argv leak.
stage_cf_access_headers() {
    local cfg="$1"
    : > "$cfg"
    chmod 600 "$cfg"
    local cid csec
    cid=$(read_op_field "$OP_ITEM_TOKEN" client_id) || return 1
    csec=$(read_op_field "$OP_ITEM_TOKEN" client_secret) || return 1
    [[ -n "$cid" && -n "$csec" ]] || return 1
    printf 'header = "CF-Access-Client-Id: %s"\n' "$cid" >> "$cfg"
    printf 'header = "CF-Access-Client-Secret: %s"\n' "$csec" >> "$cfg"
}

# Gate: coord (cross-repo coordination) -------------------------------------

gate_coord() {
    header "Cross-repo coordination"
    require_bin jq

    # Vendored spec VERSION coherence — spec, anc, principles VERSIONs all readable.
    local spec_v anc_v principles_v worker_v
    spec_v=$(cat "$REPO_ROOT/src/data/spec/VERSION" 2>/dev/null || true)
    anc_v=$(cat "$REPO_ROOT/src/data/anc/VERSION" 2>/dev/null || true)
    principles_v=$(cat "$REPO_ROOT/content/principles/VERSION" 2>/dev/null || true)
    worker_v=$(grep -E '^export const SPEC_VERSION' "$REPO_ROOT/src/worker/spec-version.gen.ts" 2>/dev/null \
        | sed -E "s/.*'([^']+)'.*/\1/" || true)

    if [[ -n "$spec_v" && -n "$principles_v" && -n "$worker_v" ]]; then
        if [[ "$spec_v" == "$worker_v" ]]; then
            gate_pass "vendored spec VERSION ($spec_v) matches worker SPEC_VERSION constant"
        else
            gate_fail "vendored spec VERSION mismatch" "spec/VERSION=$spec_v vs spec-version.gen.ts=$worker_v (rerun bun run build)"
        fi
        gate_pass "vendored VERSIONs readable: spec=$spec_v anc=${anc_v:-?} principles=$principles_v"
    else
        gate_fail "vendored VERSION files" "missing or unreadable (spec=$spec_v anc=$anc_v principles=$principles_v worker=$worker_v)"
    fi

    # Skill manifest version vs latest agent-native-skill release.
    if have_bin gh; then
        local manifest_v latest_v
        manifest_v=$(jq -r '.version' "$REPO_ROOT/src/data/skill/skill.json" 2>/dev/null || true)
        latest_v=$(gh api repos/brettdavies/agentnative-skill/releases/latest --jq .tag_name 2>/dev/null \
            | sed 's/^v//' || true)
        if [[ -n "$manifest_v" && -n "$latest_v" ]]; then
            if [[ "$manifest_v" == "$latest_v" ]]; then
                gate_pass "skill.json version ($manifest_v) matches latest agentnative-skill release"
            else
                gate_fail "skill.json version drift" "skill.json=$manifest_v vs upstream latest=$latest_v (RELEASES.md § Skill releases)"
            fi
        else
            gate_skip "skill.json version vs upstream" "could not read both (manifest=$manifest_v latest=$latest_v)"
        fi
    else
        gate_skip "skill.json upstream version check" "gh not on PATH"
    fi

    # Dockerfile release URL + sha verification.
    local url sha
    url=$(grep -oE 'https://github.com/[^ ]*agentnative-x86_64-unknown-linux-gnu.tar.gz' \
        "$REPO_ROOT/docker/sandbox/Dockerfile" 2>/dev/null | head -1 || true)
    sha=$(grep -oE '[a-f0-9]{64}' "$REPO_ROOT/docker/sandbox/Dockerfile" 2>/dev/null | head -1 || true)
    if [[ -n "$url" && -n "$sha" ]]; then
        if curl -fsSL -I "$url" >/dev/null 2>&1; then
            gate_pass "Dockerfile anc release URL resolves; sha=${sha:0:12}... (full sha verification on rebuild)"
        else
            gate_fail "Dockerfile anc release URL" "HEAD request failed against $url"
        fi
    else
        gate_skip "Dockerfile anc release URL + sha" "could not parse from docker/sandbox/Dockerfile"
    fi

    # Staging container pin: baked anc binary vocabulary vs Worker invocation site.
    if have_bin docker && have_bin jq; then
        local staging_pin worker_cmd
        staging_pin=$(jq -r '.env.staging.containers[0].image // empty' "$REPO_ROOT/wrangler.jsonc" 2>/dev/null \
            | grep -v null || true)
        if [[ -z "$staging_pin" ]]; then
            # jsonc may have comments — fall back to grep
            staging_pin=$(grep -oE '"image": "[^"]+"' "$REPO_ROOT/wrangler.jsonc" 2>/dev/null \
                | head -1 | sed -E 's/.*"image": "([^"]+)"/\1/' || true)
        fi
        worker_cmd=$(grep -oE 'anc (audit|check)' "$REPO_ROOT/src/worker/score/sandbox-exec.ts" 2>/dev/null \
            | head -1 | awk '{print $2}' || true)
        if [[ -n "$staging_pin" && -n "$worker_cmd" ]]; then
            if docker image inspect "$staging_pin" >/dev/null 2>&1 \
                || docker pull "$staging_pin" >/dev/null 2>&1; then
                if docker run --rm --entrypoint /usr/local/bin/anc "$staging_pin" --help 2>/dev/null \
                    | grep -qE "^  $worker_cmd "; then
                    gate_pass "staging container pin baked anc supports '$worker_cmd' (Worker invocation)"
                else
                    gate_fail "staging container baked anc vocabulary" \
                        "Worker invokes 'anc $worker_cmd' but baked binary in $staging_pin does not list it (sandbox-image-anc-cli-rename-coordination)"
                fi
            else
                gate_skip "staging container baked anc inspect" "docker pull failed for $staging_pin (registry auth?)"
            fi
        else
            gate_skip "staging container baked anc inspect" "could not parse pin=$staging_pin or worker_cmd=$worker_cmd"
        fi
    else
        gate_skip "staging container baked anc inspect" "docker not on PATH"
    fi
}

# Gate: build ----------------------------------------------------------------

gate_build() {
    header "Build + asset integrity"
    require_bin bun

    local build_log
    build_log=$(mktemp)
    if ( cd "$REPO_ROOT" && bun run build >"$build_log" 2>&1 ); then
        gate_pass "bun run build exits 0"
    else
        gate_fail "bun run build" "non-zero exit; see $build_log"
        return
    fi

    # WARNINGS_JSON should be {"scorecardOrphans":[],"registryOrphans":[]}
    local warnings
    warnings=$(grep -oE 'WARNINGS_JSON[^[:space:]]*=[^[:space:]]*' "$build_log" 2>/dev/null \
        | tail -1 || true)
    if [[ "$warnings" == *'"scorecardOrphans":[]'* && "$warnings" == *'"registryOrphans":[]'* ]]; then
        gate_pass "scorecard corpus integrity (no orphans)"
    elif [[ -n "$warnings" ]]; then
        gate_fail "scorecard corpus integrity" "WARNINGS_JSON: $warnings"
    else
        gate_skip "scorecard corpus integrity" "WARNINGS_JSON not emitted by build (may be optional)"
    fi
    trash "$build_log" 2>/dev/null || rm -f "$build_log"

    # Badge SVG coverage.
    if [[ -d "$REPO_ROOT/dist/badge" && -d "$REPO_ROOT/scorecards" ]]; then
        local missing
        missing=$(comm -23 <(find "$REPO_ROOT/scorecards" -maxdepth 1 -name '*.json' -printf '%f\n' | sed -E 's/-v[^/]+\.json$//' | sort -u) \
                       <(ls "$REPO_ROOT/dist/badge" | sed -E 's/\.svg$//' | sort -u) | head -10)
        if [[ -z "$missing" ]]; then
            gate_pass "badge SVGs cover every scorecard"
        else
            gate_fail "badge SVG coverage" "diff: $missing"
        fi
    else
        gate_skip "badge SVG coverage" "dist/badge or scorecards directory missing"
    fi

    # Markdown twin coverage.
    if [[ -d "$REPO_ROOT/dist" ]]; then
        local twin_diff
        twin_diff=$(comm -23 <(find "$REPO_ROOT/dist" -name '*.html' -not -path "$REPO_ROOT/dist/_internal/*" \
                            | sed -E 's/\.html$//' | sort) \
                        <(find "$REPO_ROOT/dist" -name '*.md' | sed -E 's/\.md$//' | sort) | head -10)
        if [[ -z "$twin_diff" ]]; then
            gate_pass "markdown twin exists for every emitted HTML page"
        else
            gate_fail "markdown twin coverage" "diff: $twin_diff"
        fi
    else
        gate_skip "markdown twin coverage" "dist not present"
    fi
}

# Resolve a do-smoke binary name to the GitHub owner/repo the live scorer
# fetches. The binary name drives the registry-membership precheck and the
# share_url assertion; the owner/repo is the resolvable source. Names with no
# mapped repo fall back to the sindresorhus namespace. A case statement keeps
# this portable to bash 3.2.
do_fixture_repo() {
    case "$1" in
        emoj)   echo "sindresorhus/emoj" ;;
        cowsay) echo "piuccio/cowsay" ;;
        *)      echo "sindresorhus/$1" ;;
    esac
}

# Gate: do-smoke (live-scoring DO against staging) --------------------------

gate_do_smoke() {
    header "Live-scoring DO smoke against $ENV_URL"
    require_bin curl; require_bin jq

    # Check the fresh binary is not already in the registry.
    if grep -E "^- name: ${BINARY}$" "$REPO_ROOT/registry.yaml" >/dev/null 2>&1; then
        gate_fail "fresh binary selection" "$BINARY is already in registry.yaml; pick another via --binary"
        return
    fi
    gate_pass "fresh non-registry binary $BINARY confirmed outside registry.yaml"

    # Local mode: reachability gate. wrangler dev must be running.
    if [[ "$ENV_AUTH_NEEDED" -eq 0 ]]; then
        if ! curl -fsSL -m 3 "${ENV_URL}/" >/dev/null 2>&1; then
            gate_skip "live-scoring DO smoke" \
                "local Worker not reachable at $ENV_URL — start with 'bunx wrangler dev --env staging --local'"
            return
        fi
    fi

    # Staging mode: stage CF Access headers. Local mode: empty cfg (curl -K
    # with an empty file is a no-op).
    local cfg
    cfg=$(mktemp)
    if [[ "$ENV_AUTH_NEEDED" -eq 1 ]]; then
        if ! stage_cf_access_headers "$cfg"; then
            gate_skip "live-scoring DO smoke" "could not stage CF Access service token from 1Password ($OP_ITEM_TOKEN)"
            rm -f "$cfg"
            return
        fi
    fi

    # POST a non-registry github-url and assess.
    local repo body
    repo=$(do_fixture_repo "$BINARY")
    body=$(curl -fsSL -K "$cfg" -H 'Content-Type: application/json' \
        -d "{\"input\":\"https://github.com/${repo}\",\"turnstile_token\":\"x\"}" \
        "${ENV_URL}/api/score" 2>/dev/null || true)
    rm -f "$cfg"

    if [[ -z "$body" ]]; then
        gate_fail "live-scoring DO smoke" "no response body (network, CF Access, or Worker down?)"
        return
    fi

    local ok binary_resp anc_v share_url err
    ok=$(printf '%s' "$body" | jq -r '.scorecard != null and .scorecard.tool.binary != null' 2>/dev/null || echo "false")
    binary_resp=$(printf '%s' "$body" | jq -r '.scorecard.tool.binary // empty' 2>/dev/null || true)
    anc_v=$(printf '%s' "$body" | jq -r '.anc_version // empty' 2>/dev/null || true)
    share_url=$(printf '%s' "$body" | jq -r '.share_url // empty' 2>/dev/null || true)
    err=$(printf '%s' "$body" | jq -r '.error.code // empty' 2>/dev/null || true)

    if [[ "$ok" == "true" && -n "$binary_resp" && -n "$anc_v" && "$share_url" == "/score/live/${binary_resp}" ]]; then
        gate_pass "$ENV /api/score returned scorecard for $binary_resp (anc $anc_v, share $share_url)"
    else
        gate_fail "$ENV /api/score response shape" \
            "ok=$ok binary=$binary_resp anc=$anc_v share=$share_url error=$err"
    fi
}

# Gate: mcp (live MCP against the --env target) -----------------------------

# Thin wrapper around scripts/release/mcp-smoke.sh, which holds the actual
# gate logic and is shared with postflight.sh. Target picked via $ENV.
#   - staging: mcp-smoke.sh reads CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET
#     from the env, which we stage from 1Password.
#   - local:   no auth; we verify $ENV_URL reachability before delegating.
gate_mcp() {
    require_bin curl

    if [[ "$ENV_AUTH_NEEDED" -eq 0 ]]; then
        if ! curl -fsSL -m 3 "${ENV_URL}/" >/dev/null 2>&1; then
            header "Live MCP surface against $ENV_URL"
            gate_skip "all MCP gates" \
                "local Worker not reachable at $ENV_URL — start with 'bunx wrangler dev --env staging --local'"
            return
        fi
        # mcp-smoke.sh prints its own section header; the local-Worker
        # reachability precheck is silent on success. --full-cache-coverage is
        # safe in local mode (the prod-host refusal rule in mcp-smoke.sh covers
        # anc.dev; localhost falls through).
        delegate_to_subscript "$REPO_ROOT/scripts/release/mcp-smoke.sh" "$ENV_URL" \
            --mcp-binary "$MCP_BINARY" --full-cache-coverage
        return
    fi

    # Staging: stage CF Access from 1Password and delegate.
    local cid csec
    cid=$(read_op_field "$OP_ITEM_TOKEN" client_id) || true
    csec=$(read_op_field "$OP_ITEM_TOKEN" client_secret) || true
    if [[ -z "$cid" || -z "$csec" ]]; then
        header "Live MCP surface against $ENV_URL"
        gate_skip "all MCP gates" \
            "could not stage CF Access service token from 1Password ($OP_ITEM_TOKEN)"
        return
    fi
    export CF_ACCESS_CLIENT_ID="$cid"
    export CF_ACCESS_CLIENT_SECRET="$csec"

    # Staging is the canonical release-smoke surface; --full-cache-coverage
    # ensures the live container DO path is exercised every run instead of
    # silently passing on a live-cache short-circuit.
    delegate_to_subscript "$REPO_ROOT/scripts/release/mcp-smoke.sh" "$ENV_URL" \
        --mcp-binary "$MCP_BINARY" --full-cache-coverage
}

# Gate: dist (distribution surfaces against staging) ------------------------

gate_dist() {
    header "Distribution surfaces against $ENV_URL"
    require_bin curl; require_bin jq

    # Local mode: reachability gate. wrangler dev must be running.
    if [[ "$ENV_AUTH_NEEDED" -eq 0 ]]; then
        if ! curl -fsSL -m 3 "${ENV_URL}/" >/dev/null 2>&1; then
            gate_skip "distribution surfaces" \
                "local Worker not reachable at $ENV_URL — start with 'bunx wrangler dev --env staging --local'"
            return
        fi
    fi

    local cfg
    cfg=$(mktemp)
    if [[ "$ENV_AUTH_NEEDED" -eq 1 ]]; then
        if ! stage_cf_access_headers "$cfg"; then
            gate_skip "all dist gates" "could not stage CF Access service token from 1Password"
            rm -f "$cfg"
            return
        fi
    fi

    # /check -> /audit redirect.
    local check_loc
    check_loc=$(curl -sSI -K "$cfg" "${ENV_URL}/check" 2>/dev/null \
        | grep -i '^location:' | head -1 | sed -E 's/^[Ll]ocation: *//' | tr -d '\r' || true)
    if [[ "$check_loc" == "/audit" || "$check_loc" == "${ENV_URL}/audit" ]]; then
        gate_pass "/check -> /audit 301 redirect serves"
    else
        gate_fail "/check -> /audit 301 redirect" "location=$check_loc"
    fi

    # Skill manifest version matches source.
    local served_v src_v
    served_v=$(curl -fsSL -K "$cfg" "${ENV_URL}/skill.json" 2>/dev/null \
        | jq -r '.version // empty' 2>/dev/null || true)
    src_v=$(jq -r '.version' "$REPO_ROOT/src/data/skill/skill.json" 2>/dev/null || true)
    if [[ -n "$served_v" && "$served_v" == "$src_v" ]]; then
        gate_pass "skill.json served version ($served_v) matches source"
    elif [[ -n "$served_v" && -n "$src_v" ]]; then
        gate_fail "skill.json served vs source" "served=$served_v source=$src_v (cache may need purge)"
    else
        gate_skip "skill.json served vs source" "could not read one (served=$served_v source=$src_v)"
    fi

    # X-Robots-Tag: noindex check. Staging-only: the staging-host guard in
    # src/worker/headers.ts matches *.workers.dev hostnames, which a local
    # wrangler dev (host=localhost) does not.
    if [[ "$ENV_AUTH_NEEDED" -eq 1 ]]; then
        local robots
        robots=$(curl -sSI -K "$cfg" "${ENV_URL}/" 2>/dev/null \
            | grep -i '^x-robots-tag:' | head -1 || true)
        if [[ "$robots" == *"noindex"* ]]; then
            gate_pass "staging Worker emits X-Robots-Tag: noindex on /"
        else
            gate_fail "staging X-Robots-Tag noindex" "header missing or wrong: $robots"
        fi
    else
        gate_skip "X-Robots-Tag noindex check" \
            "local mode — the staging-host guard does not fire for localhost"
    fi

    rm -f "$cfg"
}

# Gate: mechanics (release mechanics sanity) --------------------------------

gate_mechanics() {
    header "Release mechanics sanity"
    require_bin git

    # Leak check: no guarded paths in cherry-picked diff vs main.
    local leaked
    leaked=$(git diff origin/main..HEAD --name-only 2>/dev/null \
        | grep -E '^(docs/plans|docs/brainstorms|docs/ideation|docs/reviews|docs/solutions|\.context)' || true)
    if [[ -z "$leaked" ]]; then
        gate_pass "no guarded paths leaked into cherry-picked diff"
    else
        gate_fail "guarded paths leaked" "$leaked"
    fi

    # Triple-diff sanity vs origin/main + origin/dev.
    if git rev-parse --verify origin/dev >/dev/null 2>&1 \
       && git rev-parse --verify origin/main >/dev/null 2>&1; then
        local missed
        missed=$(git diff HEAD..origin/dev --name-only 2>/dev/null | grep -v '^docs/' || true)
        if [[ -z "$missed" ]]; then
            gate_pass "diff-B: no missed picks vs origin/dev (docs excluded)"
        else
            gate_skip "diff-B" "files present on dev but not on this branch (review): $(echo "$missed" | head -3 | tr '\n' ' ')"
        fi
    else
        gate_skip "triple-diff" "origin/main or origin/dev not fetched"
    fi
}

# Main dispatcher ------------------------------------------------------------

case "$SUBCMD" in
    coord)     gate_coord;;
    build)     gate_build;;
    do-smoke)  gate_do_smoke;;
    mcp)       gate_mcp;;
    dist)      gate_dist;;
    mechanics) gate_mechanics;;
    all)
        gate_coord
        gate_build
        gate_do_smoke
        gate_mcp
        gate_dist
        gate_mechanics
        ;;
esac

print_summary

[[ $FAIL_COUNT -eq 0 ]] || exit 1
