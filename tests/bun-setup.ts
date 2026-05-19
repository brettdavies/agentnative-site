// Bun-test setup — registered via bunfig.toml `[test].preload`.
//
// Why this exists: `@cloudflare/containers` (transitive dep of
// `@cloudflare/sandbox`, imported by `src/worker/score/do.ts`) does a
// top-level `import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers'`
// in its CJS bundle. `cloudflare:workers` is a workerd-runtime-only virtual
// module — Bun can't resolve it and the import throws at module load,
// taking down every test that transitively imports the Worker entry
// (worker.test.ts, score-handler.test.ts via shared fixtures, etc.).
//
// This shim provides no-op `DurableObject` and `WorkerEntrypoint` classes
// so the import succeeds. Bun-side tests that exercise pure logic (handler
// orchestration, content negotiation, header policy) keep working.
//
// Tests that need real DO behavior (state persistence, alarms, fetch
// dispatch through the binding) must use a different test runtime
// (workerd via @cloudflare/vitest-pool-workers) or run as E2E against a
// deployed Worker. The shim catches the "module loads" floor; it doesn't
// pretend DurableObject semantics work.

import { plugin } from 'bun';

plugin({
  name: 'cloudflare-workers-shim',
  setup(build) {
    build.module('cloudflare:workers', () => ({
      contents: [
        'export class DurableObject {',
        '  constructor(ctx, env) { this.ctx = ctx; this.env = env; }',
        '}',
        'export class WorkerEntrypoint {',
        '  constructor(ctx, env) { this.ctx = ctx; this.env = env; }',
        '}',
        // env wrapper sentinel — some CF helpers probe for this at module load.
        'export const env = undefined;',
      ].join('\n'),
      loader: 'js',
    }));
  },
});
