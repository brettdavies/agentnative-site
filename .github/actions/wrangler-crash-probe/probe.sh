#!/usr/bin/env bash
# Exit 0 when the *.log files under the given directory carry the
# workers-sdk#15317 signature; 1 otherwise.
#
# workers-sdk#15317: wrangler's ProxyController treats a dropped connection
# to the runtime as fatal and kills the dev server, and prints it with no
# message because castErrorCause builds `new Error()` from the plain object
# ProxyWorker posts. The failure is wrangler's, not ours, and reporters
# have ruled out the mitigations that would otherwise be ours to make:
# halving Playwright workers, running a single dev server, and upgrading
# all leave it in place, and it reproduces with one sequential request and
# no browser at all.
#
# All four strings name wrangler's own proxy plumbing, so none can appear
# when the Worker or a test is what broke. Requiring every one of them is
# what stops a real failure that happens to share the surface symptom from
# claiming a free retry.
set -euo pipefail

dir=${1:?usage: probe.sh <log-dir>}

for needle in 'Network connection lost' 'castErrorCause' 'ProxyController' 'handleLoopback'; do
  grep -rqs --include='*.log' -- "$needle" "$dir" || exit 1
done
