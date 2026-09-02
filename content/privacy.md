# Privacy

What this site derives from a visit, what it never stores, and how long each kind of record is kept. This page states
the upper bound of what the site collects.

## What the site derives from a visit

For every request, whoever or whatever sent it, the site derives at most:

- the path requested and the surface that served it (HTML page, markdown twin, or [MCP](/mcp))
- the response status, latency, and cache state
- a client class from a closed taxonomy: a human browser, or one of four automated classes (AI fetcher, AI crawler,
  search crawler, CLI client)

For browser visitors the site also derives the browser family, its version truncated to major.minor, the rendering
engine, and the operating system. For automated clients it derives the product name of the tool.

Requests arriving close together may share a journey key so the site can see which pages a single visit touched. The key
exists only within that window: it is not stored in a cookie, is derived from nothing persistent, and cannot be
reconstructed after the window closes.

## What is never stored

No record the site writes, and no record it exports anywhere, contains a client IP address or a raw User-Agent string.
Both are read in the moment to derive the fields above, then discarded.

## How long records are kept

Every telemetry record the site keeps lives in one of three retention tiers, all on the site's hosting platform
(Cloudflare). No third-party analytics infrastructure is involved.

- **Live tier, 7 days.** Raw operational events for day-to-day monitoring. The platform caps this window at seven days.
- **Zone tier, 90 days.** Daily rollups: coarse aggregates, no per-request rows.
- **Archive tier, indefinite.** Raw events in an open format, in storage the operator controls. This tier has no fixed
  expiry; records stay until the operator deletes them.

## What the operator can and cannot do

The operator can query trends and shares across the retained records: which client classes visit, which surfaces they
use, how pages perform.

The operator cannot link a visit in one window to a visit in another. No persistent identifier exists in any record, and
journey keys cannot be recovered once their window closes. Cross-window linkage is deliberately given up in the design.

## The performance beacon

Pages served to browsers load the Cloudflare Web Analytics beacon, which measures page views and Core Web Vitals. The
beacon is cookieless. Through it Cloudflare collects the page URL, performance timings, and the browser type. It sets no
cookies and does no cross-site tracking.

## What gets published

Any statistic the site publishes is a share or a percentage, never a raw count.

This page tracks what the site actually does: when collection changes, the page changes with it, without intentional
lag, though the posture itself may evolve. It is verifiable against the telemetry code in the site's
[public repository](https://github.com/brettdavies/agentnative-site/tree/main/src/worker); every record the site writes
flows through that code.
