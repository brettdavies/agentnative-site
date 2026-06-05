// MCP resource registry — one concrete + four templates per R4 of the
// plan:
//
//   resources/list (concrete):
//     anc://registry                full denormalized catalog
//
//   resources/templates/list (parameterized URIs the client substitutes):
//     anc://tool/{slug}             single registry entry
//     anc://principle/{n}           single principle record
//     anc://spec/{section}          single spec section
//     anc://scorecard/{binary}      cached scorecard by binary slug
//
// Templates intentionally do NOT supply a `list:` callback (enumeration
// inflates the spec's concrete/parameterized distinction and is not
// load-bearing).
//
// Per MCP spec 2025-06-18 resources/read semantics, a missing resource
// surfaces via a JSON-RPC -32002 error envelope rather than the tool
// surface's isError: false typed-state body. The SDK wraps a thrown
// error from the resource handler into that shape; throwing the
// ResourceNotFound-shaped error here is the spec-correct signal.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Catalog } from './catalog';

function jsonText(uri: URL, value: unknown) {
  return {
    contents: [
      {
        uri: uri.toString(),
        mimeType: 'application/json',
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

function notFound(uri: URL, kind: string, key: string): never {
  // SDK maps a thrown Error into a JSON-RPC -32002 Resource not found
  // envelope per MCP spec 2025-06-18.
  const message = `${kind} not found: ${key}`;
  const err = new Error(message);
  // Tag for SDK / tests that introspect the error code.
  (err as Error & { code?: number; uri?: string }).code = -32002;
  (err as Error & { code?: number; uri?: string }).uri = uri.toString();
  throw err;
}

export function registerResources(server: McpServer, catalog: Catalog): void {
  server.resource(
    'registry',
    'anc://registry',
    {
      title: 'anc.dev scored CLI registry',
      description: 'Full denormalized catalog: every scored CLI plus its registry projection.',
      mimeType: 'application/json',
    },
    async (uri) => jsonText(uri, catalog.registry),
  );

  server.resource(
    'tool',
    new ResourceTemplate('anc://tool/{slug}', { list: undefined }),
    {
      title: 'Single registry entry',
      description: 'Full registry record for one CLI, keyed by slug.',
      mimeType: 'application/json',
    },
    async (uri, variables) => {
      const slug = String(variables.slug ?? '');
      const entry = catalog.registry.find((e) => e.slug === slug);
      if (!entry) return notFound(uri, 'tool', slug);
      return jsonText(uri, entry);
    },
  );

  server.resource(
    'principle',
    new ResourceTemplate('anc://principle/{n}', { list: undefined }),
    {
      title: 'Single principle',
      description: 'Full principle record (body plus MUST/SHOULD/MAY requirements), keyed by ordinal n.',
      mimeType: 'application/json',
    },
    async (uri, variables) => {
      const n = Number(variables.n);
      if (!Number.isFinite(n)) return notFound(uri, 'principle', String(variables.n));
      const principle = catalog.principles.find((p) => p.n === n);
      if (!principle) return notFound(uri, 'principle', String(n));
      return jsonText(uri, principle);
    },
  );

  server.resource(
    'spec',
    new ResourceTemplate('anc://spec/{section}', { list: undefined }),
    {
      title: 'Single spec section',
      description: 'Full vendored-spec section body, keyed by slug.',
      mimeType: 'application/json',
    },
    async (uri, variables) => {
      const slug = String(variables.section ?? '');
      const section = catalog.spec_sections.find((s) => s.slug === slug);
      if (!section) return notFound(uri, 'spec section', slug);
      return jsonText(uri, { ...section, spec_version: catalog.spec_version });
    },
  );

  server.resource(
    'scorecard',
    new ResourceTemplate('anc://scorecard/{binary}', { list: undefined }),
    {
      title: 'Cached scorecard',
      description:
        'Registry-projected scorecard summary by binary slug. The full scorecard JSON sits under scorecard_url; ' +
        'this resource returns the registry entry shape so an agent can decide whether to follow the link.',
      mimeType: 'application/json',
    },
    async (uri, variables) => {
      const binary = String(variables.binary ?? '');
      const entry = catalog.registry.find((e) => e.binary === binary || e.slug === binary);
      if (!entry) return notFound(uri, 'scorecard', binary);
      return jsonText(uri, entry);
    },
  );
}
