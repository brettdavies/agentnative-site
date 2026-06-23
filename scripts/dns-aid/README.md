# DNS-AID for anc.dev

Agent-readiness scanners probe DNS for AI Discovery (DNS-AID) via DNS-over-HTTPS.
These records live in the **anc.dev Cloudflare zone**, not in the Worker build.

## Publish

```bash
CLOUDFLARE_API_TOKEN=<zone-dns-edit> \
CLOUDFLARE_ZONE_ID=<anc.dev-zone-id> \
  ./scripts/dns-aid/publish-anc-dev.sh
```

Records:

| Name | Type | Target |
|------|------|--------|
| `_index._agents.anc.dev` | SVCB | `anc.dev` with `alpn=mcp,h2,h3` |
| `_mcp._agents.anc.dev` | SVCB | `anc.dev` with `alpn=mcp,h2,h3` |

Enable **DNSSEC** on the zone (Cloudflare dashboard: DNS → Settings) so validating
resolvers return authenticated data.

## Verify

```bash
dig SVCB _index._agents.anc.dev +short
dig SVCB _mcp._agents.anc.dev +short
```

Or re-run the isitagentready scan: `https://isitagentready.com/anc.dev`
