// The Re-audit control on a result page is the entry form's submit under
// another name: the same transact click, the same stash, the same progress
// URL. What differs is the gate in front of it. A website control counts
// down to refresh_after from an absolute timestamp so an edge-cached copy
// still counts correctly, and its click is a no-op until then; a live CLI
// or branch control is enabled at bind and its click carries refresh: true.

import { describe, expect, test } from 'bun:test';
import type { StartAuditInput, StartAuditResult } from '../src/client/audit-start';
import {
  bindReaudit,
  dropVersionQuery,
  initReaudit,
  type ReauditControl,
  type ReauditDeps,
} from '../src/client/reaudit';

type Attrs = Record<string, string>;

function fakeControl(attrs: Attrs) {
  const map = new Map(Object.entries(attrs));
  const span = { textContent: map.has('data-refresh-after') ? ' in 42 s' : null };
  const control: ReauditControl = Object.assign(new EventTarget(), {
    getAttribute: (name: string) => map.get(name) ?? null,
    setAttribute: (name: string, value: string) => {
      map.set(name, value);
    },
    removeAttribute: (name: string) => {
      map.delete(name);
    },
    querySelector: (selectors: string) => (selectors === '[data-reaudit-countdown]' ? span : null),
  });
  return { control, attrs: map, span };
}

function fakeDeps(nowMs: number) {
  const clock = { now: nowMs };
  const intervals: Array<{ tick: () => void; ms: number }> = [];
  const cleared: number[] = [];
  const starts: StartAuditInput[] = [];
  const navigations: string[] = [];
  const armed: EventTarget[] = [];
  const reports: string[] = [];
  let outcome: StartAuditResult | null = null;
  const deps: ReauditDeps = {
    startAudit: async (input: StartAuditInput): Promise<StartAuditResult> => {
      starts.push(input);
      if (outcome) return outcome;
      navigations.push(`/scoring?target=${input.target}${input.refresh ? '&refresh=1' : ''}`);
      return { ok: true, target: input.target, lane: input.lane, entered_lane: input.lane };
    },
    report: (message: string) => {
      reports.push(message);
    },
    now: () => clock.now,
    setInterval: (tick: () => void, ms: number) => {
      intervals.push({ tick, ms });
      return 7;
    },
    clearInterval: (handle: number) => {
      cleared.push(handle);
    },
    loadTurnstileOnFirstInteraction: (elements: Iterable<EventTarget>) => {
      armed.push(...elements);
    },
  };
  return {
    deps,
    clock,
    intervals,
    cleared,
    starts,
    navigations,
    armed,
    reports,
    fail: (o: StartAuditResult) => {
      outcome = o;
    },
  };
}

const WEB = { 'data-target': 'anc.dev', 'data-lane': 'web', 'aria-disabled': 'true' };
const T0 = Date.parse('2026-09-11T00:09:18.000Z');
const REFRESH_AFTER = '2026-09-11T00:10:00.000Z';

function click(control: EventTarget): Event {
  const event = new Event('click', { cancelable: true });
  control.dispatchEvent(event);
  return event;
}

describe('bindReaudit: website control before refresh_after', () => {
  test('stays aria-disabled and the countdown reads whole seconds, ceiled, on a one-second tick', () => {
    const { control, attrs, span } = fakeControl({ ...WEB, 'data-refresh-after': REFRESH_AFTER });
    const f = fakeDeps(T0 - 400);
    bindReaudit(control, f.deps);
    expect(attrs.get('aria-disabled')).toBe('true');
    expect(span.textContent).toBe(' in 43 s');
    expect(f.intervals).toHaveLength(1);
    expect(f.intervals[0].ms).toBe(1000);
    f.clock.now = T0 + 600;
    f.intervals[0].tick();
    expect(span.textContent).toBe(' in 42 s');
    expect(attrs.get('aria-disabled')).toBe('true');
  });

  test('a click before refresh_after calls neither startAudit nor navigation', () => {
    const { control, attrs } = fakeControl({ ...WEB, 'data-refresh-after': REFRESH_AFTER });
    const f = fakeDeps(T0);
    bindReaudit(control, f.deps);
    const event = click(control);
    expect(event.defaultPrevented).toBe(true);
    expect(f.starts).toEqual([]);
    expect(f.navigations).toEqual([]);
    expect(attrs.get('aria-disabled')).toBe('true');
  });

  test('the tick at refresh_after enables the control, clears the countdown, and stops the interval', () => {
    const { control, attrs, span } = fakeControl({ ...WEB, 'data-refresh-after': REFRESH_AFTER });
    const f = fakeDeps(T0);
    bindReaudit(control, f.deps);
    f.clock.now = Date.parse(REFRESH_AFTER);
    f.intervals[0].tick();
    expect(attrs.has('aria-disabled')).toBe(false);
    expect(span.textContent).toBe('');
    expect(f.cleared).toEqual([7]);
    expect(attrs.has('disabled')).toBe(false);
  });

  test('a click after refresh_after starts the audit for the web target with no refresh key', () => {
    const { control } = fakeControl({ ...WEB, 'data-refresh-after': REFRESH_AFTER });
    const f = fakeDeps(T0);
    bindReaudit(control, f.deps);
    f.clock.now = Date.parse(REFRESH_AFTER) + 1;
    f.intervals[0].tick();
    const event = click(control);
    expect(event.defaultPrevented).toBe(true);
    expect(f.starts).toEqual([{ target: 'anc.dev', lane: 'web', listing: null }]);
    expect('refresh' in f.starts[0]).toBe(false);
    expect(f.navigations).toEqual(['/scoring?target=anc.dev']);
  });
});

describe('bindReaudit: live CLI and branch controls', () => {
  test('a control without refresh_after is enabled at bind, never ticks, and its click sends refresh: true', () => {
    const { control, attrs } = fakeControl({ 'data-target': 'ouch', 'data-lane': 'cli', 'data-refresh': '1' });
    const f = fakeDeps(T0);
    bindReaudit(control, f.deps);
    expect(attrs.has('aria-disabled')).toBe(false);
    expect(f.intervals).toEqual([]);
    click(control);
    expect(f.starts).toEqual([{ target: 'ouch', lane: 'cli', listing: null, refresh: true }]);
    expect(f.navigations).toEqual(['/scoring?target=ouch&refresh=1']);
  });

  test('a branch control sends the owner/repo@branch target with refresh: true', () => {
    const { control } = fakeControl({ 'data-target': 'acme/tool@main', 'data-lane': 'cli', 'data-refresh': '1' });
    const f = fakeDeps(T0);
    bindReaudit(control, f.deps);
    click(control);
    expect(f.starts).toEqual([{ target: 'acme/tool@main', lane: 'cli', listing: null, refresh: true }]);
  });
});

describe('bindReaudit: wiring and inert controls', () => {
  test('binding arms the Turnstile prefetch on the control', () => {
    const { control } = fakeControl({ 'data-target': 'ouch', 'data-lane': 'cli', 'data-refresh': '1' });
    const f = fakeDeps(T0);
    bindReaudit(control, f.deps);
    expect(f.armed).toEqual([control]);
  });

  test('a control with no target or an unknown lane is left inert without throwing', () => {
    const cases: Attrs[] = [{ 'data-lane': 'web' }, { 'data-target': 'anc.dev', 'data-lane': 'bogus' }];
    for (const attrs of cases) {
      const { control } = fakeControl({ ...attrs, 'data-refresh-after': REFRESH_AFTER });
      const f = fakeDeps(T0);
      expect(() => bindReaudit(control, f.deps)).not.toThrow();
      click(control);
      expect(f.starts).toEqual([]);
      expect(f.intervals).toEqual([]);
      expect(f.armed).toEqual([]);
    }
  });
});

type Globals = { location?: unknown; history?: unknown; document?: unknown };

function withGlobals<T>(values: Globals, run: () => T): T {
  const holder = globalThis as Globals;
  const saved: Globals = { location: holder.location, history: holder.history, document: holder.document };
  Object.assign(holder, values);
  try {
    return run();
  } finally {
    Object.assign(holder, saved);
  }
}

describe('on load', () => {
  test('a ?v= query is replaced with the bare pathname', () => {
    const replaced: Array<[unknown, string, string | URL | null | undefined]> = [];
    withGlobals(
      {
        location: { pathname: '/score/anc.dev', search: '?v=2026-09-10T12%3A00%3A00.000Z' },
        history: { replaceState: (...args: [unknown, string, string | URL | null | undefined]) => replaced.push(args) },
      },
      () => dropVersionQuery(),
    );
    expect(replaced).toHaveLength(1);
    expect(replaced[0][2]).toBe('/score/anc.dev');
  });

  test('a URL without v is left alone and a page without controls binds nothing', () => {
    const replaced: unknown[] = [];
    let queried = 0;
    withGlobals(
      {
        location: { pathname: '/score/anc.dev', search: '' },
        history: { replaceState: (...args: unknown[]) => replaced.push(args) },
        document: {
          querySelectorAll: () => {
            queried++;
            return [];
          },
        },
      },
      () => initReaudit(),
    );
    expect(replaced).toEqual([]);
    expect(queried).toBe(1);
  });
});

describe('bindReaudit: a failed start is reported', () => {
  test('a click whose startAudit answers ok: false reports the message and clears it on the next attempt', async () => {
    const { control } = fakeControl({ 'data-target': 'ouch', 'data-lane': 'cli', 'data-refresh': '1' });
    const fake = fakeDeps(T0);
    bindReaudit(control, fake.deps);
    fake.fail({ ok: false, reason: 'turnstile_failed', message: 'Verification failed. Please try again.' });
    click(control);
    await Promise.resolve();
    await Promise.resolve();
    expect(fake.reports).toEqual(['Verification failed. Please try again.']);
    fake.fail(null as unknown as StartAuditResult);
    click(control);
    await Promise.resolve();
    await Promise.resolve();
    expect(fake.reports).toEqual(['Verification failed. Please try again.', '']);
    expect(fake.navigations).toHaveLength(1);
  });
});
