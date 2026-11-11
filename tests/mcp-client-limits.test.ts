// Client limits on MCP server metadata: the records in
// src/worker/mcp/client-limits.ts, and a guard that reads the strings the
// server sends and fails when one breaks a recorded limit.

import { beforeAll, describe, expect, test } from 'bun:test';
import { compareVersions } from '../src/build/scorecards.mjs';
import { FOLLOW_DISCLOSURE_SHORT } from '../src/worker/audit-web/follow-disclosure';
import {
  budgetLimits,
  CLIENT_LIMITS,
  type ClientLimit,
  criticalLimits,
  leadLimits,
  type MetadataSurface,
  measure,
} from '../src/worker/mcp/client-limits';
import { MCP_ALLOWED_HOSTNAMES, type McpEnv } from '../src/worker/mcp/server';
import { SPEC_VERSION } from '../src/worker/spec-version.gen';
import {
  modernServerDiscoverBody,
  modernServerDiscoverHeaders,
  modernToolsListBody,
  modernToolsListHeaders,
} from './helpers/mcp-modern';
import { mcpInitialize, mcpRpcExpect200, resetMcpTestState } from './helpers/mcp-rpc';
import { EXPECTED_TOOL_NAMES } from './helpers/mcp-tools';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const ids = (limits: readonly ClientLimit[]): string[] => limits.map((limit) => limit.id);

describe('client limit records', () => {
  test('every record has a unique id, a source with a quote and a read date, and a url or description', () => {
    expect(new Set(ids(CLIENT_LIMITS)).size).toBe(CLIENT_LIMITS.length);
    for (const limit of CLIENT_LIMITS) {
      expect(limit.sources.length).toBeGreaterThan(0);
      for (const source of limit.sources) {
        expect(Boolean(source.url) || Boolean(source.described)).toBe(true);
        expect(source.quote.trim().length).toBeGreaterThan(0);
        expect(source.readOn).toMatch(ISO_DATE);
        expect(Number.isNaN(Date.parse(source.readOn))).toBe(false);
      }
    }
  });

  test('every record applies to at least one surface and carries a positive value', () => {
    for (const limit of CLIENT_LIMITS) {
      expect(limit.appliesTo.length).toBeGreaterThan(0);
      expect(limit.value).toBeGreaterThan(0);
    }
  });

  test('fromVersion sorts before untilVersion on every record that has both', () => {
    for (const limit of CLIENT_LIMITS) {
      if (limit.fromVersion !== null && limit.untilVersion !== null) {
        expect(compareVersions(limit.fromVersion, limit.untilVersion)).toBeLessThan(0);
      }
    }
  });

  test('a replaced limit keeps its record: the 2048 cut ends where the 4096 cut starts', () => {
    const replaced = CLIENT_LIMITS.find((limit) => limit.id === 'claude-code-upfront-2048');
    const current = CLIENT_LIMITS.find((limit) => limit.id === 'claude-code-upfront-4096');
    expect(replaced?.untilVersion).toBe(current?.fromVersion);
  });
});

describe('measure', () => {
  test('counts an em-dash as 1 character and 3 bytes', () => {
    const text = 'a—b';
    expect(measure(text, 'characters')).toBe(3);
    expect(measure(text, 'utf8-bytes')).toBe(5);
  });

  test('counts an astral character as 2 characters and 4 bytes', () => {
    const text = '\u{1F600}';
    expect(measure(text, 'characters')).toBe(2);
    expect(measure(text, 'utf8-bytes')).toBe(4);
  });

  test('counts ASCII as one of each', () => {
    expect(measure('abc', 'characters')).toBe(3);
    expect(measure('abc', 'utf8-bytes')).toBe(3);
  });
});

describe('limit selectors', () => {
  test('the instructions budget is the current cut and nothing that has ended or only warns', () => {
    const budget = ids(budgetLimits('server-instructions'));
    expect(budget).toContain('claude-code-upfront-4096');
    for (const excluded of ['claude-code-all-2048', 'claude-code-upfront-2048', 'tool-registry-check-2048']) {
      expect(budget).not.toContain(excluded);
    }
  });

  test('the instructions critical window is the ended cuts and the warning', () => {
    const critical = ids(criticalLimits('server-instructions'));
    for (const included of ['claude-code-all-2048', 'claude-code-upfront-2048', 'tool-registry-check-2048']) {
      expect(critical).toContain(included);
    }
    expect(critical).not.toContain('claude-code-upfront-4096');
  });

  test('the instructions lead selector returns the lead record', () => {
    expect(ids(leadLimits('server-instructions'))).toContain('chatgpt-codex-lead-512');
  });

  test('a tool description is budgeted per surface: upfront at the current cut, tool search at its own', () => {
    expect(ids(budgetLimits('tool-description-upfront'))).toEqual(['claude-code-upfront-4096']);
    expect(ids(budgetLimits('tool-description-tool-search'))).toEqual(['claude-code-tool-search-16384']);
  });

  test('every surface has a budget and a critical window', () => {
    const surfaces: MetadataSurface[] = [
      'server-instructions',
      'tool-description-upfront',
      'tool-description-tool-search',
    ];
    for (const surface of surfaces) {
      expect(budgetLimits(surface).length).toBeGreaterThan(0);
      expect(criticalLimits(surface).length).toBeGreaterThan(0);
    }
  });

  test('no selector returns a record for a surface it does not apply to', () => {
    for (const limit of budgetLimits('tool-description-tool-search')) {
      expect(limit.appliesTo).toContain('tool-description-tool-search');
    }
    expect(leadLimits('tool-description-upfront')).toEqual([]);
  });
});

const NEXT_STEP =
  'Next step: shorten it, or move a fact it carries to content/mcp-skill.md; the limits and their sources are in src/worker/mcp/client-limits.ts';

const TOOL_DESCRIPTION_SURFACES: readonly MetadataSurface[] = [
  'tool-description-upfront',
  'tool-description-tool-search',
];

// The Host check strips the port, and a port of 65535 is the longest an origin can carry.
const ORIGINS = MCP_ALLOWED_HOSTNAMES.map((host) => `https://${host}:65535`);

interface Served {
  initializeInstructions: string;
  discoverInstructions: string;
  tools: Array<{ name: string; description: string }>;
}

function minimalEnv(): McpEnv {
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

async function readServed(origin: string): Promise<Served> {
  resetMcpTestState();
  const env = minimalEnv();
  const opts = { origin };
  const init = await mcpInitialize(env, opts);
  const discover = await mcpRpcExpect200(env, modernServerDiscoverBody(), modernServerDiscoverHeaders(), opts);
  const list = await mcpRpcExpect200(env, modernToolsListBody(), modernToolsListHeaders(), opts);
  return {
    initializeInstructions: init.result?.instructions ?? '',
    discoverInstructions: discover.result?.instructions ?? '',
    tools: (list.result?.tools ?? []).map((tool) => ({ name: tool.name, description: tool.description ?? '' })),
  };
}

function shown(needle: string): string {
  return JSON.stringify(needle.length > 60 ? `${needle.slice(0, 57)}...` : needle);
}

function breach(subject: string, origin: string, what: string, limit: ClientLimit, measured: number): string {
  return `${subject} at ${origin}: ${what} breaks ${limit.id} (${limit.client}): ${measured} ${limit.unit}, limit ${limit.value}`;
}

function assertNoFailures(failures: readonly string[]): void {
  if (failures.length > 0) throw new Error(`${failures.join('\n')}\n${NEXT_STEP}`);
}

function limitsAcross(
  select: (surface: MetadataSurface) => ClientLimit[],
  surfaces: readonly MetadataSurface[],
): ClientLimit[] {
  return [...new Map(surfaces.flatMap((surface) => select(surface)).map((limit) => [limit.id, limit])).values()];
}

function budgetFailures(subject: string, text: string, surfaces: readonly MetadataSurface[], origin: string): string[] {
  const limits = limitsAcross(budgetLimits, surfaces);
  if (limits.length === 0) return [`${subject} at ${origin}: no budget limit applies to ${surfaces.join(', ')}`];
  return limits
    .filter((limit) => measure(text, limit.unit) > limit.value)
    .map((limit) => breach(subject, origin, 'the whole string', limit, measure(text, limit.unit)));
}

function windowFailures(
  subject: string,
  text: string,
  needle: string,
  limits: readonly ClientLimit[],
  origin: string,
): string[] {
  if (limits.length === 0) return [`${subject} at ${origin}: no limit record applies`];
  if (needle.length === 0) return [`${subject} at ${origin}: the text to place is empty`];
  const start = text.indexOf(needle);
  if (start === -1) return [`${subject} at ${origin}: the text to place, ${shown(needle)}, is absent`];
  const prefix = text.slice(0, start + needle.length);
  return limits
    .filter((limit) => measure(prefix, limit.unit) > limit.value)
    .map((limit) => breach(subject, origin, `the end of ${shown(needle)}`, limit, measure(prefix, limit.unit)));
}

function orderFailures(subject: string, text: string, needles: readonly string[], origin: string): string[] {
  const positions = needles.map((needle) => text.indexOf(needle));
  const absent = needles.filter((_, i) => positions[i] === -1);
  if (absent.length > 0) return [`${subject} at ${origin}: absent: ${absent.map(shown).join(', ')}`];
  const inOrder = positions.every((position, i) => i === 0 || position > positions[i - 1]);
  return inOrder ? [] : [`${subject} at ${origin}: out of order: ${needles.map(shown).join(' before ')}`];
}

function purposeSentence(text: string): string {
  const end = text.search(/\.\s/);
  return end === -1 ? '' : text.slice(0, end + 1);
}

describe.each(ORIGINS)('served metadata at %s', (origin) => {
  let served: Served;
  beforeAll(async () => {
    served = await readServed(origin);
  });

  test('the answers are real: every tool, a description each, and one instructions string from both handshakes', () => {
    expect(served.tools.map((tool) => tool.name)).toEqual([...EXPECTED_TOOL_NAMES]);
    for (const tool of served.tools) expect(tool.description.length).toBeGreaterThan(0);
    expect(served.initializeInstructions.length).toBeGreaterThan(0);
    expect(served.discoverInstructions).toBe(served.initializeInstructions);
  });

  test('the instructions fit every budget limit', () => {
    assertNoFailures(
      budgetFailures('the server instructions', served.initializeInstructions, ['server-instructions'], origin),
    );
  });

  test('every tool description fits every budget limit on both load paths', () => {
    const failures = served.tools.flatMap((tool) =>
      budgetFailures(`the ${tool.name} description`, tool.description, TOOL_DESCRIPTION_SURFACES, origin),
    );
    assertNoFailures(failures);
  });

  test('the purpose sentence and the guide pointer end inside every lead and critical-window limit', () => {
    const text = served.initializeInstructions;
    const limits = [...leadLimits('server-instructions'), ...criticalLimits('server-instructions')];
    assertNoFailures([
      ...windowFailures('the server instructions', text, purposeSentence(text), limits, origin),
      ...windowFailures('the server instructions', text, `${origin}/mcp-skill.md`, limits, origin),
    ]);
  });

  test('the guide comes before the cached reads, and the cached reads before the metered audits', () => {
    assertNoFailures(
      orderFailures(
        'the server instructions',
        served.initializeInstructions,
        [`${origin}/mcp-skill.md`, 'get_scorecard', 'score_cli'],
        origin,
      ),
    );
  });

  test('the short disclosure ends inside every critical-window limit, in the instructions and in audit_website', () => {
    const auditWebsite = served.tools.find((tool) => tool.name === 'audit_website')?.description ?? '';
    assertNoFailures([
      ...windowFailures(
        'the server instructions',
        served.initializeInstructions,
        FOLLOW_DISCLOSURE_SHORT,
        criticalLimits('server-instructions'),
        origin,
      ),
      ...windowFailures(
        'the audit_website description',
        auditWebsite,
        FOLLOW_DISCLOSURE_SHORT,
        limitsAcross(criticalLimits, TOOL_DESCRIPTION_SURFACES),
        origin,
      ),
    ]);
  });

  test('in the instructions score_cli comes before the short disclosure, which comes before the shared limit', () => {
    assertNoFailures(
      orderFailures(
        'the server instructions',
        served.initializeInstructions,
        ['score_cli', FOLLOW_DISCLOSURE_SHORT, 'Every call shares'],
        origin,
      ),
    );
  });

  test('the audit_website description puts the short disclosure directly after its first sentence', () => {
    const description = served.tools.find((tool) => tool.name === 'audit_website')?.description ?? '';
    const first = purposeSentence(description);
    expect(first.length).toBeGreaterThan(0);
    expect(description.startsWith(`${first} ${FOLLOW_DISCLOSURE_SHORT}`)).toBe(true);
  });
});
