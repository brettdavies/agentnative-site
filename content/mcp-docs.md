# anc.dev MCP server

`POST /mcp` is the streamable-HTTP [Model Context Protocol](https://modelcontextprotocol.io/) endpoint for anc.dev's
agent-native CLI standard registry. MCP clients POST JSON-RPC requests there. `GET /mcp` returns `405 Method Not
Allowed` with `Allow: POST`. This page describes the endpoint. It is not the endpoint.

- Endpoint: `POST` [/mcp](/mcp)
- Wire contract and tool catalog: [/mcp-skill](/mcp-skill)
- JSON server card (SEP-1649): [/.well-known/mcp/server-card.json](/.well-known/mcp/server-card.json). Pointer aliases:
  [/.well-known/mcp](/.well-known/mcp), [/mcp.json](/mcp.json).
- JSON server card (SEP-2127): [/mcp/server-card](/mcp/server-card), served as `application/mcp-server-card+json`.
- AI catalog listing the SEP-2127 card: [/.well-known/ai-catalog.json](/.well-known/ai-catalog.json), served as
  `application/ai-catalog+json`.
- Markdown twin of this page: [/mcp-docs.md](/mcp-docs.md)
- The standard itself: [the homepage](/)

To call the endpoint, read the wire contract above and POST to `/mcp`.
