// Tool registration aggregator. Imports each surface's registerXxx
// function and calls them in order. The order is meaningful only for
// tools/list ordering — agent introspection lists tools in the order
// they were registered.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Catalog } from '../catalog';
import { registerPrincipleTools } from './principles';
import { registerRegistryTools } from './registry';
import { registerScorecardAuditTool } from './scorecard-audit';
import { registerScorecardReadTool, type ScorecardReadEnv } from './scorecard-read';
import { registerSpecTools } from './spec';

export interface RegisterToolsEnv extends ScorecardReadEnv {}

export function registerTools(server: McpServer, catalog: Catalog, env: RegisterToolsEnv): void {
  registerRegistryTools(server, catalog);
  registerPrincipleTools(server, catalog);
  registerSpecTools(server, catalog);
  registerScorecardReadTool(server, catalog, env);
  registerScorecardAuditTool(server, catalog);
}
