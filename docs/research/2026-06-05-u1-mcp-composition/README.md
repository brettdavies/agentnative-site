# U1 spike: CF MCP handler + Sandbox DO composition

Archived verification spike from the MCP endpoint U1 work (2026-06-05). A self-contained Worker that confirmed a
Cloudflare MCP handler and a Sandbox Durable Object compose in one Worker before the real `src/worker/mcp/` module was
built.

Kept here for reference only. It is not part of the site build or deploy, and `docs/research/` is blocked from `main` by
the guard so the spike never re-enters the production tree. The shipped implementation lives under `src/worker/mcp/`.
