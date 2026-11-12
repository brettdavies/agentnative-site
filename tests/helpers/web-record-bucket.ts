// An in-memory R2 bucket for the website cache that keeps each object's custom
// metadata beside its body, so a test reads both halves of a stored record:
// the JSON body and the board fields derived from it. `onGet` and `failPuts`
// let a test change the store between two reads, or refuse a write.

import { keyFor } from '../../src/worker/audit-web/cache';
import { SPEC_VERSION } from '../../src/worker/spec-version.gen';

export type StoredWebObject = { body: string; customMetadata: Record<string, string> };

export type WebRecordBucketHooks = {
  /** Runs before each `get`, with the key and how many times that key was read, counting this read. */
  onGet?: (key: string, nth: number) => void | Promise<void>;
  /** Makes every `put` throw. */
  failPuts?: boolean;
};

export type WebRecordBucket = {
  bucket: R2Bucket;
  objects: Map<string, StoredWebObject>;
  /** The key of every `put`, in order. */
  puts: string[];
  /** The key of every `get`, in order. */
  gets: string[];
  hooks: WebRecordBucketHooks;
  /** The parsed body stored for `url`, or null. */
  recordOf(url: string): Promise<StoredWebRecord | null>;
  /** The custom metadata stored for `url`, or null. */
  metadataOf(url: string): Promise<Record<string, string> | null>;
  /** Replaces the object for `url` without counting it as a `put`. */
  set(url: string, record: unknown, customMetadata?: Record<string, string>): Promise<void>;
  /** Deletes the object for `url` without counting it as a `put`. */
  drop(url: string): Promise<void>;
};

export type StoredWebRecord = {
  spec_version: string;
  target_url: string;
  scorecard: Record<string, unknown> & { public_listing?: boolean };
  scored_at?: string;
};

export function webRecordBucket(prefill: Record<string, unknown> = {}): WebRecordBucket {
  const objects = new Map<string, StoredWebObject>();
  const puts: string[] = [];
  const gets: string[] = [];
  const reads = new Map<string, number>();
  const hooks: WebRecordBucketHooks = {};
  for (const [key, value] of Object.entries(prefill)) {
    objects.set(key, { body: typeof value === 'string' ? value : JSON.stringify(value), customMetadata: {} });
  }
  const bucket = {
    async get(key: string) {
      gets.push(key);
      const nth = (reads.get(key) ?? 0) + 1;
      reads.set(key, nth);
      await hooks.onGet?.(key, nth);
      const object = objects.get(key);
      if (!object) return null;
      return {
        async json() {
          return JSON.parse(object.body);
        },
      };
    },
    async put(key: string, value: string, options?: { customMetadata?: Record<string, string> }) {
      if (hooks.failPuts) throw new Error('r2 put refused');
      puts.push(key);
      objects.set(key, { body: value, customMetadata: options?.customMetadata ?? {} });
    },
    async delete(key: string) {
      objects.delete(key);
    },
    async list() {
      return { objects: [], truncated: false };
    },
  } as unknown as R2Bucket;
  const keyOf = (url: string) => keyFor(url, SPEC_VERSION);
  return {
    bucket,
    objects,
    puts,
    gets,
    hooks,
    async recordOf(url) {
      const object = objects.get(await keyOf(url));
      return object ? (JSON.parse(object.body) as StoredWebRecord) : null;
    },
    async metadataOf(url) {
      return objects.get(await keyOf(url))?.customMetadata ?? null;
    },
    async set(url, record, customMetadata = {}) {
      objects.set(await keyOf(url), { body: JSON.stringify(record), customMetadata });
    },
    async drop(url) {
      objects.delete(await keyOf(url));
    },
  };
}
