// The transact click is the only gesture that acquires a Turnstile token;
// the stash carries it to the progress page single-use, and startAudit is
// the one handler every transact control binds. These tests pin the guard
// against double spend, the stash lifetime, and the omit-not-false
// transport for the listing choice.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { _resetStartAuditForTests, startAudit } from '../src/client/audit-start';
import {
  buildScoreBody,
  clearInlineResult,
  enteredLaneOf,
  STASH_TTL_MS,
  stash,
  stashInlineResult,
  take,
  takeInlineResult,
} from '../src/client/audit-stash';
import {
  acquireTurnstileToken,
  loadTurnstileOnFirstInteraction,
  type TurnstileApi,
  teardownTurnstile,
} from '../src/client/turnstile';
import { installSessionStorage } from './helpers/session-storage';

let restoreSessionStorage: () => void = () => {};

beforeEach(() => {
  restoreSessionStorage();
  restoreSessionStorage = installSessionStorage();
  _resetStartAuditForTests({ guard: true });
});

afterAll(() => restoreSessionStorage());

describe('stash and take', () => {
  test('take returns the record once and null on the second call', () => {
    stash('anc.dev', { token: 'tok', listing: true, entered_lane: 'web', refresh: false });
    expect(take('anc.dev')).toMatchObject({ token: 'tok', listing: true, entered_lane: 'web', refresh: false });
    expect(take('anc.dev')).toBeNull();
  });

  test('a stash older than the TTL is discarded and reported absent', () => {
    expect(STASH_TTL_MS).toBe(240_000);
    stash(
      'anc.dev',
      { token: 'tok', listing: null, entered_lane: 'web', refresh: false },
      Date.now() - STASH_TTL_MS - 1,
    );
    expect(take('anc.dev')).toBeNull();
    stash(
      'anc.dev',
      { token: 'tok', listing: null, entered_lane: 'web', refresh: false },
      Date.now() - STASH_TTL_MS + 5_000,
    );
    expect(take('anc.dev')).not.toBeNull();
  });

  test('the stash is keyed by normalized target and survives a corrupt neighbour', () => {
    stash('anc.dev', { token: 'a', listing: null, entered_lane: 'web', refresh: false });
    sessionStorage.setItem('audit-stash:other.example', 'not json');
    expect(take('other.example')).toBeNull();
    expect(take('anc.dev')?.token).toBe('a');
  });

  test('the entered lane is kept per target beyond the single-use record', () => {
    stash('ripgrep', { token: 'a', listing: null, entered_lane: 'web', refresh: false });
    take('ripgrep');
    expect(enteredLaneOf('ripgrep')).toBe('web');
    expect(enteredLaneOf('other')).toBeNull();
  });

  test('a stored inline result is returned once by take and cleared by the next terminal event', () => {
    stashInlineResult('ouch', '<article>body</article>');
    expect(takeInlineResult('ouch')).toBe('<article>body</article>');
    expect(takeInlineResult('ouch')).toBeNull();
    stashInlineResult('ouch', '<article>again</article>');
    clearInlineResult('ouch');
    expect(takeInlineResult('ouch')).toBeNull();
  });
});

describe('buildScoreBody', () => {
  test('a null listing is omitted and false is sent as false', () => {
    const omitted = buildScoreBody('anc.dev', 'tok', { listing: null, refresh: false });
    expect('public_listing' in omitted).toBe(false);
    expect(JSON.stringify(omitted)).not.toContain('public_listing');
    expect(buildScoreBody('anc.dev', 'tok', { listing: false, refresh: false }).public_listing).toBe(false);
    expect(buildScoreBody('anc.dev', 'tok', { listing: true, refresh: false }).public_listing).toBe(true);
  });

  test('refresh rides only when set and the token and target are always present', () => {
    const body = buildScoreBody('ouch', 'tok', { listing: null, refresh: true });
    expect(body).toEqual({ target: 'ouch', turnstile_token: 'tok', refresh: true });
    expect('refresh' in buildScoreBody('ouch', 'tok', { listing: null, refresh: false })).toBe(false);
  });
});

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('startAudit', () => {
  test('two submits before the first resolves issue one acquire and one navigation', async () => {
    const gate = deferred<string>();
    let acquires = 0;
    const navigations: string[] = [];
    const deps = {
      acquire: () => {
        acquires++;
        return gate.promise;
      },
      navigate: (path: string) => navigations.push(path),
    };
    const first = startAudit({ target: 'anc.dev', lane: 'web', listing: true }, deps);
    const second = startAudit({ target: 'anc.dev', lane: 'web', listing: true }, deps);
    gate.resolve('tok');
    await Promise.all([first, second]);
    expect(acquires).toBe(1);
    expect(navigations).toEqual(['/scoring?target=anc.dev']);
  });

  test('negative control: with the guard neutralized the same two submits acquire twice', async () => {
    _resetStartAuditForTests({ guard: false });
    const gate = deferred<string>();
    let acquires = 0;
    const navigations: string[] = [];
    const deps = {
      acquire: () => {
        acquires++;
        return gate.promise;
      },
      navigate: (path: string) => navigations.push(path),
    };
    const first = startAudit({ target: 'anc.dev', lane: 'web', listing: true }, deps);
    const second = startAudit({ target: 'anc.dev', lane: 'web', listing: true }, deps);
    gate.resolve('tok');
    await Promise.all([first, second]);
    expect(acquires).toBe(2);
    expect(navigations).toHaveLength(2);
  });

  test('bound to two controls, one acquire per click and the same progress URL for the same target', async () => {
    let acquires = 0;
    const navigations: string[] = [];
    const deps = { acquire: async () => `tok${++acquires}`, navigate: (path: string) => navigations.push(path) };
    await startAudit({ target: 'https://anc.dev/docs', lane: 'web', listing: null }, deps);
    await startAudit({ target: 'anc.dev', lane: 'web', listing: null }, deps);
    expect(acquires).toBe(2);
    expect(navigations).toEqual(['/scoring?target=anc.dev', '/scoring?target=anc.dev']);
    expect(take('anc.dev')?.token).toBe('tok2');
  });

  test('the click stashes the token, the listing, the entered lane, and the refresh intent under the normalized target', async () => {
    const deps = { acquire: async () => 'tok', navigate: () => {} };
    const result = await startAudit({ target: 'Example.COM:8443', lane: 'cli', listing: false, refresh: true }, deps);
    expect(result).toEqual({ ok: true, target: 'example.com:8443', lane: 'web', entered_lane: 'cli' });
    expect(take('example.com:8443')).toMatchObject({
      token: 'tok',
      listing: false,
      entered_lane: 'cli',
      refresh: true,
    });
  });

  test('a refresh click carries refresh=1 on the progress URL', async () => {
    const navigations: string[] = [];
    await startAudit(
      { target: 'ouch', lane: 'cli', listing: null, refresh: true },
      { acquire: async () => 'tok', navigate: (p) => navigations.push(p) },
    );
    expect(navigations).toEqual(['/scoring?target=ouch&refresh=1']);
  });

  test('a rejected target never acquires', async () => {
    let acquires = 0;
    const result = await startAudit(
      { target: 'o/r@md', lane: 'cli', listing: null },
      { acquire: async () => `tok${++acquires}`, navigate: () => {} },
    );
    expect(result).toMatchObject({ ok: false, reason: 'reserved_branch_segment' });
    expect(acquires).toBe(0);
  });

  test('an acquire failure releases the guard so the next click can try again', async () => {
    const navigations: string[] = [];
    const failing = {
      acquire: async () => {
        throw new Error('turnstile_timeout');
      },
      navigate: (p: string) => navigations.push(p),
    };
    const result = await startAudit({ target: 'ouch', lane: 'cli', listing: null }, failing);
    expect(result).toMatchObject({ ok: false, reason: 'turnstile_failed' });
    const again = await startAudit(
      { target: 'ouch', lane: 'cli', listing: null },
      { acquire: async () => 'tok', navigate: (p) => navigations.push(p) },
    );
    expect(again.ok).toBe(true);
    expect(navigations).toEqual(['/scoring?target=ouch']);
  });
});

describe('acquireTurnstileToken', () => {
  type Rendered = { callback?: (token: string) => void; 'error-callback'?: () => void };
  function fakeApi() {
    const calls = { render: 0, execute: 0, reset: 0, remove: 0 };
    let rendered: Rendered = {};
    const api: TurnstileApi = {
      render: (_el, options) => {
        calls.render++;
        rendered = options;
        return 'w1';
      },
      execute: () => {
        calls.execute++;
      },
      reset: () => {
        calls.reset++;
      },
      remove: () => {
        calls.remove++;
      },
    };
    return { api, calls, settle: (token: string) => rendered.callback?.(token) };
  }
  function fakeHost(): HTMLElement {
    const div = { setAttribute: () => {}, style: {} as CSSStyleDeclaration };
    return {
      ownerDocument: { createElement: () => div },
      appendChild: () => div,
      querySelector: () => null,
    } as unknown as HTMLElement;
  }

  test('the widget is rendered once and reset and re-executed on the next acquire', async () => {
    teardownTurnstile();
    const { api, calls, settle } = fakeApi();
    const host = fakeHost();
    const first = acquireTurnstileToken('key', api, host);
    settle('tok1');
    expect(await first).toBe('tok1');
    const second = acquireTurnstileToken('key', api, host);
    settle('tok2');
    expect(await second).toBe('tok2');
    expect(calls).toEqual({ render: 1, execute: 2, reset: 1, remove: 0 });
    teardownTurnstile();
  });

  test('a second acquire while one is pending is refused', async () => {
    teardownTurnstile();
    const { api, settle } = fakeApi();
    const host = fakeHost();
    const first = acquireTurnstileToken('key', api, host);
    await expect(acquireTurnstileToken('key', api, host)).rejects.toThrow('turnstile_already_pending');
    settle('tok');
    await first;
    teardownTurnstile();
  });
});

describe('review fixtures: stash edges', () => {
  test('a record without a valid entered lane is treated as absent', () => {
    sessionStorage.setItem(
      'audit-stash:x',
      JSON.stringify({ token: 't', ts: Date.now(), entered_lane: 'bogus', refresh: false }),
    );
    expect(take('x')).toBeNull();
  });

  test('an expired or corrupt lane entry is absent and removed', () => {
    sessionStorage.setItem('audit-lane:x', JSON.stringify({ lane: 'web', ts: Date.now() - STASH_TTL_MS - 1 }));
    expect(enteredLaneOf('x')).toBeNull();
    expect(sessionStorage.getItem('audit-lane:x')).toBeNull();
    sessionStorage.setItem('audit-lane:y', 'not json');
    expect(enteredLaneOf('y')).toBeNull();
    expect(sessionStorage.getItem('audit-lane:y')).toBeNull();
  });

  test('the in-flight guard reports in_flight to the second caller', async () => {
    const gate = deferred<string>();
    const deps = { acquire: () => gate.promise, navigate: () => {} };
    const first = startAudit({ target: 'anc.dev', lane: 'web', listing: null }, deps);
    const second = await startAudit({ target: 'anc.dev', lane: 'web', listing: null }, deps);
    expect(second).toMatchObject({ ok: false, reason: 'in_flight' });
    gate.resolve('tok');
    expect((await first).ok).toBe(true);
  });
});

function fakeHost(mount: { current: object | null } = { current: null }, onCreate: () => void = () => {}): HTMLElement {
  return {
    ownerDocument: {
      createElement: () => {
        onCreate();
        mount.current = { setAttribute: () => {}, style: {} };
        return mount.current;
      },
    },
    appendChild: () => {},
    querySelector: () => mount.current,
  } as unknown as HTMLElement;
}

describe('review fixtures: turnstile helper edges', () => {
  test('the first interaction loads the script once and disarms the other listeners', () => {
    const element = new EventTarget();
    const other = new EventTarget();
    loadTurnstileOnFirstInteraction([element, other]);
    let appended = 0;
    const doc = {
      createElement: () => ({ async: false, defer: false, onload: null, onerror: null, src: '' }),
      head: { appendChild: () => appended++ },
    };
    (globalThis as { document?: unknown }).document = doc;
    try {
      element.dispatchEvent(new Event('focus'));
      element.dispatchEvent(new Event('paste'));
      element.dispatchEvent(new Event('click'));
      expect(appended).toBe(1);
      other.dispatchEvent(new Event('click'));
      expect(appended).toBe(1);
    } finally {
      (globalThis as { document?: unknown }).document = undefined;
    }
  });

  test('a torn-down acquire rejects, and the next click can start', async () => {
    teardownTurnstile();
    const never: TurnstileApi = { render: () => 'w', execute: () => {}, reset: () => {}, remove: () => {} };
    const navigations: string[] = [];
    const first = startAudit(
      { target: 'ouch', lane: 'cli', listing: null },
      { acquire: () => acquireTurnstileToken('key', never, fakeHost()), navigate: (p) => navigations.push(p) },
    );
    teardownTurnstile();
    expect(await first).toMatchObject({ ok: false, reason: 'turnstile_failed' });
    const again = await startAudit(
      { target: 'ouch', lane: 'cli', listing: null },
      { acquire: async () => 'tok', navigate: (p) => navigations.push(p) },
    );
    expect(again.ok).toBe(true);
    expect(navigations).toEqual(['/scoring?target=ouch']);
  });

  test('an orphaned mount is reused rather than stacked', async () => {
    teardownTurnstile();
    let created = 0;
    const host = fakeHost({ current: null }, () => created++);
    let settle: (token: string) => void = () => {};
    const api: TurnstileApi = {
      render: (_el, options) => {
        settle = (token) => options.callback?.(token);
        return 'w';
      },
      execute: () => {},
      reset: () => {},
      remove: () => {},
    };
    const first = acquireTurnstileToken('key', api, host);
    settle('t1');
    await first;
    teardownTurnstile();
    const second = acquireTurnstileToken('key', api, host);
    settle('t2');
    await second;
    expect(created).toBe(1);
    teardownTurnstile();
  });

  test('a widget API that throws synchronously does not leave the acquire pending', async () => {
    teardownTurnstile();
    const throwing: TurnstileApi = {
      render: () => {
        throw new Error('render exploded');
      },
      execute: () => {},
      reset: () => {},
      remove: () => {},
    };
    await expect(acquireTurnstileToken('key', throwing, fakeHost())).rejects.toThrow('render exploded');
    const ok: TurnstileApi = {
      render: (_el, o) => {
        queueMicrotask(() => o.callback?.('tok'));
        return 'w';
      },
      execute: () => {},
      reset: () => {},
      remove: () => {},
    };
    expect(await acquireTurnstileToken('key', ok, fakeHost())).toBe('tok');
    teardownTurnstile();
  });
});
