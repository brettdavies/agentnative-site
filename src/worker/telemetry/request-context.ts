// Request-scoped ambient fields for the structured-log emitter. Entered
// inside `Cached.fetch`, read by the emitter on every record it writes
// within that request, and absent (undefined) on every path that runs
// outside a gateway-served request: the Sandbox Durable Object, the
// web-rescore Workflow, `scheduled()`, and the `purgeHitMinTags` RPC.

import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Fields the emitter merges into every record emitted inside the request.
 * `scope` and `event` are excluded so an ambient key can never replace the
 * typed discriminator.
 */
export type AmbientFields = Readonly<Record<string, string | number | boolean | null>> & {
  readonly scope?: never;
  readonly event?: never;
};

const storage = new AsyncLocalStorage<AmbientFields>();

export function runWithRequestContext<T>(fields: AmbientFields, fn: () => T): T {
  return storage.run(fields, fn);
}

export function getRequestContext(): AmbientFields | undefined {
  return storage.getStore();
}
