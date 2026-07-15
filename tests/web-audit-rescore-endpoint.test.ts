// Rescore-trigger tests: the POST /api/web-rescore auth gate, the
// single-flight coalescing across the deploy hook and the cron, and the
// scheduled() entry through the Worker default export.

import { describe, expect, test } from 'bun:test';
import { handleWebRescore, startWebRescore, type WebRescoreTriggerEnv } from '../src/worker/audit-web/rescore-trigger';
import worker, { type Env } from '../src/worker/index';

type StubOpts = {
  runningInstance?: string;
  createdIds?: string[];
  kvStore?: Map<string, string>;
  secret?: string | undefined;
};

function makeEnv(opts: StubOpts = {}): WebRescoreTriggerEnv {
  const createdIds = opts.createdIds ?? [];
  const kvStore = opts.kvStore ?? new Map<string, string>();
  return {
    SCORE_KV: {
      async get(key: string) {
        return kvStore.get(key) ?? null;
      },
      async put(key: string, value: string) {
        kvStore.set(key, value);
      },
    } as unknown as KVNamespace,
    WEB_RESCORE_WORKFLOW: {
      async get(id: string) {
        if (opts.runningInstance === id) {
          return { status: async () => ({ status: 'running' }) };
        }
        return { status: async () => ({ status: 'complete' }) };
      },
      async create(options?: { id?: string }) {
        const id = options?.id ?? 'auto';
        createdIds.push(id);
        return { id };
      },
    },
    WEB_RESCORE_SECRET: 'secret' in opts ? opts.secret : 'test-rescore-secret',
  };
}

function rescoreRequest(secret?: string, method = 'POST'): Request {
  const headers: Record<string, string> = {};
  if (secret !== undefined) headers['x-web-rescore-secret'] = secret;
  return new Request('https://anc.dev/api/web-rescore', { method, headers });
}

describe('handleWebRescore auth gate', () => {
  test('the correct secret starts the Workflow and returns 202', async () => {
    const createdIds: string[] = [];
    const env = makeEnv({ createdIds });
    const resp = await handleWebRescore(rescoreRequest('test-rescore-secret'), env);
    expect(resp.status).toBe(202);
    const body = (await resp.json()) as { started: boolean; coalesced: boolean; instance_id: string };
    expect(body.started).toBe(true);
    expect(body.coalesced).toBe(false);
    expect(createdIds).toEqual([body.instance_id]);
  });

  test('a missing secret header returns 401 and does not start the Workflow', async () => {
    const createdIds: string[] = [];
    const env = makeEnv({ createdIds });
    const resp = await handleWebRescore(rescoreRequest(undefined), env);
    expect(resp.status).toBe(401);
    expect(createdIds).toEqual([]);
  });

  test('a wrong secret returns 401 and does not start the Workflow', async () => {
    const createdIds: string[] = [];
    const env = makeEnv({ createdIds });
    const resp = await handleWebRescore(rescoreRequest('wrong'), env);
    expect(resp.status).toBe(401);
    expect(createdIds).toEqual([]);
  });

  test('a missing Worker-side secret fails fast with 500 (never a silent 401)', async () => {
    const env = makeEnv({ secret: undefined });
    const resp = await handleWebRescore(rescoreRequest('anything'), env);
    expect(resp.status).toBe(500);
    expect(((await resp.json()) as { error: string }).error).toBe('service_misconfigured');
  });

  test('non-POST returns 405 with Allow', async () => {
    const env = makeEnv();
    const resp = await handleWebRescore(rescoreRequest('test-rescore-secret', 'GET'), env);
    expect(resp.status).toBe(405);
    expect(resp.headers.get('allow')).toBe('POST');
  });
});

describe('startWebRescore single-flight', () => {
  test('starts a fresh instance and records the KV pointer', async () => {
    const createdIds: string[] = [];
    const kvStore = new Map<string, string>();
    const env = makeEnv({ createdIds, kvStore });
    const result = await startWebRescore(env);
    expect(result.coalesced).toBe(false);
    expect(createdIds).toEqual([result.instanceId]);
    expect(kvStore.get('web_rescore:current')).toBe(result.instanceId);
  });

  test('a start while a batch is running coalesces onto the in-flight instance', async () => {
    const createdIds: string[] = [];
    const kvStore = new Map<string, string>([['web_rescore:current', 'rescore-live']]);
    const env = makeEnv({ createdIds, kvStore, runningInstance: 'rescore-live' });
    const result = await startWebRescore(env);
    expect(result).toEqual({ instanceId: 'rescore-live', coalesced: true });
    expect(createdIds).toEqual([]);
  });

  test('a pointer to a completed instance admits a fresh start', async () => {
    const createdIds: string[] = [];
    const kvStore = new Map<string, string>([['web_rescore:current', 'rescore-done']]);
    const env = makeEnv({ createdIds, kvStore });
    const result = await startWebRescore(env);
    expect(result.coalesced).toBe(false);
    expect(createdIds).toHaveLength(1);
    expect(kvStore.get('web_rescore:current')).toBe(result.instanceId);
  });

  test('a broken status lookup falls through to a fresh start rather than wedging', async () => {
    const createdIds: string[] = [];
    const kvStore = new Map<string, string>([['web_rescore:current', 'rescore-gone']]);
    const env = makeEnv({ createdIds, kvStore });
    (env.WEB_RESCORE_WORKFLOW as { get: unknown }).get = async () => {
      throw new Error('instance not found');
    };
    const result = await startWebRescore(env);
    expect(result.coalesced).toBe(false);
    expect(createdIds).toHaveLength(1);
  });

  test('the deploy hook coalesces too (shared helper through the endpoint)', async () => {
    const createdIds: string[] = [];
    const kvStore = new Map<string, string>([['web_rescore:current', 'rescore-live']]);
    const env = makeEnv({ createdIds, kvStore, runningInstance: 'rescore-live' });
    const resp = await handleWebRescore(rescoreRequest('test-rescore-secret'), env);
    expect(resp.status).toBe(202);
    const body = (await resp.json()) as { started: boolean; coalesced: boolean };
    expect(body.started).toBe(false);
    expect(body.coalesced).toBe(true);
    expect(createdIds).toEqual([]);
  });
});

describe('scheduled()', () => {
  test('a cron tick starts the Workflow once through the same helper', async () => {
    const createdIds: string[] = [];
    const env = makeEnv({ createdIds }) as unknown as Env;
    await worker.scheduled?.(
      { scheduledTime: Date.now(), cron: '0 6 * * 1', noRetry: () => {} } as ScheduledController,
      env,
      {} as ExecutionContext,
    );
    expect(createdIds).toHaveLength(1);
  });
});
