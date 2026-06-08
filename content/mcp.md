# anc.dev MCP server

This URL is the streamable-HTTP [Model Context Protocol](https://modelcontextprotocol.io/) endpoint for anc.dev's
agent-native CLI standard registry. MCP clients POST JSON-RPC requests here.

- Wire contract and tool catalog: [/mcp-skill](/mcp-skill)
- JSON descriptor: [/.well-known/mcp](/.well-known/mcp) (or `curl -H 'Accept: application/json' https://anc.dev/mcp`)
- The standard itself: [anc.dev](/)

If you want to call this endpoint programmatically, see the wire contract docs above.
