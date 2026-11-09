// workerd treats every named export of a Worker's main module as an
// entrypoint and refuses to start when one is not a class or a handler
// object: "Incorrect type for map entry ... not of type 'function or
// ExportedHandler'". wrangler's dry run, TypeScript and the bun-test shim all
// pass such a module; only the runtime rejects it. The render Worker exports
// its RPC entrypoint as the default and its Durable Object by name.

import { expect, test } from 'bun:test';
import * as renderEntry from '../src/og-render/index';

test('the render Worker entry exports only classes', () => {
  const exported = Object.entries(renderEntry as Record<string, unknown>);
  expect(exported.map(([name]) => name).sort()).toEqual(['RenderJob', 'default']);
  expect(exported.filter(([, value]) => typeof value !== 'function').map(([name]) => name)).toEqual([]);
});
