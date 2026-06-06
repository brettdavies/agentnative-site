#!/usr/bin/env bash
# Verify a freshly-deployed environment (staging OR prod) landed cleanly.
#
# Usage:
#   scripts/release-postflight.sh [--env staging|prod] <subcommand>
#
# Two environments to verify per release cycle:
#   - staging: deploys on every push to `dev` (per `.github/workflows/deploy.yml`).
#     Run `--env staging` once dev is at the soak state for the release.
#   - prod: deploys on every release/<YYYY-MM-DD>-<slug> -> main merge. Run
#     `--env prod` after the merge fires deploy.yml at main.
#
# Same suite of gates against both environments. Differences the script handles
# transparently:
#   - URL: staging Worker (workers.dev) vs anc.dev custom domain.
#   - Branch the deploy gate watches: dev (staging deploy) vs main (prod deploy).
#   - Container app name: agentnative-site-staging-sandbox vs agentnative-site-sandbox.
#   - Auth: staging is gated by CF Access (service token read from 1Password);
#     prod is unauthenticated.
#   - Backport gate runs only against `--env prod` (the main -> dev backport
#     concept does not apply to staging, which deploys directly from dev).
#
# Subcommands:
#   deploy     deploy.yml on the env's branch (dev for staging, main for prod):
#              conclusion=success
#   container  Env container app state is `ready`
#   pages      `<env-url>/`, `/scorecards`, `/api/score` registry-hit all return
#              expected
#   mcp        Live MCP suite (transport + symmetry + live audit) via
#              scripts/mcp-smoke.sh against the env URL
#   purge      `/skill.json` served version matches src/data/skill/skill.json
#   backport   Merged PR to dev with the release slug in its title (prod only;
#              SKIPped on staging)
#   all        Run every above sequentially.
#
# The production live-DO smoke against a non-registry binary is NOT driven from
# this script. Production binds the real Turnstile site key + secret (staging
# uses CF's always-pass test pair), so the scripted /api/score recipe returns
# turnstile_failed against anc.dev. Manual browser path is the only option until
# the service-token bypass ships per docs/plans/2026-06-01-003-feat-production-
# live-do-smoke-bypass-plan.md. The doc carries the manual recipe.
#
# Flags:
#   --env staging|prod       Target environment (default: prod)
#   --repo OWNER/REPO        Override the auto-detected nameWithOwner
#   --release-slug <slug>    Override auto-detection for the backport gate
#                            (default: parse the most recent merged release/* PR title)
#   --mcp-binary <binary>    Fresh non-registry binary for the live MCP audit
#                            (default: $MCP_BINARY env var or `figlet`)
#   --staging-url <url>      Override the staging URL
#   --prod-url <url>         Override the prod URL
#
# Exit codes:
#   0 = all gates passed (or skipped with reason)
#   1 = one or more gates failed
#   2 = setup error (missing required dependency, unauthenticated gh, etc.)
#
# Dependencies:
#   - gh, jaq, jq, curl, git on PATH
#   - bunx (for `wrangler containers list`)
#   - ~/.claude/skills/1password/scripts/read_field.sh (for staging CF Access token)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
readonly REPO_ROOT
readonly OP_SKILL="$HOME/.claude/skills/1password/scripts"
readonly OP_ITEM_TOKEN="Cloudflare Access Service Token - agentnative-site-staging"
readonly DEFAULT_STAGING_URL="https://agentnative-site-staging.brettdavies.workers.dev"
readonly DEFAULT_PROD_URL="https://anc.dev"

# Shared output helpers, gate counters, dependency checks ------------------

. "$REPO_ROOT/scripts/_release-lib.sh"

# Argument parsing -----------------------------------------------------------

ENV="prod"
REPO=""
RELEASE_SLUG=""
MCP_BINARY="${MCP_BINARY:-figlet}"
STAGING_URL="$DEFAULT_STAGING_URL"
PROD_URL="$DEFAULT_PROD_URL"
SUBCMD=""

usage() {
    sed -n '2,63p' "$0" | sed 's/^# \?//'
    exit 2
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --env)           ENV="$2"; shift 2;;
        --repo)          REPO="$2"; shift 2;;
        --release-slug)  RELEASE_SLUG="$2"; shift 2;;
        --mcp-binary)    MCP_BINARY="$2"; shift 2;;
        --staging-url)   STAGING_URL="$2"; shift 2;;
        --prod-url)      PROD_URL="$2"; shift 2;;
        -h|--help)       usage;;
        deploy|container|pages|mcp|purge|backport|all) SUBCMD="$1"; shift;;
        *) echo "unknown arg: $1" >&2; usage;;
    esac
done

[[ -n "$SUBCMD" ]] || usage

# Env resolution -------------------------------------------------------------

case "$ENV" in
    staging)
        ENV_URL="$STAGING_URL"
        ENV_BRANCH="dev"
        ENV_CONTAINER="agentnative-site-staging-sandbox"
        ENV_LABEL="staging"
        ENV_AUTH_NEEDED=1
        ;;
    prod)
        ENV_URL="$PROD_URL"
        ENV_BRANCH="main"
        ENV_CONTAINER="agentnative-site-sandbox"
        ENV_LABEL="prod"
        ENV_AUTH_NEEDED=0
        ;;
    *) echo "--env must be 'staging' or 'prod', got: $ENV" >&2; exit 2;;
esac

# Auth setup (staging only). Reads the CF Access service token from 1Password
# and exports CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET into the env. Every
# curl below uses `-K "$CF_CONFIG"`; mcp-smoke.sh picks up the same env vars
# directly. Values never reach argv: shell-builtin printf into a mode-600 file
# consumed via curl's -K flag.

CF_CONFIG=""
maybe_stage_cf_access() {
    [[ "$ENV_AUTH_NEEDED" -eq 1 ]] || return 0
    [[ -x "$OP_SKILL/read_field.sh" ]] || {
        echo "warn: 1Password skill not found at $OP_SKILL; staging gates that need CF Access will SKIP" >&2
        return 0
    }
    local cid csec
    cid=$("$OP_SKILL/read_field.sh" "$OP_ITEM_TOKEN" client_id 2>/dev/null) || return 0
    csec=$("$OP_SKILL/read_field.sh" "$OP_ITEM_TOKEN" client_secret 2>/dev/null) || return 0
    [[ -n "$cid" && -n "$csec" ]] || return 0

    export CF_ACCESS_CLIENT_ID="$cid"
    export CF_ACCESS_CLIENT_SECRET="$csec"

    CF_CONFIG=$(mktemp)
    chmod 600 "$CF_CONFIG"
    trap 'rm -f "$CF_CONFIG"' EXIT
    printf 'header = "CF-Access-Client-Id: %s"\n' "$cid" >> "$CF_CONFIG"
    printf 'header = "CF-Access-Client-Secret: %s"\n' "$csec" >> "$CF_CONFIG"
}

# Curl wrapper that attaches CF Access headers when staging.
ecurl() {
    if [[ -n "$CF_CONFIG" ]]; then
        curl -K "$CF_CONFIG" "$@"
    else
        curl "$@"
    fi
}

# Common helpers ------------------------------------------------------------

resolve_repo() {
    [[ -n "$REPO" ]] && { echo "$REPO"; return; }
    gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null \
        || { echo "could not resolve repo (pass --repo OWNER/REPO)" >&2; exit 2; }
}

resolve_release_slug() {
    if [[ -n "$RELEASE_SLUG" ]]; then
        echo "$RELEASE_SLUG"; return
    fi
    local repo
    repo=$(resolve_repo)
    gh pr list --repo "$repo" --base main --state merged --limit 10 \
        --json title --jq '[.[] | select(.title | test("^release/"))][0].title' 2>/dev/null \
        | sed -E 's|^release/([^ "]+).*|\1|' \
        || true
}

# Gate: deploy ---------------------------------------------------------------

gate_deploy() {
    header "$ENV_LABEL deploy (deploy.yml on $ENV_BRANCH push)"
    require_bin gh; require_bin jaq
    local repo run
    repo=$(resolve_repo)

    run=$(gh run list --repo "$repo" --branch "$ENV_BRANCH" --workflow deploy.yml --limit 1 \
        --json databaseId,status,conclusion,event --jq '.[0]' 2>/dev/null || true)
    if [[ -z "$run" || "$run" == "null" ]]; then
        gate_skip "deploy.yml run on $ENV_BRANCH" "no run found (deploy may not have triggered yet)"
        return
    fi

    local status conclusion run_id event
    status=$(printf '%s' "$run" | jaq -r .status)
    conclusion=$(printf '%s' "$run" | jaq -r .conclusion)
    run_id=$(printf '%s' "$run" | jaq -r .databaseId)
    event=$(printf '%s' "$run" | jaq -r .event)

    if [[ "$status" != "completed" ]]; then
        gate_skip "deploy.yml run $run_id" "status=$status event=$event (still running)"
        return
    fi
    if [[ "$conclusion" == "success" ]]; then
        gate_pass "deploy.yml run $run_id (event=$event) on $ENV_BRANCH conclusion=success"
    else
        gate_fail "deploy.yml run $run_id (event=$event) on $ENV_BRANCH" \
            "conclusion=$conclusion (see gh run view $run_id --log-failed)"
    fi
}

# Gate: container ------------------------------------------------------------

gate_container() {
    header "$ENV_LABEL container app ready state ($ENV_CONTAINER)"
    if ! have_bin bunx; then
        gate_skip "container app state" "bunx not on PATH"
        return
    fi

    local row state
    row=$(bunx wrangler containers list 2>/dev/null | grep -E "${ENV_CONTAINER}(\s|$)" | head -1 || true)
    if [[ -z "$row" ]]; then
        gate_skip "$ENV_CONTAINER" "not visible in 'wrangler containers list'"
        return
    fi

    state=$(echo "$row" | awk '{for(i=1;i<=NF;i++) if($i ~ /^(ready|provisioning|stopped|error)$/) print $i}' | head -1)
    if [[ "$state" == "ready" ]]; then
        gate_pass "$ENV_CONTAINER state=ready (safe to smoke live path)"
    elif [[ -n "$state" ]]; then
        gate_fail "$ENV_CONTAINER state" "state=$state (loop until ready)"
    else
        gate_skip "$ENV_CONTAINER state" "could not parse state from: $row"
    fi
}

# Gate: pages ----------------------------------------------------------------

gate_pages() {
    header "Distribution surface against $ENV_URL"
    require_bin curl; require_bin jq

    if ecurl -fSsL -m 10 "${ENV_URL}/" 2>/dev/null | grep -q '<title>'; then
        gate_pass "${ENV_URL}/ home page renders (has <title>)"
    else
        gate_fail "${ENV_URL}/ home page" "did not return HTML with <title>"
    fi

    if ecurl -fSsL -m 10 "${ENV_URL}/scorecards" 2>/dev/null | grep -q 'leaderboard-table'; then
        gate_pass "${ENV_URL}/scorecards renders (has leaderboard-table)"
    else
        gate_fail "${ENV_URL}/scorecards" "did not return HTML with leaderboard-table"
    fi

    local body kind anc_v spec_v
    body=$(ecurl -fSsL -m 10 "${ENV_URL}/api/score" -X POST \
        -H 'Content-Type: application/json' \
        -d '{"input":"ripgrep","turnstile_token":"x"}' 2>/dev/null || true)
    kind=$(printf '%s' "$body" | jq -r '.scorecard.kind // empty' 2>/dev/null || true)
    anc_v=$(printf '%s' "$body" | jq -r '.anc_version // empty' 2>/dev/null || true)
    spec_v=$(printf '%s' "$body" | jq -r '.spec_version // empty' 2>/dev/null || true)
    if [[ "$kind" == "registry_hit" && -n "$anc_v" && -n "$spec_v" ]]; then
        gate_pass "${ENV_URL}/api/score registry-hit returns kind=registry_hit, anc=$anc_v, spec=$spec_v"
    else
        gate_fail "${ENV_URL}/api/score registry-hit" "kind=$kind anc=$anc_v spec=$spec_v"
    fi
}

# Gate: mcp -----------------------------------------------------------------
# Thin wrapper around scripts/mcp-smoke.sh. mcp-smoke.sh reads CF_ACCESS_CLIENT_ID
# / CF_ACCESS_CLIENT_SECRET from the env, which maybe_stage_cf_access exported
# above when --env staging.

gate_mcp() {
    header "Live MCP surface against ${ENV_URL}/mcp"
    delegate_to_subscript "$REPO_ROOT/scripts/mcp-smoke.sh" "$ENV_URL" --mcp-binary "$MCP_BINARY"
}

# Gate: purge ----------------------------------------------------------------

gate_purge() {
    header "Skill manifest cache-purge confirmation"
    require_bin curl; require_bin jq

    local served_v src_v
    served_v=$(ecurl -fsSL -m 10 "${ENV_URL}/skill.json" 2>/dev/null \
        | jq -r '.version // empty' 2>/dev/null || true)
    src_v=$(jq -r '.version' "$REPO_ROOT/src/data/skill/skill.json" 2>/dev/null || true)
    if [[ -z "$served_v" || -z "$src_v" ]]; then
        gate_skip "skill.json served vs source" "could not read one (served=$served_v source=$src_v)"
        return
    fi
    if [[ "$served_v" == "$src_v" ]]; then
        gate_pass "${ENV_URL}/skill.json version $served_v matches src/data/skill/skill.json"
    else
        gate_fail "${ENV_URL}/skill.json version drift" \
            "served=$served_v source=$src_v (purge edge cache: RELEASES.md § Skill releases step 5)"
    fi
}

# Gate: backport (prod only) -------------------------------------------------

gate_backport() {
    if [[ "$ENV_LABEL" != "prod" ]]; then
        header "main -> dev backport"
        gate_skip "main -> dev backport" "prod-only (staging deploys from dev directly; no backport concept)"
        return
    fi
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
            "no PR titled '*$slug*' merged to dev (see RELEASES-POSTFLIGHT.md § backport)"
    fi
}

# Main dispatcher ------------------------------------------------------------

maybe_stage_cf_access

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
