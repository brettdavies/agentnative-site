# anc.dev MCP server

This URL is the streamable-HTTP [Model Context Protocol](https://modelcontextprotocol.io/) endpoint for anc.dev's
agent-native CLI standard registry. MCP clients POST JSON-RPC requests here.

- Wire contract and tool catalog: [/mcp-skill](/mcp-skill)
- JSON descriptor: [/.well-known/mcp](/.well-known/mcp) (canonical). Aliases: [/mcp.json](/mcp.json), [/.well-known/mcp/server-card.json](/.well-known/mcp/server-card.json). Also reachable on `/mcp` with `Accept: application/json`.
- Markdown twin of this page: [/mcp.md](/mcp.md)
- The standard itself: [the homepage](/)

If you want to call this endpoint programmatically, see the wire contract docs above.
