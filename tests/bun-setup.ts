// Bun-test setup — registered via bunfig.toml `[test].preload`.
//
// Bun's module resolver doesn't know about workerd's `cloudflare:*`
// virtual modules. Without these shims, importing any file that
// transitively pulls in `@cloudflare/containers`, `@cloudflare/sandbox`,
// or the `agents` SDK fails at module load with
// `Cannot find package 'cloudflare:...'`.
//
// The shims are a LOAD-FLOOR, not a behavior simulator. Tests that need
// real workerd semantics belong in a follow-up vitest-pool-workers
// layer (see U7 of the MCP endpoint plan).
//
// Modules covered (driven by the agents@^0.13.3 + @cloudflare/sandbox
// dependency trees):
//
//   cloudflare:workers — DurableObject, WorkerEntrypoint, RpcTarget,
//                        WorkflowEntrypoint, exports, env. Used by
//                        @cloudflare/containers (transitive via
//                        @cloudflare/sandbox) and by agents.
//   cloudflare:email   — EmailMessage. Used by agents/dist/index.js.
//
// If a future SDK bump adds another `cloudflare:*` import the failure
// mode is the same; add a build.module call.

import { plugin } from 'bun';

plugin({
  name: 'cloudflare-virtual-modules-shim',
  setup(build) {
    build.module('cloudflare:workers', () => ({
      contents: [
        'export class DurableObject {',
        '  constructor(ctx, env) { this.ctx = ctx; this.env = env; }',
        '}',
        'export class WorkerEntrypoint {',
        '  constructor(ctx, env) { this.ctx = ctx; this.env = env; }',
        '}',
        'export class WorkflowEntrypoint {',
        '  constructor(ctx, env) { this.ctx = ctx; this.env = env; }',
        '}',
        'export class RpcTarget {}',
        'export const exports = {};',
        'export const env = undefined;',
      ].join('\n'),
      loader: 'js',
    }));

    build.module('cloudflare:email', () => ({
      contents: [
        'export class EmailMessage {',
        '  constructor(from, to, raw) { this.from = from; this.to = to; this.raw = raw; }',
        '}',
      ].join('\n'),
      loader: 'js',
    }));
  },
});
