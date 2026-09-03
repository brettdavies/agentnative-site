// HIT-min tag purge: callers queue tags after a successful R2 write and
// flush once. The RPC lives on the cached entrypoint because Workers
// Caching purge is scoped to that entrypoint; the uncached gateway's
// ctx.cache.purge would miss inner entries (KTD7).
//
// R2 writers stay env-only and do not import this module.

import { AsyncLocalStorage } from 'node:async_hooks';
import { emitLog } from '../telemetry/log';

export { homeTag, webDomainTag, webTag } from './hit-min-tags';

type PurgeResult = { success: boolean; errors?: unknown[] };

type CachedPurgeRpc = {
  purgeHitMinTags(tags: string[]): Promise<PurgeResult>;
};

type PurgeStore = { ctx: ExecutionContext; tags: Set<string> };

const als = new AsyncLocalStorage<PurgeStore>();

export function runWithHitMinPurge<T>(ctx: ExecutionContext, fn: () => T): T {
  return als.run({ ctx, tags: new Set() }, fn);
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

export async function flushHitMinPurge(): Promise<void> {
  const store = als.getStore();
  if (!store || store.tags.size === 0) return;
  const tags = [...store.tags];
  store.tags.clear();
  await invokeCachedPurge(store.ctx, tags);
}

/**
 * One RPC with the given tags. Used by the rescore cycle (already batched)
 * and as the flush target. Never sends pathPrefixes.
 */
export async function invokeCachedPurge(ctx: ExecutionContext, tags: readonly string[]): Promise<void> {
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

function cachedPurgeRpc(ctx: ExecutionContext): CachedPurgeRpc | null {
  const stub = (ctx as ExecutionContext & { exports?: { Cached?: CachedPurgeRpc } }).exports?.Cached;
  if (stub && typeof stub.purgeHitMinTags === 'function') return stub;
  return null;
}
