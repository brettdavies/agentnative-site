// In-memory bindings behind the declared-domain budget: a KV namespace that
// appends each read and write to a log in call order, and a rate limiter
// with the binding's fixed 60-second window on an injectable clock.

import { sha256Hex } from '../../src/worker/audit-web/cache';
import { DECLARED_DOMAIN_BUDGET_PREFIX } from '../../src/worker/audit-web/limiter';

export function memoryKv(log: string[] = []): KVNamespace {
  const store = new Map<string, string>();
  return {
    async get(key: string) {
      log.push(`kv:get ${key}`);
      return store.get(key) ?? null;
    },
    async put(key: string, value: string) {
      log.push(`kv:put ${key}`);
      store.set(key, value);
    },
  } as unknown as KVNamespace;
}

export function memoryRateLimit(
  limit: number,
  now: () => number = Date.now,
): { limit(o: { key: string }): Promise<{ success: boolean }> } {
  const windows = new Map<string, { start: number; count: number }>();
  return {
    async limit({ key }) {
      const at = now();
      let window = windows.get(key);
      if (window === undefined || at - window.start >= 60_000) {
        window = { start: at, count: 0 };
        windows.set(key, window);
      }
      if (window.count >= limit) return { success: false };
      window.count += 1;
      return { success: true };
    },
  };
}

/** The KV key prefix a domain's hourly budget lives under, hour bucket excluded. */
export async function budgetKeyPrefix(domain: string): Promise<string> {
  return `${DECLARED_DOMAIN_BUDGET_PREFIX}:${await sha256Hex(domain)}:`;
}
