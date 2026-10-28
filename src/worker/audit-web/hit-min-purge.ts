// HIT-min tag purge: callers queue tags after a successful R2 write and
// flush once. The RPC lives on the cached entrypoint because Workers
// Caching purge is scoped to that entrypoint; the uncached gateway's
// ctx.cache.purge would miss inner entries (KTD7). Work that should follow
// a write without holding the response, such as asking for a scorecard's
// clip, queues beside the tags and runs after the purge, once per key.
//
// R2 writers stay env-only and do not import this module.

import { AsyncLocalStorage } from 'node:async_hooks';
import { emitLog } from '../telemetry/log';

export { cliTargetTag, homeTag, webDomainTag, webTag } from './hit-min-tags';

type PurgeResult = { success: boolean; errors?: unknown[] };

type CachedPurgeRpc = {
  purgeHitMinTags(tags: string[]): Promise<PurgeResult>;
};

/** A Worker's ExecutionContext or a Durable Object's state: whatever carries `exports`. */
export type PurgeCtx = { exports?: unknown };

type PurgeStore = { ctx: PurgeCtx; tags: Set<string>; after: Map<string, () => Promise<void>> };

const als = new AsyncLocalStorage<PurgeStore>();

export function runWithHitMinPurge<T>(ctx: PurgeCtx, fn: () => T): T {
  return als.run({ ctx, tags: new Set(), after: new Map() }, fn);
}

export function queueHitMinPurge(tags: readonly string[]): void {
  const store = als.getStore();
  if (!store) {
    emitLog({ scope: 'hit-min-purge' }, { error: 'queue_without_store', tags });
    return;
  }
  for (const tag of tags) {
    if (tag) store.tags.add(tag);
  }
}

/** Queue `task` to run after the purge flushes; a second task under the same key is dropped. The task must not throw. */
export function queueAfterHitMinPurge(key: string, task: () => Promise<void>): void {
  const store = als.getStore();
  if (!store) {
    emitLog({ scope: 'hit-min-purge' }, { error: 'queue_without_store', key });
    return;
  }
  if (!store.after.has(key)) store.after.set(key, task);
}

export async function flushHitMinPurge(): Promise<void> {
  const store = als.getStore();
  if (!store) return;
  const tags = [...store.tags];
  const after = [...store.after.values()];
  store.tags.clear();
  store.after.clear();
  if (tags.length > 0) await invokeCachedPurge(store.ctx, tags);
  for (const task of after) await task();
}

/**
 * One RPC with the given tags. Used by the rescore cycle (already batched)
 * and as the flush target. Never sends pathPrefixes.
 */
export async function invokeCachedPurge(ctx: PurgeCtx, tags: readonly string[]): Promise<void> {
  const unique = [...new Set(tags.filter((t) => t.length > 0))];
  if (unique.length === 0) return;
  try {
    const rpc = cachedPurgeRpc(ctx);
    if (rpc) {
      const result = await rpc.purgeHitMinTags(unique);
      if (!result.success) {
        emitLog({ scope: 'hit-min-purge' }, { tags: unique, errors: result.errors ?? [] });
      }
      return;
    }
    emitLog({ scope: 'hit-min-purge' }, { error: 'cache_purge_unavailable', tags: unique });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emitLog({ scope: 'hit-min-purge' }, { error: message, tags: unique });
  }
}

function cachedPurgeRpc(ctx: PurgeCtx): CachedPurgeRpc | null {
  const stub = (ctx.exports as { Cached?: CachedPurgeRpc } | undefined)?.Cached;
  if (stub && typeof stub.purgeHitMinTags === 'function') return stub;
  return null;
}
