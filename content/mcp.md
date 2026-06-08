# anc.dev MCP server

This URL is the streamable-HTTP [Model Context Protocol](https://modelcontextprotocol.io/) endpoint for anc.dev's
agent-native CLI standard registry. MCP clients POST JSON-RPC requests here.

- Wire contract and tool catalog: [/mcp-skill](/mcp-skill)
- JSON descriptor: [/mcp.json](/mcp.json) or [/.well-known/mcp](/.well-known/mcp) (also reachable on any of these URLs
  with `Accept: application/json`)
- Markdown twin of this page: [/mcp.md](/mcp.md)
- The standard itself: [the homepage](/)

If you want to call this endpoint programmatically, see the wire contract docs above.
