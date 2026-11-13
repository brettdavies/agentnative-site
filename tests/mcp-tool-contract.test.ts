// The contract every tool in the served tools/list must meet. Each rule reads
// the live list, never a pinned name, so a tool added later is held to it
// without touching this file. Every test collects one "rule N: <tool>: ..."
// line per breach and ends on an empty list, so one failing run names every
// tool that breaks the rule.

import { beforeAll, describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MCP_ALLOWED_HOSTNAMES, type McpEnv } from '../src/worker/mcp/server';
import { SPEC_VERSION } from '../src/worker/spec-version.gen';
import {
  modernToolCallBody,
  modernToolCallHeaders,
  modernToolsListBody,
  modernToolsListHeaders,
} from './helpers/mcp-modern';
import { CANONICAL_TEST_ORIGIN, mcpRpcExpect200, resetMcpTestState } from './helpers/mcp-rpc';
import { EXPECTED_TOOL_ANNOTATIONS } from './helpers/mcp-tools';

interface SchemaProperty {
  type?: string;
  enum?: unknown[];
  minimum?: number;
  description?: unknown;
}

interface InputSchema {
  properties?: Record<string, SchemaProperty>;
  required?: string[];
  additionalProperties?: unknown;
}

interface ListedTool {
  name: string;
  annotations?: Record<string, unknown>;
  inputSchema?: InputSchema;
  outputSchema?: unknown;
}

const HINTS = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const;

// MCP 2026-07-28, "Tool Names" (https://modelcontextprotocol.io/specification/2026-07-28/server/tools#tool-names):
// "Tool names SHOULD be between 1 and 128 characters in length (inclusive)." and "The following SHOULD be the only
// allowed characters: uppercase and lowercase ASCII letters (A-Z, a-z), digits (0-9), underscore (_), hyphen (-), and
// dot (.)".
const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;

// Compact JSON bytes of the tools array. Sized to hold the declared tools plus the outputSchema declarations rule 7
// still lists as pending.
const TOOLS_LIST_BYTE_BUDGET = 36_864;

// Tools that do not yet declare an outputSchema. A tool leaves this list in the change that adds its schema; the list
// is empty once every tool declares one.
const OUTPUT_SCHEMA_PENDING: readonly string[] = [
  'list_tools',
  'get_tool',
  'search_tools',
  'list_principles',
  'get_principle',
  'list_spec_sections',
  'get_spec_section',
  'get_scorecard',
  'score_cli',
  'get_website_audit',
  'audit_website',
  'list_website_audits',
  'set_website_public_listing',
  'get_web_remediation',
];

const PROBE_KEY = 'contract_probe_undeclared';

function envWithEmptyCatalog(): McpEnv {
  const catalog = {
    generated_at: '2026-01-01T00:00:00.000Z',
    spec_version: SPEC_VERSION,
    registry: [],
    principles: [],
    spec_sections: [],
  };
  return {
    ASSETS: {
      fetch(req: Request) {
        const found = new URL(req.url).pathname === '/_internal/mcp-catalog.json';
        return Promise.resolve(found ? Response.json(catalog) : new Response('not found', { status: 404 }));
      },
    } as unknown as Fetcher,
  } as McpEnv;
}

async function listTools(origin: string): Promise<ListedTool[]> {
  resetMcpTestState();
  const body = await mcpRpcExpect200(envWithEmptyCatalog(), modernToolsListBody(), modernToolsListHeaders(), {
    origin,
  });
  return (body.result?.tools ?? []) as ListedTool[];
}

/** A value the schema accepts for a required property, or undefined when the schema is not one this builder reads. */
function minimalValue(property: SchemaProperty): unknown {
  if (property.enum !== undefined) return property.enum[0];
  if (property.type === 'string') return 'x';
  if (property.type === 'boolean') return false;
  if (property.type === 'integer' || property.type === 'number') return property.minimum ?? 0;
  return undefined;
}

function minimalArguments(tool: ListedTool): { args: Record<string, unknown>; unbuilt: string[] } {
  const args: Record<string, unknown> = {};
  const unbuilt: string[] = [];
  for (const key of tool.inputSchema?.required ?? []) {
    const value = minimalValue(tool.inputSchema?.properties?.[key] ?? {});
    if (value === undefined) unbuilt.push(key);
    else args[key] = value;
  }
  return { args, unbuilt };
}

function sortedEntries(value: Record<string, unknown> | undefined): string {
  return JSON.stringify(Object.entries(value ?? {}).sort(([a], [b]) => a.localeCompare(b)));
}

let tools: ListedTool[] = [];

beforeAll(async () => {
  tools = await listTools(CANONICAL_TEST_ORIGIN);
});

describe('MCP tool contract: every served tool', () => {
  test('serves at least one tool', () => {
    expect(tools.length).toBeGreaterThan(0);
  });

  test('rule 1: declares all four behavior hints as booleans, matching the recorded set', () => {
    const violations: string[] = [];
    for (const tool of tools) {
      for (const hint of HINTS) {
        if (typeof tool.annotations?.[hint] !== 'boolean') {
          violations.push(`rule 1: ${tool.name}: ${hint} is ${typeof tool.annotations?.[hint]}, not a boolean`);
        }
      }
      const recorded = (EXPECTED_TOOL_ANNOTATIONS as Record<string, Record<string, boolean>>)[tool.name];
      if (recorded === undefined) {
        violations.push(`rule 1: ${tool.name}: no entry in EXPECTED_TOOL_ANNOTATIONS (tests/helpers/mcp-tools.ts)`);
      } else if (sortedEntries(tool.annotations) !== sortedEntries(recorded)) {
        violations.push(
          `rule 1: ${tool.name}: serves ${JSON.stringify(tool.annotations)}, recorded ${JSON.stringify(recorded)}`,
        );
      }
    }
    expect(violations).toEqual([]);
  });

  test('rule 2: advertises additionalProperties: false and refuses an undeclared argument before the handler runs', async () => {
    const violations: string[] = [];
    for (const tool of tools) {
      if (tool.inputSchema?.additionalProperties !== false) {
        violations.push(
          `rule 2: ${tool.name}: inputSchema.additionalProperties is ${JSON.stringify(tool.inputSchema?.additionalProperties)}, not false; register the input with z.strictObject`,
        );
      }
      const { args, unbuilt } = minimalArguments(tool);
      if (unbuilt.length > 0) {
        violations.push(
          `rule 2: ${tool.name}: no minimal value for required ${unbuilt.join(', ')}; extend minimalValue() for its type`,
        );
        continue;
      }
      resetMcpTestState();
      const body = await mcpRpcExpect200(
        envWithEmptyCatalog(),
        modernToolCallBody(tool.name, { ...args, [PROBE_KEY]: 1 }),
        modernToolCallHeaders(tool.name),
      );
      const text = (body.result?.content ?? []).map((block) => block.text).join('\n');
      const refused =
        body.result?.isError === true && text.includes('Input validation error') && text.includes(PROBE_KEY);
      if (!refused) {
        violations.push(
          `rule 2: ${tool.name}: an undeclared "${PROBE_KEY}" was not refused by input validation (isError ${String(body.result?.isError)}): ${text.slice(0, 120)}`,
        );
      }
    }
    expect(violations).toEqual([]);
  });

  test('rule 3: every input property carries a non-empty description', () => {
    const violations: string[] = [];
    for (const tool of tools) {
      for (const [key, property] of Object.entries(tool.inputSchema?.properties ?? {})) {
        if (typeof property.description !== 'string' || property.description.trim() === '') {
          violations.push(`rule 3: ${tool.name}: property ${key} has no description`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  test('rule 4: the name fits the spec rule for tool names', () => {
    const violations = tools
      .filter((tool) => !TOOL_NAME.test(tool.name))
      .map((tool) => `rule 4: ${tool.name}: not 1-128 characters of A-Z a-z 0-9 _ - .`);
    expect(violations).toEqual([]);
  });

  test('rule 5: the tools array stays under the byte budget at the longest allowed origin', async () => {
    const longest = MCP_ALLOWED_HOSTNAMES.reduce((a, b) => (b.length > a.length ? b : a));
    const served = await listTools(`https://${longest}:65535`);
    const bytes = new TextEncoder().encode(JSON.stringify(served)).length;
    expect({ rule: 'rule 5', bytes, budget: TOOLS_LIST_BYTE_BUDGET, over: bytes > TOOLS_LIST_BYTE_BUDGET }).toEqual({
      rule: 'rule 5',
      bytes,
      budget: TOOLS_LIST_BYTE_BUDGET,
      over: false,
    });
  });

  test('rule 6: content/mcp-skill.md names the tool', async () => {
    const guide = await readFile(join(import.meta.dir, '..', 'content/mcp-skill.md'), 'utf8');
    const violations = tools
      .filter(
        (tool) => !new RegExp(`(?<![A-Za-z0-9_.-])${tool.name.replaceAll('.', '\\.')}(?![A-Za-z0-9_.-])`).test(guide),
      )
      .map((tool) => `rule 6: ${tool.name}: content/mcp-skill.md never names it`);
    expect(violations).toEqual([]);
  });

  test('rule 7: declares an outputSchema unless it is on the pending list, and a pending tool declares none', () => {
    const served = new Set(tools.map((tool) => tool.name));
    const violations: string[] = [];
    for (const tool of tools) {
      const pending = OUTPUT_SCHEMA_PENDING.includes(tool.name);
      const declared = tool.outputSchema !== undefined;
      if (!pending && !declared)
        violations.push(`rule 7: ${tool.name}: declares no outputSchema and is not on OUTPUT_SCHEMA_PENDING`);
      if (pending && declared)
        violations.push(`rule 7: ${tool.name}: declares an outputSchema; remove it from the pending list`);
    }
    for (const name of OUTPUT_SCHEMA_PENDING) {
      if (!served.has(name)) violations.push(`rule 7: ${name}: on the pending list but not served`);
    }
    expect(violations).toEqual([]);
  });
});
