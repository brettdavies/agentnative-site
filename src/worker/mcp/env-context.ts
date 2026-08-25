// Per-request Worker env for MCP tool handlers. The SDK v2 factory creates a
// fresh McpServer per request but does not pass Wrangler bindings into the
// factory; tools that need SCORE_KV / R2 / limiters read env from here.
// Wrapped around handler.fetch in index.ts (same AsyncLocalStorage pattern as
// agents/mcp auth-context).

import { AsyncLocalStorage } from 'node:async_hooks';
import type { McpEnv } from './server';

const storage = new AsyncLocalStorage<McpEnv>();

export function runWithMcpEnv<T>(env: McpEnv, fn: () => T | Promise<T>): T | Promise<T> {
  return storage.run(env, fn);
}

export function getMcpEnv(): McpEnv {
  const env = storage.getStore();
  if (!env) {
    throw new Error('MCP env not set — handler.fetch must run inside runWithMcpEnv');
  }
  return env;
}
