// Request-context tests: the ambient store entered inside `Cached.fetch`
// must read back several layers deep without threading, must not leak
// between concurrently suspended requests, and must read undefined
// outside any request scope. The leak contrast is asserted against a
// module-level variable under the same forced interleave, because without
// the suspension between write and read the two designs are
// indistinguishable and the contrast proves nothing.

import { describe, expect, test } from 'bun:test';
import { type AmbientFields, getRequestContext, runWithRequestContext } from '../src/worker/telemetry/request-context';

async function layerThree(): Promise<AmbientFields | undefined> {
  await Promise.resolve();
  return getRequestContext();
}

async function layerTwo(): Promise<AmbientFields | undefined> {
  await Promise.resolve();
  return layerThree();
}

async function layerOne(): Promise<AmbientFields | undefined> {
  await Promise.resolve();
  return layerTwo();
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// The design the store replaces: one variable per isolate, written at
// request entry and read at emit time.
let moduleLevelProbe: string | undefined;

async function leakyRequest(value: string, gate: Promise<void>): Promise<string | undefined> {
  moduleLevelProbe = value;
  await gate;
  return moduleLevelProbe;
}

async function isolatedRequest(value: string, gate: Promise<void>): Promise<string | undefined> {
  return runWithRequestContext({ probe: value }, async () => {
    await gate;
    return getRequestContext()?.probe as string | undefined;
  });
}

describe('request context', () => {
  test('a value set where the scope is entered reads back three async layers deep with no threading', async () => {
    const seen = await runWithRequestContext({ probe: 'deep' }, () => layerOne());
    expect(seen).toEqual({ probe: 'deep' });
  });

  test('a module-level variable leaks under a forced interleave: A reads B', async () => {
    const gateA = deferred();
    const a = leakyRequest('A', gateA.promise);
    const b = await leakyRequest('B', Promise.resolve());
    gateA.resolve();
    expect(b).toBe('B');
    expect(await a).toBe('B');
  });

  test('the store keeps A while B writes in the gap under the same interleave', async () => {
    const gateA = deferred();
    const a = isolatedRequest('A', gateA.promise);
    const b = await isolatedRequest('B', Promise.resolve());
    gateA.resolve();
    expect(b).toBe('B');
    expect(await a).toBe('A');
  });

  test('a read outside any request scope returns undefined rather than throwing', () => {
    expect(getRequestContext()).toBeUndefined();
  });

  test('the scope ends with its callback: a read after the run returns undefined', async () => {
    await runWithRequestContext({ probe: 'scoped' }, async () => {
      await Promise.resolve();
    });
    expect(getRequestContext()).toBeUndefined();
  });
});
