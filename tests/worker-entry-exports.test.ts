// Worker entry export contract tests.
//
// The CF Sandbox / Containers SDK enforces several runtime contracts on
// the Worker entry's named exports. The exports are looked up via
// `ctx.exports.<Name>` at request time; missing or misnamed exports
// throw with messages like:
//
//   "ctx.exports.ContainerProxy is undefined, export ContainerProxy from
//    the containers package in your worker entrypoint"
//   "Received a FetchEvent but we lack a handler for FetchEvents. Did you
//    remember to export a fetch() function?"
//   "Handler does not export a fetch() function" (Cloudflare error 1101)
//
// All three surface only on the first request hitting the affected code
// path in a deployed Worker. `wrangler deploy --dry-run`, the bun-test
// `cloudflare:workers` shim, and TypeScript compilation all pass. This
// is the same class of failure as:
//
//   - PR #93 / PR #94 — DO `fetch()` missing on the Sandbox class
//   - This commit — `ContainerProxy` missing from the Worker entry
//
// Each of those incidents cost a deploy + a hotfix. This file guards the
// floor: assert every export the SDK looks up by name actually exists on
// the Worker entry module. New SDK contract additions get added here as
// they're discovered, gated on the property that triggers the contract.

import { describe, expect, test } from 'bun:test';
import * as workerEntry from '../src/worker/index';

describe('Worker entry — named export contract for CF Sandbox / Containers SDK', () => {
  test('exports `Sandbox` class for the DurableObject + Container binding lookup', () => {
    // wrangler.jsonc references `class_name: "Sandbox"` in both the
    // `containers[]` and `durable_objects.bindings[]` blocks. Wrangler
    // resolves that name via the Worker entry's exports at deploy time.
    // Missing the export prevents wrangler deploy from completing.
    expect(workerEntry.Sandbox).toBeDefined();
    expect(typeof workerEntry.Sandbox).toBe('function');
  });

  test('exports `ContainerProxy` whenever any Sandbox subclass declares outbound handlers', () => {
    // The CF Containers SDK looks up `ctx.exports.ContainerProxy` at
    // outbound-handler dispatch time. Required whenever the Worker
    // declares `outboundHandlers`, `outboundByHost`, or `outbound` on
    // a Sandbox/Container subclass — i.e. any code path that calls
    // `setOutboundHandler` / `setOutboundByHost` at runtime. Setting
    // any of these without exporting ContainerProxy throws on the
    // first DO fetch in production.
    //
    // The contract gate is two-pronged: if any Sandbox subclass on
    // this entry declares any outbound-related static property, then
    // ContainerProxy MUST be exported. The test fails if a future
    // refactor introduces another Sandbox subclass with outbound
    // handlers but forgets the ContainerProxy re-export.
    type SandboxClass = {
      outboundHandlers?: unknown;
      outboundByHost?: unknown;
      outbound?: unknown;
    };
    const sandboxClass = workerEntry.Sandbox as unknown as SandboxClass;
    const declaresOutbound =
      sandboxClass.outboundHandlers !== undefined ||
      sandboxClass.outboundByHost !== undefined ||
      sandboxClass.outbound !== undefined;

    if (declaresOutbound) {
      expect(
        (workerEntry as Record<string, unknown>).ContainerProxy,
        'Sandbox declares outbound handlers; ContainerProxy MUST be re-exported from src/worker/index.ts',
      ).toBeDefined();
      expect(typeof (workerEntry as Record<string, unknown>).ContainerProxy).toBe('function');
    }
  });

  test('every named runtime export is a handler/DO class — no plain-value exports', () => {
    // workerd validates the entry module's named exports when the Worker
    // has Durable Object / Container bindings: every named runtime export
    // must be a function (a DO/Container class or an entrypoint). A plain
    // `export const` string/Set/object fails local `wrangler dev` boot with
    // "Incorrect type for map entry '<Name>': the provided value is not of
    // type 'function or ExportedHandler'". Type-only exports (interfaces)
    // are erased and never appear here; `default` is the ExportedHandler
    // object and is exempt.
    for (const [name, value] of Object.entries(workerEntry)) {
      if (name === 'default') continue;
      expect(
        typeof value,
        `Worker entry export "${name}" must be a function (DO/Container class), not a plain value`,
      ).toBe('function');
    }
  });

  test('Sandbox class exposes the entry methods the binding contract requires', () => {
    // Defends against the PR #93 / PR #94 class: the DO is invoked via
    // `stub.fetch(...)` from the Worker handler, so the Sandbox class
    // MUST export a `fetch()` method. Missing it produces Cloudflare
    // error 1101 ("Handler does not export a fetch() function") on the
    // first request. The score-handler.test.ts mock catches this at
    // type level via `Sandbox['fetch']`; this assertion catches it
    // structurally so a refactor that loses the prototype binding
    // (e.g., switching from class syntax to a factory) still fails.
    const proto = (workerEntry.Sandbox as unknown as { prototype: Record<string, unknown> }).prototype;
    expect(typeof proto.fetch).toBe('function');
  });
});
