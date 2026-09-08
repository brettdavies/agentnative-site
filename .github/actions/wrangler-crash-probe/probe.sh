#!/usr/bin/env bash
# Exit 0 when the evidence under the given directory shows the dev server
# was killed by infrastructure rather than by the code under test; 1
# otherwise. Two independent signatures grant it:
#
# 1. workers-sdk#15317 in the wrangler debug logs (*.log). Wrangler's
#    ProxyController treats a dropped connection to the runtime as fatal
#    and kills the dev server, and prints it with no message because
#    castErrorCause builds `new Error()` from the plain object ProxyWorker
#    posts. The failure is wrangler's, not ours, and reporters have ruled
#    out the mitigations that would otherwise be ours to make: halving
#    Playwright workers, running a single dev server, and upgrading all
#    leave it in place, and it reproduces with one sequential request and
#    no browser at all. All four strings name wrangler's own proxy
#    plumbing, so none can appear when the Worker or a test is what broke.
#
# 2. Mass connection refusals in the Playwright JSON summary (*.json).
#    Some kills leave nothing in the debug log at all: run 34258260004
#    died with a bare message-less `✘ [ERROR]` on stderr and a log that
#    simply stops mid-stream, missing every string above. What that class
#    still cannot hide is the aftermath: once the server is gone, every
#    remaining test fails with a connection refusal, dozens at a time
#    (74 in run 34256095393). A real test failure never produces that —
#    the server outlives the suite — so a double-digit refusal count is
#    server-death evidence on its own. The floor of 10 keeps a stray
#    single-test connectivity flake from claiming the retry.
set -euo pipefail

dir=${1:?usage: probe.sh <evidence-dir>}

proxy_crash=true
for needle in 'Network connection lost' 'castErrorCause' 'ProxyController' 'handleLoopback'; do
  grep -rqs --include='*.log' -- "$needle" "$dir" || {
    proxy_crash=false
    break
  }
done
[ "$proxy_crash" = true ] && exit 0

refusals=$( (grep -rhso --include='*.json' -E 'Could not connect to localhost|ECONNREFUSED' "$dir" || true) | wc -l)
[ "$refusals" -ge 10 ]
