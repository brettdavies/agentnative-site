#!/usr/bin/env bash
# Verify the release/* -> main merge's production deploy landed cleanly.
#
# Usage:
#   scripts/release-postflight.sh <subcommand>
#
# Runs AFTER the release/<YYYY-MM-DD>-<slug> PR merges to main and deploy.yml fires
# automatically per RELEASES.md § Releasing dev to main. Companion to
# scripts/release-preflight.sh which gates the release-branch cut.
#
# Subcommands:
#   deploy     deploy.yml on the main push: conclusion=success
#   container  Prod container app (agentnative-site-sandbox) state is `ready`
#   pages      anc.dev/, /scorecards, /api/score registry-hit all return expected
#   mcp        anc.dev/mcp initialize + tools/list + symmetry contract + live audit
#   purge      /skill.json served version matches src/data/skill/skill.json source
#   backport   Merged PR to dev with the release slug in its title
#   all        Run every above sequentially.
#
# The production live-DO smoke against a non-registry binary is NOT driven from this
# script. Production binds the real Turnstile site key + secret (staging uses CF's
# always-pass test pair), so the scripted /api/score recipe returns turnstile_failed
# against anc.dev. Manual browser path is the only option until the service-token
# bypass ships per docs/plans/2026-06-01-003-feat-production-live-do-smoke-bypass-plan.md.
# The doc's checklist carries the manual recipe.
#
# Flags:
#   --repo OWNER/REPO        Override the auto-detected nameWithOwner
#   --release-slug <slug>    Override auto-detection (default: parse the most recent
#                            merged release/* PR title)
#   --mcp-binary <binary>    Fresh non-registry binary for the live MCP audit
#                            (default: $MCP_BINARY or `figlet` — re-use the same one
#                            preflight used so the two suites symmetrically exercise
#                            both surfaces against the same input)
#   --prod-url <url>         Override prod URL (default: https://anc.dev)
#
# Exit codes:
#   0 = all gates passed (or skipped with reason)
#   1 = one or more gates failed
#   2 = setup error (missing required dependency, unauthenticated gh, etc.)
#
# Dependencies:
#   - gh, jaq, jq, curl, git on PATH
#   - bunx (for `wrangler containers list`)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
readonly REPO_ROOT
readonly DEFAULT_PROD_URL="https://anc.dev"

# Shared output helpers, gate counters, dependency checks ------------------

. "$REPO_ROOT/scripts/_release-lib.sh"

# Argument parsing -----------------------------------------------------------

REPO=""
RELEASE_SLUG=""
MCP_BINARY="${MCP_BINARY:-figlet}"
PROD_URL="$DEFAULT_PROD_URL"
SUBCMD=""

usage() {
    sed -n '2,46p' "$0" | sed 's/^# \?//'
    exit 2
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --repo)          REPO="$2"; shift 2;;
        --release-slug)  RELEASE_SLUG="$2"; shift 2;;
        --mcp-binary)    MCP_BINARY="$2"; shift 2;;
        --prod-url)      PROD_URL="$2"; shift 2;;
        -h|--help)       usage;;
        deploy|container|pages|mcp|purge|backport|all) SUBCMD="$1"; shift;;
        *) echo "unknown arg: $1" >&2; usage;;
    esac
done

[[ -n "$SUBCMD" ]] || usage

resolve_repo() {
    [[ -n "$REPO" ]] && { echo "$REPO"; return; }
    gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null \
        || { echo "could not resolve repo (pass --repo OWNER/REPO)" >&2; exit 2; }
}

resolve_release_slug() {
    if [[ -n "$RELEASE_SLUG" ]]; then
        echo "$RELEASE_SLUG"; return
    fi
    # Auto-detect: most recent merged PR with title starting "release/"
    local repo
    repo=$(resolve_repo)
    gh pr list --repo "$repo" --base main --state merged --limit 10 \
        --json title --jq '[.[] | select(.title | test("^release/"))][0].title' 2>/dev/null \
        | sed -E 's|^release/([^ "]+).*|\1|' \
        || true
}

# Gate: deploy (deploy.yml on main push) -------------------------------------

gate_deploy() {
    header "Production deploy (deploy.yml on main push)"
    require_bin gh; require_bin jaq
    local repo run
    repo=$(resolve_repo)

    # Most recent deploy.yml run on main.
    run=$(gh run list --repo "$repo" --branch main --workflow deploy.yml --limit 1 \
        --json databaseId,status,conclusion,event --jq '.[0]' 2>/dev/null || true)
    if [[ -z "$run" || "$run" == "null" ]]; then
        gate_skip "deploy.yml run on main" "no run found (release merge may not have triggered deploy yet)"
        return
    fi

    local status conclusion run_id event
    status=$(printf '%s' "$run" | jaq -r .status)
    conclusion=$(printf '%s' "$run" | jaq -r .conclusion)
    run_id=$(printf '%s' "$run" | jaq -r .databaseId)
    event=$(printf '%s' "$run" | jaq -r .event)

    if [[ "$status" != "completed" ]]; then
        gate_skip "deploy.yml run $run_id" "status=$status event=$event (still running; re-run after watcher exits)"
        return
    fi
    if [[ "$conclusion" == "success" ]]; then
        gate_pass "deploy.yml run $run_id (event=$event) conclusion=success"
    else
        gate_fail "deploy.yml run $run_id (event=$event)" "conclusion=$conclusion (see gh run view $run_id --log-failed)"
    fi
}

# Gate: container (prod container app ready) ---------------------------------

gate_container() {
    header "Production container app ready state"
    if ! have_bin bunx; then
        gate_skip "container app state" "bunx not on PATH"
        return
    fi

    # Looking for `agentnative-site-sandbox` (prod) not `agentnative-site-staging-sandbox`.
    local row state
    row=$(bunx wrangler containers list 2>/dev/null \
        | grep -E 'agentnative-site-sandbox(\s|$)' \
        | grep -v staging \
        | head -1 || true)
    if [[ -z "$row" ]]; then
        gate_skip "prod container app" "agentnative-site-sandbox not visible in 'wrangler containers list' (no containers in this env?)"
        return
    fi

    # Extract the STATE column heuristically — wrangler's table format varies.
    state=$(echo "$row" | awk '{for(i=1;i<=NF;i++) if($i ~ /^(ready|provisioning|stopped|error)$/) print $i}' | head -1)
    if [[ "$state" == "ready" ]]; then
        gate_pass "prod container app state=ready (safe to smoke live path)"
    elif [[ -n "$state" ]]; then
        gate_fail "prod container app state" "state=$state (loop until ready; smokes during rollout land on OLD-image instances)"
    else
        gate_skip "prod container app state" "could not parse state from: $row"
    fi
}

# Gate: pages (anc.dev distribution surface) ---------------------------------

gate_pages() {
    header "Distribution surface against anc.dev"
    require_bin curl; require_bin jq

    # Home page renders.
    if curl -fSsL -m 10 "${PROD_URL}/" 2>/dev/null | grep -q '<title>'; then
        gate_pass "${PROD_URL}/ home page renders (has <title>)"
    else
        gate_fail "${PROD_URL}/ home page" "did not return HTML with <title>"
    fi

    # Leaderboard renders.
    if curl -fSsL -m 10 "${PROD_URL}/scorecards" 2>/dev/null | grep -q 'leaderboard-table'; then
        gate_pass "${PROD_URL}/scorecards renders (has leaderboard-table)"
    else
        gate_fail "${PROD_URL}/scorecards" "did not return HTML with leaderboard-table"
    fi

    # Registry-hit /api/score returns the expected triad.
    local body kind anc_v spec_v
    body=$(curl -fSsL -m 10 "${PROD_URL}/api/score" -X POST \
        -H 'Content-Type: application/json' \
        -d '{"input":"ripgrep","turnstile_token":"x"}' 2>/dev/null || true)
    kind=$(printf '%s' "$body" | jq -r '.scorecard.kind // empty' 2>/dev/null || true)
    anc_v=$(printf '%s' "$body" | jq -r '.anc_version // empty' 2>/dev/null || true)
    spec_v=$(printf '%s' "$body" | jq -r '.spec_version // empty' 2>/dev/null || true)
    if [[ "$kind" == "registry_hit" && -n "$anc_v" && -n "$spec_v" ]]; then
        gate_pass "${PROD_URL}/api/score registry-hit returns kind=registry_hit, anc=$anc_v, spec=$spec_v"
    else
        gate_fail "${PROD_URL}/api/score registry-hit" "kind=$kind anc=$anc_v spec=$spec_v"
    fi
}

# Gate: mcp (anc.dev MCP suite) ----------------------------------------------

# Thin wrapper around scripts/mcp-smoke.sh, which holds the actual gate logic and
# is shared with release-preflight.sh. Only difference between this caller and
# preflight is the base URL the suite runs against.
gate_mcp() {
    header "Live MCP surface against ${PROD_URL}/mcp"
    delegate_to_subscript "$REPO_ROOT/scripts/mcp-smoke.sh" "$PROD_URL" --mcp-binary "$MCP_BINARY"
}

# Gate: purge (skill.json served vs source) ----------------------------------

gate_purge() {
    header "Skill manifest cache-purge confirmation"
    require_bin curl; require_bin jq

    local served_v src_v
    served_v=$(curl -fsSL -m 10 "${PROD_URL}/skill.json" 2>/dev/null \
        | jq -r '.version // empty' 2>/dev/null || true)
    src_v=$(jq -r '.version' "$REPO_ROOT/src/data/skill/skill.json" 2>/dev/null || true)
    if [[ -z "$served_v" || -z "$src_v" ]]; then
        gate_skip "skill.json served vs source" "could not read one (served=$served_v source=$src_v)"
        return
    fi
    if [[ "$served_v" == "$src_v" ]]; then
        gate_pass "${PROD_URL}/skill.json version $served_v matches src/data/skill/skill.json"
    else
        gate_fail "${PROD_URL}/skill.json version drift" "served=$served_v source=$src_v (purge edge cache: RELEASES.md § Skill releases step 5)"
    fi
}

# Gate: backport (main -> dev backport PR signal) ----------------------------

gate_backport() {
    header "main -> dev backport"
    require_bin gh; require_bin jaq
    local repo slug
    repo=$(resolve_repo)
    slug=$(resolve_release_slug)

    if [[ -z "$slug" ]]; then
        gate_skip "main -> dev backport" \
            "could not auto-detect release slug (pass --release-slug or merge a release/* PR first)"
        return
    fi

    # Look for a merged PR to dev with the slug in the title. Mirror the xurl-rs
    # postflight approach: server-side search by token, then jaq-filter precisely
    # and pick the most recently merged.
    local pr
    pr=$(gh pr list --repo "$repo" --base dev --state merged --limit 20 \
        --search "$slug" \
        --json number,title,mergedAt,headRefName \
        --jq "[.[] | select(.title | test(\"$slug\"))] | sort_by(.mergedAt) | reverse | .[0]" \
        2>/dev/null || true)
    [[ "$pr" == "null" ]] && pr=""

    if [[ -n "$pr" ]]; then
        local pr_num pr_title pr_head
        pr_num=$(printf '%s' "$pr" | jaq -r .number)
        pr_title=$(printf '%s' "$pr" | jaq -r .title)
        pr_head=$(printf '%s' "$pr" | jaq -r .headRefName)
        gate_pass "backport PR #$pr_num merged to dev from $pr_head: $pr_title"
    else
        gate_skip "main -> dev backport" \
            "no PR titled '*$slug*' merged to dev — see RELEASES-POSTFLIGHT.md § backport"
    fi
}

# Main dispatcher ------------------------------------------------------------

case "$SUBCMD" in
    deploy)    gate_deploy;;
    container) gate_container;;
    pages)     gate_pages;;
    mcp)       gate_mcp;;
    purge)     gate_purge;;
    backport)  gate_backport;;
    all)
        gate_deploy
        gate_container
        gate_pages
        gate_mcp
        gate_purge
        gate_backport
        ;;
esac

print_summary

[[ $FAIL_COUNT -eq 0 ]] || exit 1
