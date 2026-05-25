#!/usr/bin/env bash
# cf-access-bootstrap.sh — idempotent Cloudflare Access setup for the staging Worker.
#
# What this script does, each step skipped if already present:
#
#   1. Creates the Self-Hosted Access application for the staging Worker URL.
#   2. Creates a CLI service token, capturing its client_id + client_secret
#      into 1Password (the secret is shown ONCE by Cloudflare).
#   3. Creates two policies on the app:
#        a. "Allow brett email" — decision allow, includes a specific email.
#        b. "Allow CLI service token" — decision non_identity, includes the
#           service token id from step 2.
#   4. Verifies the boundary works: unauth request to the protected URL must
#      return a 302 redirect to *.cloudflareaccess.com; authed request with
#      the service token headers must return 200.
#
# Resources are matched by NAME (not ID), so the script is safe to re-run.
# If everything is already in place, every step reports "exists, skipping".
#
# Disaster recovery: if the CF account is restored from backup or the
# Access app is deleted, re-running this script reconstructs the staging
# auth surface from 1Password-resident credentials. The 1Password item
# `Cloudflare API Token - Access Setup (agentnative-site)` is the only
# operator-side prerequisite.
#
# Inputs (env vars; defaults below):
#
#   CF_ACCOUNT_ID         Cloudflare account ID. REQUIRED.
#   APP_NAME              Access app name (default: "agentnative-site staging")
#   APP_DOMAIN            Protected URL (default: agentnative-site-staging.brettdavies.workers.dev)
#   APP_SESSION           session_duration (default: 2160h, 90 days)
#   IDENTITY_EMAIL        Email allowed by the identity policy (default: davies.brett@gmail.com)
#   SERVICE_TOKEN_NAME    Service token name (default: agentnative-site-staging-cli)
#   SERVICE_TOKEN_DURATION CF duration string (default: 8760h, 1 year — the CF max non-forever)
#   OP_ITEM_API_TOKEN     1Password title for the setup API token
#                         (default: "Cloudflare API Token - Access Setup (agentnative-site)")
#   OP_ITEM_SERVICE_TOKEN 1Password title for the service token credentials
#                         (default: "Cloudflare Access Service Token - agentnative-site-staging")
#
# Dependencies: curl, jaq (preferred) or jq, op CLI via the
# ~/.claude/skills/1password/scripts/ helpers.

set -u

# ---------------------------------------------------------------------------
# Inputs
# ---------------------------------------------------------------------------

CF_ACCOUNT_ID="${CF_ACCOUNT_ID:-}"
APP_NAME="${APP_NAME:-agentnative-site staging}"
APP_DOMAIN="${APP_DOMAIN:-agentnative-site-staging.brettdavies.workers.dev}"
APP_SESSION="${APP_SESSION:-2160h}"
IDENTITY_EMAIL="${IDENTITY_EMAIL:-davies.brett@gmail.com}"
SERVICE_TOKEN_NAME="${SERVICE_TOKEN_NAME:-agentnative-site-staging-cli}"
SERVICE_TOKEN_DURATION="${SERVICE_TOKEN_DURATION:-8760h}"
OP_ITEM_API_TOKEN="${OP_ITEM_API_TOKEN:-Cloudflare API Token - Access Setup (agentnative-site)}"
OP_ITEM_SERVICE_TOKEN="${OP_ITEM_SERVICE_TOKEN:-Cloudflare Access Service Token - agentnative-site-staging}"

OP_READ="${OP_READ:-$HOME/.claude/skills/1password/scripts/read_field.sh}"
OP_CREATE="${OP_CREATE:-$HOME/.claude/skills/1password/scripts/create_item.sh}"

JQ_BIN="$(command -v jaq || command -v jq || true)"

# ---------------------------------------------------------------------------
# Sanity checks
# ---------------------------------------------------------------------------

die() {
  printf 'FATAL: %s\n' "$1" >&2
  exit 2
}

[ -n "$CF_ACCOUNT_ID" ] || die "CF_ACCOUNT_ID env var is required (32-char hex)."
[ -n "$JQ_BIN" ] || die "neither jaq nor jq installed; install one (brew install jaq) and retry."
[ -x "$OP_READ" ] || die "1Password read helper not found at $OP_READ; install the 1password skill or export OP_READ."
[ -x "$OP_CREATE" ] || die "1Password create helper not found at $OP_CREATE."

API_TOKEN="$("$OP_READ" "$OP_ITEM_API_TOKEN" credential 2>/dev/null || true)"
[ -n "$API_TOKEN" ] || die "could not read API token from 1Password item '$OP_ITEM_API_TOKEN'. Verify the item exists with a field named 'credential'."

API_BASE="https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# cf_get PATH
cf_get() {
  curl -s -H "Authorization: Bearer $API_TOKEN" "$API_BASE$1"
}

# cf_post PATH BODY
cf_post() {
  curl -s -X POST -H "Authorization: Bearer $API_TOKEN" -H "Content-Type: application/json" \
    "$API_BASE$1" --data "$2"
}

# Report a one-liner table row.
row() {
  printf '  %-30s %s\n' "$1" "$2"
}

# ---------------------------------------------------------------------------
# Token sanity probe
# ---------------------------------------------------------------------------

printf '\n=== cf-access-bootstrap @ %s ===\n' "$APP_DOMAIN"
printf '    account_id=%s\n' "$CF_ACCOUNT_ID"
printf '    app_name=%s\n' "$APP_NAME"
printf '    session_duration=%s\n\n' "$APP_SESSION"

probe="$(cf_get "/access/apps")"
probe_success="$("$JQ_BIN" -r '.success' <<<"$probe")"
if [ "$probe_success" != "true" ]; then
  die "API token sanity check failed: $(echo "$probe" | "$JQ_BIN" -c '.errors')
       Verify the token has 'Access: Apps and Policies Write' AND 'Access: Service Tokens Write' permissions."
fi

# ---------------------------------------------------------------------------
# Step 1: Access application
# ---------------------------------------------------------------------------

printf '[1] Access application\n'
APP_ID="$(echo "$probe" | "$JQ_BIN" -r --arg name "$APP_NAME" '.result[] | select(.name == $name) | .id' | head -1)"

if [ -n "$APP_ID" ] && [ "$APP_ID" != "null" ]; then
  row "status" "exists, skipping creation"
  row "app_id" "$APP_ID"
  AUD="$(echo "$probe" | "$JQ_BIN" -r --arg name "$APP_NAME" '.result[] | select(.name == $name) | .aud' | head -1)"
  CURRENT_SESSION="$(echo "$probe" | "$JQ_BIN" -r --arg name "$APP_NAME" '.result[] | select(.name == $name) | .session_duration' | head -1)"
  row "aud" "$AUD"
  row "session_duration" "$CURRENT_SESSION"
  if [ "$CURRENT_SESSION" != "$APP_SESSION" ]; then
    row "session_duration drift" "current=$CURRENT_SESSION  desired=$APP_SESSION (re-run with manual PUT if you want this updated)"
  fi
else
  printf '  creating ...\n'
  create_body=$(cat <<EOF
{
  "name": "$APP_NAME",
  "type": "self_hosted",
  "domain": "$APP_DOMAIN",
  "session_duration": "$APP_SESSION",
  "auto_redirect_to_identity": false,
  "service_auth_401_redirect": false,
  "app_launcher_visible": false
}
EOF
)
  create_resp="$(cf_post "/access/apps" "$create_body")"
  create_success="$(echo "$create_resp" | "$JQ_BIN" -r '.success')"
  [ "$create_success" = "true" ] || die "app create failed: $(echo "$create_resp" | "$JQ_BIN" -c '.errors')"
  APP_ID="$(echo "$create_resp" | "$JQ_BIN" -r '.result.id')"
  AUD="$(echo "$create_resp" | "$JQ_BIN" -r '.result.aud')"
  row "status" "CREATED"
  row "app_id" "$APP_ID"
  row "aud" "$AUD"
fi

# ---------------------------------------------------------------------------
# Step 2: Service token
# ---------------------------------------------------------------------------

printf '\n[2] Service token\n'
tokens="$(cf_get "/access/service_tokens")"
SVC_TOKEN_ID="$(echo "$tokens" | "$JQ_BIN" -r --arg name "$SERVICE_TOKEN_NAME" '.result[] | select(.name == $name) | .id' | head -1)"

if [ -n "$SVC_TOKEN_ID" ] && [ "$SVC_TOKEN_ID" != "null" ]; then
  row "status" "exists, skipping creation"
  row "token_id" "$SVC_TOKEN_ID"
  # Sanity-check 1Password item is present so the smoke script will find it.
  if ! "$OP_READ" "$OP_ITEM_SERVICE_TOKEN" client_id >/dev/null 2>&1; then
    printf '  WARNING: service token "%s" exists in CF but 1Password item "%s" is missing.\n' "$SERVICE_TOKEN_NAME" "$OP_ITEM_SERVICE_TOKEN" >&2
    printf '           The CLI client_secret cannot be recovered. Rotate via:\n' >&2
    printf '             curl -s -X POST -H "Authorization: Bearer \$API_TOKEN" \\\n' >&2
    printf '               "%s/access/service_tokens/%s/rotate"\n' "$API_BASE" "$SVC_TOKEN_ID" >&2
    printf '           Then capture the new client_secret into 1Password.\n' >&2
  else
    row "1password" "item '$OP_ITEM_SERVICE_TOKEN' present (client_id readable)"
  fi
else
  printf '  creating ...\n'
  resp_dir="$(mktemp -d -t cf-svc-XXXXXXXX)"
  chmod 700 "$resp_dir"
  create_resp="$(cf_post "/access/service_tokens" "{\"name\": \"$SERVICE_TOKEN_NAME\", \"duration\": \"$SERVICE_TOKEN_DURATION\"}")"
  echo "$create_resp" > "$resp_dir/resp.json"
  chmod 600 "$resp_dir/resp.json"
  create_success="$("$JQ_BIN" -r '.success' "$resp_dir/resp.json")"
  if [ "$create_success" != "true" ]; then
    err="$("$JQ_BIN" -c '.errors' "$resp_dir/resp.json")"
    shred -uz "$resp_dir/resp.json" && rmdir "$resp_dir"
    die "service token create failed: $err"
  fi
  SVC_TOKEN_ID="$("$JQ_BIN" -r '.result.id' "$resp_dir/resp.json")"
  expires_at="$("$JQ_BIN" -r '.result.expires_at' "$resp_dir/resp.json")"
  expires_ts="$(date -u -d "$expires_at" +%s)"

  printf '  ingesting to 1Password (value never echoed) ...\n'
  notes="CF Access service token for the $APP_NAME Worker at $APP_DOMAIN. Auth via HTTP headers CF-Access-Client-Id and CF-Access-Client-Secret. Created $(date -u +%Y-%m-%d) by scripts/cf-access-bootstrap.sh; expires $expires_at. Rotate via the CF dashboard or POST to /access/service_tokens/$SVC_TOKEN_ID/rotate."
  "$OP_CREATE" \
    --title "$OP_ITEM_SERVICE_TOKEN" \
    --tags "cloudflare,access,service-token,agentnative-site,staging" \
    --notes "$notes" \
    --hostname "$APP_DOMAIN" \
    --field "username=$SERVICE_TOKEN_NAME" \
    --field "expires=$expires_ts" \
    --field "type=Service Token" \
    --field "client_id=$("$JQ_BIN" -r '.result.client_id' "$resp_dir/resp.json")" \
    --field "client_secret[concealed]=$("$JQ_BIN" -r '.result.client_secret' "$resp_dir/resp.json")" >/dev/null

  shred -uz "$resp_dir/resp.json" && rmdir "$resp_dir"
  row "status" "CREATED + ingested"
  row "token_id" "$SVC_TOKEN_ID"
  row "1password" "item '$OP_ITEM_SERVICE_TOKEN' created"
fi

# ---------------------------------------------------------------------------
# Step 3: Policies
# ---------------------------------------------------------------------------

printf '\n[3] Policies\n'
existing_policies="$(cf_get "/access/apps/$APP_ID/policies")"

ensure_policy() {
  local pname="$1" body="$2"
  local existing_id
  existing_id="$(echo "$existing_policies" | "$JQ_BIN" -r --arg name "$pname" '.result[] | select(.name == $name) | .id' | head -1)"
  if [ -n "$existing_id" ] && [ "$existing_id" != "null" ]; then
    row "$pname" "exists ($existing_id)"
    return
  fi
  local resp
  resp="$(cf_post "/access/apps/$APP_ID/policies" "$body")"
  local ok
  ok="$(echo "$resp" | "$JQ_BIN" -r '.success')"
  if [ "$ok" != "true" ]; then
    printf '  FAILED: %s\n' "$pname" >&2
    echo "$resp" | "$JQ_BIN" -c '.errors' >&2
    die "policy create failed (most common cause: API token missing 'Access: Apps and Policies Write' permission group)"
  fi
  row "$pname" "CREATED ($(echo "$resp" | "$JQ_BIN" -r '.result.id'))"
}

email_policy_body=$(cat <<EOF
{
  "name": "Allow brett email",
  "decision": "allow",
  "include": [{"email": {"email": "$IDENTITY_EMAIL"}}]
}
EOF
)
service_policy_body=$(cat <<EOF
{
  "name": "Allow CLI service token",
  "decision": "non_identity",
  "include": [{"service_token": {"token_id": "$SVC_TOKEN_ID"}}]
}
EOF
)
ensure_policy "Allow brett email" "$email_policy_body"
ensure_policy "Allow CLI service token" "$service_policy_body"

# ---------------------------------------------------------------------------
# Step 4: Verify
# ---------------------------------------------------------------------------

printf '\n[4] Verify\n'
unauth_status="$(curl -s -o /dev/null -w '%{http_code}' "https://$APP_DOMAIN/api/score?input=ripgrep")"
unauth_location="$(curl -s -o /dev/null -w '%{redirect_url}' "https://$APP_DOMAIN/api/score?input=ripgrep")"
if [ "$unauth_status" = "302" ] && echo "$unauth_location" | grep -q 'cloudflareaccess.com'; then
  row "unauth probe" "302 → cloudflareaccess.com (boundary enforced)"
else
  row "unauth probe" "UNEXPECTED status=$unauth_status (expected 302 to *.cloudflareaccess.com)"
fi

CLIENT_ID="$("$OP_READ" "$OP_ITEM_SERVICE_TOKEN" client_id)"
CLIENT_SECRET="$("$OP_READ" "$OP_ITEM_SERVICE_TOKEN" client_secret)"
authed_status="$(curl -s -o /dev/null -w '%{http_code}' \
  -H "CF-Access-Client-Id: $CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CLIENT_SECRET" \
  "https://$APP_DOMAIN/api/score?input=ripgrep")"
if [ "$authed_status" = "200" ]; then
  row "service-token probe" "200 (service token allowed by policy)"
else
  row "service-token probe" "UNEXPECTED status=$authed_status (expected 200)"
fi

printf '\n=== done ===\n'
