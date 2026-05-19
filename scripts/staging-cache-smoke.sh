#!/usr/bin/env bash
# staging-cache-smoke.sh — opt-in live cache smoke test for /api/score on staging.
#
# Plan U7 verification. NOT in the default test pipeline (bun test). Run on
# demand when you need confidence that the live staging cache tier is
# behaving as designed, or after any change to handler.ts / cache.ts / do.ts
# that touches the lookupScorecard or post-success cache-write path.
#
# Two modes:
#
#   ./scripts/staging-cache-smoke.sh
#       Warm + edge tests only. No sandbox spawns. Safe to run repeatedly.
#       Asserts validation gates, Turnstile semantics, method gate, curated
#       registry hit unmetered, and cache READS for binaries previously
#       written (cowsay is the canonical fixture, see HOW THE CACHE GETS
#       SEEDED below).
#
#   ./scripts/staging-cache-smoke.sh --cold
#       Adds three cold sandbox spawns. Runs cold-POST then warm-POST for
#       each of: `pip install black`, `cargo binstall ouch`, and the
#       hint-mapped github-url `https://github.com/Aider-AI/aider`.
#       Asserts cache WRITES (R2 object lands at the canonical key) AND
#       READS (second request hits the cache, sub-2s, same scorecard
#       payload). Each cold spawn burns ~5-20 s of staging container time;
#       use sparingly.
#
# HOW THE CACHE GETS SEEDED: U7 writes to SCORE_CACHE on every successful
# live score, so any prior --cold run (or production-style traffic from
# the homepage form once U8 ships) seeds the cache. The warm-mode tests
# assume `cowsay` is already cached — the very first U7 verification on
# 2026-05-19 wrote it. If it ages out via the 7-day R2 lifecycle, run
# `./scripts/staging-cache-smoke.sh --cold` to reseed.
#
# Turnstile bypass: staging's TURNSTILE_SECRET is bound to the Cloudflare
# always-passes test secret, so all POSTs in this script pass
# `turnstile_token: "x"`. See
# docs/solutions/tooling-decisions/cloudflare-staging-turnstile-test-secret-2026-05-19.md
# for the full pattern.
#
# Cloudflare Access (added 2026-05-19): the staging Worker URL is now
# gated by a CF Access Self-Hosted Application. CLI clients must send
# CF-Access-Client-Id + CF-Access-Client-Secret headers from a service
# token. This script reads them from 1Password by item title:
#   "Cloudflare Access Service Token - agentnative-site-staging"
# A missing service-token item OR a missing op CLI surfaces as an
# instant 302 redirect to `*.cloudflareaccess.com` on every request,
# which the harness reports as a clear FAIL rather than a confusing
# protocol-level error.
#
# Dependencies: curl, jaq (preferred) or jq, wrangler (bun x wrangler), date (GNU or BSD), op (1Password CLI).

set -u

STAGING_URL="${STAGING_URL:-https://agentnative-site-staging.brettdavies.workers.dev}"
STAGING_BUCKET="${STAGING_BUCKET:-anc-score-cache-staging}"
COLD=false
[ "${1:-}" = "--cold" ] && COLD=true

# Currently 0.4.0 — keep in lockstep with src/worker/spec-version.gen.ts.
SPEC_VERSION="${SPEC_VERSION:-0.4.0}"

# Prefer jaq (faster, drop-in jq replacement). Fall back to jq.
JQ_BIN="$(command -v jaq || command -v jq || true)"
if [ -z "$JQ_BIN" ]; then
  echo "FATAL: neither jaq nor jq is installed. Install one (brew install jaq) and retry." >&2
  exit 2
fi

# Fetch CF Access service token credentials from 1Password. The values
# never enter the script's logged output; they live in shell variables
# scoped to this process and are passed to curl via -H. The 1Password
# helper scripts default to the secrets-dev vault.
OP_ITEM="Cloudflare Access Service Token - agentnative-site-staging"
OP_READ="${OP_READ:-$HOME/.claude/skills/1password/scripts/read_field.sh}"
if [ ! -x "$OP_READ" ]; then
  echo "FATAL: 1Password helper not found at $OP_READ. Export OP_READ to point at it, or install the 1password skill." >&2
  exit 2
fi
CF_ACCESS_CLIENT_ID="$("$OP_READ" "$OP_ITEM" client_id 2>/dev/null || true)"
CF_ACCESS_CLIENT_SECRET="$("$OP_READ" "$OP_ITEM" client_secret 2>/dev/null || true)"
if [ -z "$CF_ACCESS_CLIENT_ID" ] || [ -z "$CF_ACCESS_CLIENT_SECRET" ]; then
  echo "FATAL: could not read CF Access service token from 1Password item '$OP_ITEM'." >&2
  echo "       Verify the item exists in vault 'secrets-dev' with fields 'client_id' and 'client_secret'." >&2
  echo "       Then re-run. Without these credentials every staging request returns 302 to *.cloudflareaccess.com." >&2
  exit 2
fi

# Curl helper that always carries the CF Access service-token headers.
# All HTTP calls below go through these so the Access boundary is
# transparent to the test logic.
ACCESS_HEADERS=(
  -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID"
  -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET"
)

PASS=0
FAIL=0
FAIL_LABELS=()

ok() {
  printf '  [pass] %s\n' "$1"
  PASS=$((PASS + 1))
}

ko() {
  printf '  [FAIL] %s — %s\n' "$1" "$2"
  FAIL=$((FAIL + 1))
  FAIL_LABELS+=("$1")
}

# Millisecond clock (Linux + macOS).
now_ms() {
  if date +%s%N >/dev/null 2>&1 && [ "$(date +%N)" != "N" ]; then
    echo $(($(date +%s%N) / 1000000))
  else
    # macOS without coreutils — fall back to perl.
    perl -MTime::HiRes=time -E 'say int(time() * 1000)'
  fi
}

# expect_status_post LABEL BODY EXPECTED_STATUS [QUERY_STRING]
expect_status_post() {
  local label=$1 body=$2 expected=$3 query=${4:-}
  local tmp
  tmp=$(mktemp)
  local code
  code=$(curl -s -o "$tmp" -w '%{http_code}' "${ACCESS_HEADERS[@]}" \
    -X POST -H 'content-type: application/json' \
    "$STAGING_URL/api/score$query" \
    --data "$body")
  if [ "$code" = "$expected" ]; then
    ok "$label (status=$code)"
  else
    ko "$label" "expected $expected, got $code: $(head -c 200 "$tmp")"
  fi
  rm -f "$tmp"
}

# expect_error_code LABEL BODY EXPECTED_HTTP_STATUS EXPECTED_ERROR_CODE [QUERY]
expect_error_code() {
  local label=$1 body=$2 expected_status=$3 expected_code=$4 query=${5:-}
  local tmp
  tmp=$(mktemp)
  local code
  code=$(curl -s -o "$tmp" -w '%{http_code}' "${ACCESS_HEADERS[@]}" \
    -X POST -H 'content-type: application/json' \
    "$STAGING_URL/api/score$query" \
    --data "$body")
  local body_code
  body_code=$("$JQ_BIN" -r '.error.code // "<no error.code>"' <"$tmp" 2>/dev/null || echo "<parse failed>")
  if [ "$code" = "$expected_status" ] && [ "$body_code" = "$expected_code" ]; then
    ok "$label (status=$code, error.code=$body_code)"
  else
    ko "$label" "expected ${expected_status}/${expected_code}, got ${code}/${body_code}"
  fi
  rm -f "$tmp"
}

# expect_status_method LABEL METHOD EXPECTED_STATUS
expect_status_method() {
  local label=$1 method=$2 expected=$3
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' "${ACCESS_HEADERS[@]}" -X "$method" "$STAGING_URL/api/score")
  if [ "$code" = "$expected" ]; then
    ok "$label (method=$method, status=$code)"
  else
    ko "$label" "expected $expected, got $code"
  fi
}

# expect_warm_hit LABEL BODY MAX_MS — POST and assert sub-MAX_MS round-trip
# AND scorecard.kind != 'registry_hit' (live or cache-hit, not curated).
expect_warm_hit() {
  local label=$1 body=$2 max_ms=$3
  local tmp
  tmp=$(mktemp)
  local start_ms end_ms duration code
  start_ms=$(now_ms)
  code=$(curl -s -o "$tmp" -w '%{http_code}' "${ACCESS_HEADERS[@]}" \
    -X POST -H 'content-type: application/json' \
    "$STAGING_URL/api/score" --data "$body")
  end_ms=$(now_ms)
  duration=$((end_ms - start_ms))
  if [ "$code" != "200" ]; then
    ko "$label" "expected 200, got $code: $(head -c 200 "$tmp")"
    rm -f "$tmp"
    return
  fi
  if [ "$duration" -gt "$max_ms" ]; then
    ko "$label" "expected <${max_ms} ms (cache hit), got ${duration} ms — cache may be cold"
    rm -f "$tmp"
    return
  fi
  ok "$label (status=200, duration=${duration} ms < ${max_ms} ms — cache hit)"
  rm -f "$tmp"
}

# expect_cold_then_warm LABEL_PREFIX BODY EXPECTED_BINARY
expect_cold_then_warm() {
  local label_prefix=$1 body=$2 binary=$3
  local tmp_cold tmp_warm
  tmp_cold=$(mktemp)
  tmp_warm=$(mktemp)

  # COLD
  local start_ms end_ms duration code
  start_ms=$(now_ms)
  code=$(curl -s -o "$tmp_cold" -w '%{http_code}' --max-time 90 "${ACCESS_HEADERS[@]}" \
    -X POST -H 'content-type: application/json' \
    "$STAGING_URL/api/score" --data "$body")
  end_ms=$(now_ms)
  duration=$((end_ms - start_ms))
  if [ "$code" != "200" ]; then
    ko "$label_prefix cold" "expected 200, got $code: $(head -c 200 "$tmp_cold")"
    rm -f "$tmp_cold" "$tmp_warm"
    return
  fi
  ok "$label_prefix cold (status=200, duration=${duration} ms — sandbox spawn)"

  # Verify R2 object lands at the canonical key.
  local key="scores/${binary}/${SPEC_VERSION}.json"
  if bun x wrangler r2 object get "${STAGING_BUCKET}/${key}" --file /tmp/r2-probe.json --remote >/dev/null 2>&1; then
    local payload_keys
    payload_keys=$("$JQ_BIN" -r 'keys | join(",")' </tmp/r2-probe.json 2>/dev/null || echo "")
    if echo "$payload_keys" | grep -q "spec_version" && echo "$payload_keys" | grep -q "anc_version" && echo "$payload_keys" | grep -q "tool_version"; then
      ok "$label_prefix R2 wrote $key with full payload shape"
    else
      ko "$label_prefix R2 write" "payload shape missing required fields (got: $payload_keys)"
    fi
  else
    ko "$label_prefix R2 write" "object not found at $key after cold run"
  fi

  # WARM
  start_ms=$(now_ms)
  code=$(curl -s -o "$tmp_warm" -w '%{http_code}' "${ACCESS_HEADERS[@]}" \
    -X POST -H 'content-type: application/json' \
    "$STAGING_URL/api/score" --data "$body")
  end_ms=$(now_ms)
  duration=$((end_ms - start_ms))
  if [ "$code" != "200" ]; then
    ko "$label_prefix warm" "expected 200, got $code"
    rm -f "$tmp_cold" "$tmp_warm"
    return
  fi
  if [ "$duration" -gt 2000 ]; then
    ko "$label_prefix warm" "expected <2000 ms (cache hit), got ${duration} ms"
    rm -f "$tmp_cold" "$tmp_warm"
    return
  fi
  ok "$label_prefix warm (status=200, duration=${duration} ms — cache hit)"

  # Cold and warm scorecards must be byte-identical (cache returns what we wrote).
  if diff <("$JQ_BIN" -S '.scorecard' <"$tmp_cold") <("$JQ_BIN" -S '.scorecard' <"$tmp_warm") >/dev/null 2>&1; then
    ok "$label_prefix scorecard equality (cold == warm)"
  else
    ko "$label_prefix scorecard equality" "cold and warm scorecards differ"
  fi
  rm -f "$tmp_cold" "$tmp_warm"
}

printf '\n=== staging-cache-smoke @ %s ===\n' "$STAGING_URL"
printf '    SPEC_VERSION=%s  COLD=%s\n\n' "$SPEC_VERSION" "$COLD"

# -----------------------------------------------------------------------------
# Group Z — CF Access boundary (must run FIRST so a lifted Access app
# surfaces here rather than silently letting the rest of the suite
# "pass" via the service-token bypass)
# -----------------------------------------------------------------------------
#
# Without the ACCESS_HEADERS, an unauth request to the staging Worker
# must be intercepted by Cloudflare Access and redirected to the
# account's *.cloudflareaccess.com login flow. If we instead see a 200
# or a 4xx from the Worker, the Access app has been disabled or its
# policies wiped, AND the rest of the suite would falsely "pass"
# (because every other request carries the service-token headers).
# This probe catches the boundary getting silently lifted.
printf '[Z] CF Access boundary\n'
ZUNAUTH_STATUS=$(curl -s -o /dev/null -w '%{http_code}' \
  "$STAGING_URL/api/score?input=ripgrep")
ZUNAUTH_LOC=$(curl -s -o /dev/null -w '%{redirect_url}' \
  "$STAGING_URL/api/score?input=ripgrep")
if [ "$ZUNAUTH_STATUS" = "302" ] && echo "$ZUNAUTH_LOC" | grep -q 'cloudflareaccess.com'; then
  ok "Z01 unauth request → 302 to *.cloudflareaccess.com (boundary enforced)"
else
  ko "Z01 unauth boundary" "expected 302 to *.cloudflareaccess.com; got status=$ZUNAUTH_STATUS location=${ZUNAUTH_LOC:-<empty>}"
fi

# -----------------------------------------------------------------------------
# Group A — input validation (warm; no sandbox)
# -----------------------------------------------------------------------------
printf '\n[A] input validation\n'
expect_error_code "A01 empty input"            '{"input":"","turnstile_token":"x"}'                                         400 unrecognized_input
expect_status_post "A02 malformed JSON body"   'not json'                                                                    400
expect_error_code "A03 non-https URL"          '{"input":"http://github.com/foo/bar","turnstile_token":"x"}'                400 non_https_url
expect_error_code "A04 non-github host"        '{"input":"https://example.com/foo/bar","turnstile_token":"x"}'              400 non_github_host
expect_error_code "A05 branch path URL"        '{"input":"https://github.com/foo/bar/tree/main","turnstile_token":"x"}'     400 invalid_url_path

# -----------------------------------------------------------------------------
# Group B — method gate (warm; no sandbox)
# -----------------------------------------------------------------------------
printf '\n[B] method gate\n'
expect_status_method "B01 DELETE → 405" DELETE 405
expect_status_method "B02 PUT → 405"    PUT    405

# -----------------------------------------------------------------------------
# Group C — Turnstile semantics (warm; no sandbox)
# -----------------------------------------------------------------------------
# Empty/missing tokens are rejected by the Worker BEFORE siteverify is called
# (the "missing_token" check fires first). The CF test secret only matters
# AFTER a non-empty token reaches siteverify.
printf '\n[C] Turnstile semantics\n'
expect_error_code "C01 empty turnstile_token"     '{"input":"https://github.com/foo/bar","turnstile_token":""}'  400 turnstile_failed
expect_error_code "C02 missing turnstile_token"   '{"input":"https://github.com/foo/bar"}'                       400 turnstile_failed

# Curated registry hit (slug=ripgrep) is unmetered — bypasses Turnstile entirely.
# Should return 200 with ANY token, including empty or missing.
expect_status_post "C03 curated slug with token=x" '{"input":"ripgrep","turnstile_token":"x"}' 200
expect_status_post "C04 curated slug with empty token (unmetered bypass)" '{"input":"ripgrep","turnstile_token":""}' 200
expect_status_post "C05 curated slug without token field"                  '{"input":"ripgrep"}'                       200

# -----------------------------------------------------------------------------
# Group D — registry/cache read tier (warm; no sandbox)
# -----------------------------------------------------------------------------
printf '\n[D] read tiers\n'
expect_warm_hit "D01 POST cowsay (cached from prior run)" '{"input":"npm install -g cowsay","turnstile_token":"x"}' 2000

# GET path: cache tier also honored on GET per U7 (read-only contract extended).
GET_LATENCY=$({
  start_ms=$(now_ms)
  curl -s -o /dev/null "${ACCESS_HEADERS[@]}" "$STAGING_URL/api/score?input=npm%20install%20-g%20cowsay"
  end_ms=$(now_ms)
  echo $((end_ms - start_ms))
})
GET_STATUS=$(curl -s -o /dev/null -w '%{http_code}' "${ACCESS_HEADERS[@]}" "$STAGING_URL/api/score?input=npm%20install%20-g%20cowsay")
if [ "$GET_STATUS" = "200" ] && [ "$GET_LATENCY" -lt 2000 ]; then
  ok "D02 GET cowsay → 200 cache-hit ($GET_LATENCY ms)"
else
  ko "D02 GET cowsay" "status=$GET_STATUS, latency=$GET_LATENCY ms"
fi

# GET on an uncached non-registry github-url → 404 chain_no_resolve.
# GET is registry + cache tier only (read-only contract). The cache tier
# can't help here because there's no derivable binary upfront.
GET_404_STATUS=$(curl -s -o /tmp/d03 -w '%{http_code}' "${ACCESS_HEADERS[@]}" "$STAGING_URL/api/score?input=https%3A%2F%2Fgithub.com%2Ftotally%2Funknown-tool-12345")
GET_404_CODE=$("$JQ_BIN" -r '.error.code // ""' </tmp/d03 2>/dev/null)
if [ "$GET_404_STATUS" = "404" ] && [ "$GET_404_CODE" = "chain_no_resolve" ]; then
  ok "D03 GET unknown github → 404 chain_no_resolve"
else
  ko "D03 GET unknown github" "status=$GET_404_STATUS, error.code=$GET_404_CODE"
fi
rm -f /tmp/d03

# -----------------------------------------------------------------------------
# Group E — cold sandbox spawns (only with --cold; 3 sandbox runs)
# -----------------------------------------------------------------------------
if [ "$COLD" = true ]; then
  printf '\n[E] cold sandbox spawns (3 cold + 3 warm)\n'

  expect_cold_then_warm "E01 pip install black"   '{"input":"pip install black","turnstile_token":"x"}'     black
  expect_cold_then_warm "E02 cargo binstall ouch" '{"input":"cargo binstall ouch","turnstile_token":"x"}'   ouch
  expect_cold_then_warm "E03 github.com/Aider-AI/aider (hint→pip aider-chat)" '{"input":"https://github.com/Aider-AI/aider","turnstile_token":"x"}' aider

  # E04 — ?fromCache=false bypass on a cached entry. Live re-spawn forced
  # even though cowsay is cached. The cache write still fires (overwriting
  # the existing entry with a freshly-scored copy).
  printf '  exercising ?fromCache=false bypass on cowsay (1 sandbox spawn)\n'
  start_ms=$(now_ms)
  code=$(curl -s -o /tmp/e04 -w '%{http_code}' --max-time 90 "${ACCESS_HEADERS[@]}" \
    -X POST -H 'content-type: application/json' \
    "$STAGING_URL/api/score?fromCache=false" \
    --data '{"input":"npm install -g cowsay","turnstile_token":"x"}')
  end_ms=$(now_ms)
  duration=$((end_ms - start_ms))
  if [ "$code" = "200" ] && [ "$duration" -gt 1500 ]; then
    ok "E04 ?fromCache=false on cowsay (status=200, duration=${duration} ms — live re-spawn)"
  else
    ko "E04 ?fromCache=false" "status=$code, duration=${duration} ms (expected 200 + >1500 ms)"
  fi
  rm -f /tmp/e04
else
  printf '\n[E] cold sandbox spawns: SKIPPED (pass --cold to enable)\n'
fi

# -----------------------------------------------------------------------------
# Summary
# -----------------------------------------------------------------------------
printf '\n=== summary: %d passed, %d failed ===\n' "$PASS" "$FAIL"
if [ "$FAIL" -gt 0 ]; then
  printf 'failed tests:\n'
  for label in "${FAIL_LABELS[@]}"; do printf '  - %s\n' "$label"; done
  exit 1
fi
exit 0
