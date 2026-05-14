// Stub Sandbox DO class for plan U3 wrangler binding registration.
//
// The full implementation (extends the Cloudflare Sandbox SDK, runs the
// two-phase egress + install + anc check flow) lands in U6 with the
// `@cloudflare/sandbox` import. Until then this exists ONLY to satisfy
// `wrangler deploy --dry-run` — the Containers + DurableObjects bindings
// in wrangler.jsonc reference `class_name: "Sandbox"` and wrangler
// resolves that name by reading the Worker's main module exports.
//
// Uses the legacy class-form DO pattern (no `cloudflare:workers` import)
// rather than `extends DurableObject` because Bun's test runtime can't
// resolve the `cloudflare:workers` virtual module — it's a Workers
// runtime-only entry that bundles in via the Worker build, not Bun's
// package resolver. U6 will switch to `extends Sandbox` from
// `@cloudflare/sandbox`, which IS bun-resolvable as a real npm package.
//
// Calling any RPC method before U6 lands returns a typed error so the
// surfacing is loud rather than silent if something accidentally hits
// the binding early (e.g. a misrouted handler, a leaked staging URL).

export class Sandbox {
  // biome-ignore lint/complexity/noUselessConstructor: stub signature mirrors the runtime DO contract that U6 will fill in
  constructor(_state: DurableObjectState, _env: unknown) {}

  async score(): Promise<{ error: string }> {
    return { error: 'sandbox_stub_until_u6' };
  }
}
