// The global score's universe on the real registry: the most a single site
// could earn, counting only the MCP access alternatives the site presents,
// read from its rows alone so a stored scorecard recomputes the same value.
// The protected shape takes its auth-required rows from the corpus's
// correctly protected endpoint, so it is a shape the engine produces.

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import { normalizeWebAuditRegistry } from '../src/build/13-web-audit-registry.mjs';
import type { NaReason } from '../src/shared/web-audit-findings';
import type { AntecedentToken, WebAuditRegistry } from '../src/worker/audit-web/registry';
import { scoreWebAudit, universeMaxOf } from '../src/worker/audit-web/score';
import {
  buildWebScorecard,
  type EngineResult,
  type ScorecardStatus,
  type WebScorecard,
} from '../src/worker/audit-web/scorecard';

const REPO_ROOT = new URL('..', import.meta.url).pathname;
const REGISTRY_PATH = join(REPO_ROOT, 'src', 'data', 'web-audit', 'registry.yaml');
const PROTECTED_FIXTURE = join(
  REPO_ROOT,
  'tests',
  'fixtures',
  'web-audit-conformance',
  'scenarios',
  'auth-own-endpoint',
  'scorecard.json',
);

const registry = normalizeWebAuditRegistry(
  yaml.load(await readFile(REGISTRY_PATH, 'utf8')) as object,
) as unknown as WebAuditRegistry;

const OPEN: ReadonlySet<AntecedentToken> = new Set(['mcp-session', 'mcp-resources']);
const PROTECTED: ReadonlySet<AntecedentToken> = new Set(['mcp-auth-required']);
const OTHER_MCP: ReadonlySet<AntecedentToken> = new Set(['mcp-present', 'mcp-auth']);

const protectedFixture = JSON.parse(await readFile(PROTECTED_FIXTURE, 'utf8')) as WebScorecard;

/** Rows outside the access alternatives that a correctly protected endpoint's 401s leave auth-required. */
const REFUSED_OUTSIDE_ALTERNATIVES: ReadonlySet<string> = new Set(
  protectedFixture.results
    .filter((row) => row.status === 'n_a' && row.na_reason === 'auth-required')
    .map((row) => row.id)
    .filter((id) => {
      const antecedent = registry.checks.find((check) => check.id === id)?.antecedent;
      return antecedent !== undefined && !OPEN.has(antecedent) && !PROTECTED.has(antecedent);
    }),
);

type Outcome = { status: ScorecardStatus; na_reason?: NaReason };

const PASS: Outcome = { status: 'pass' };
const na = (reason?: NaReason): Outcome => ({ status: 'n_a', ...(reason !== undefined ? { na_reason: reason } : {}) });

/**
 * One row per registry check; checks outside MCP always pass. `refused`
 * reads on the rows a correctly protected endpoint answers with a 401
 * outside the access alternatives.
 */
function siteRows(shape: { open: Outcome; protected: Outcome; otherMcp?: Outcome; refused?: Outcome }): EngineResult[] {
  return registry.checks.map((check) => {
    const outcome = OPEN.has(check.antecedent)
      ? shape.open
      : PROTECTED.has(check.antecedent)
        ? shape.protected
        : shape.refused !== undefined && REFUSED_OUTSIDE_ALTERNATIVES.has(check.id)
          ? shape.refused
          : OTHER_MCP.has(check.antecedent)
            ? (shape.otherMcp ?? PASS)
            : PASS;
    return {
      id: check.id,
      title: check.title,
      principle: check.principle,
      keyword: check.keyword,
      tier: check.tier,
      category: check.category,
      weight: check.weight,
      evidence: '',
      raw_evidence: [],
      ...outcome,
    };
  });
}

const SHAPES = {
  open: siteRows({ open: PASS, protected: na('antecedent-unmet') }),
  protected: siteRows({ open: na('auth-required'), protected: PASS, refused: na('auth-required') }),
  hybrid: siteRows({ open: PASS, protected: PASS }),
  'no MCP': siteRows({
    open: na('antecedent-unmet'),
    protected: na('antecedent-unmet'),
    otherMcp: na('antecedent-unmet'),
  }),
};

function scorecardOf(rows: EngineResult[]): WebScorecard {
  return buildWebScorecard(rows, {
    targetUrl: 'https://example.com/',
    domain: 'example.com',
    mcpEndpoint: null,
    discoveryEvidence: [],
    specVersion: '0.5.0',
    registry,
  });
}

describe('the global universe counts the MCP access alternatives a site presents', () => {
  // Outside the group the registry weighs 124; open access weighs 31 and
  // protected access 3. A site presenting neither counts the larger.
  test('open, protected, hybrid, and no-MCP sites each get their own universe', () => {
    const universes = Object.fromEntries(
      Object.entries(SHAPES).map(([shape, rows]) => [shape, universeMaxOf(registry, rows)]),
    );
    expect(universes).toEqual({ open: 155, protected: 127, hybrid: 158, 'no MCP': 155 });
  });

  test('a variant is presented when one of its rows applied, whatever that row scored', () => {
    const appliedOutcomes: Outcome[] = [
      { status: 'broken' },
      { status: 'noncompliant' },
      { status: 'absent' },
      { status: 'skip' },
      { status: 'error' },
      na('optional-absent'),
      na('posture-consistent'),
    ];
    const universes = appliedOutcomes.map((protectedAccess) =>
      universeMaxOf(registry, siteRows({ open: na('auth-required'), protected: protectedAccess })),
    );
    expect(universes).toEqual(appliedOutcomes.map(() => 127));
  });

  test('a variant whose every row reads n_a for a reason a non-applicable check carries is not presented', () => {
    const notApplied: Outcome[] = [
      na(),
      na('antecedent-unmet'),
      na('auth-required'),
      na('follow-disabled'),
      na('reciprocity-refused'),
      na('declared-host-unreachable'),
      na('declared-host-blocked'),
      na('declared-host-budget-exceeded'),
    ];
    const universes = notApplied.map((open) => universeMaxOf(registry, siteRows({ open, protected: PASS })));
    expect(universes).toEqual(notApplied.map(() => 127));
  });

  test('one applied row presents its whole variant', () => {
    const rows = siteRows({ open: na('auth-required'), protected: PASS }).map(({ na_reason, ...row }) =>
      row.id === 'mcp-server-discover' ? { ...row, status: 'pass' as const } : { ...row, na_reason },
    );
    expect(universeMaxOf(registry, rows)).toBe(158);
  });

  test('the rows a protected endpoint answers with a 401 outside the alternatives are the handshake and the conformance rows', () => {
    expect([...REFUSED_OUTSIDE_ALTERNATIVES].sort()).toEqual([
      'mcp-batch-reject',
      'mcp-initialize',
      'mcp-modern-clientcaps',
      'mcp-modern-header-mismatch',
      'mcp-modern-unknown-method',
      'mcp-unknown-method',
    ]);
  });

  test('an open or hybrid site that passes every check it presents scores 100 global, a protected-only one tops out below it, and a site without MCP sees what MCP is worth', () => {
    const scores = Object.fromEntries(
      Object.entries(SHAPES).map(([shape, rows]) => {
        const { score } = scorecardOf(rows);
        return [shape, `${score.relative}/${score.global}`];
      }),
    );
    // Protected: the six rows its 401s answer stay in the 127-point
    // universe, one MUST and five SHOULDs, so it earns 107 of 127.
    // No MCP: 83 earned outside every MCP check, over 124 + the larger variant.
    expect(scores).toEqual({ open: '100/100', protected: '100/84', hybrid: '100/100', 'no MCP': '100/54' });
    expect(scoreWebAudit(SHAPES.protected, universeMaxOf(registry, SHAPES.protected))).toEqual({
      relative: 100,
      global: 84,
      earned: 107,
    });
  });

  test('a stored scorecard recomputes its scores from its rows alone', () => {
    for (const [shape, rows] of Object.entries(SHAPES)) {
      const stored = JSON.parse(JSON.stringify(scorecardOf(rows))) as WebScorecard;
      const recomputed = scoreWebAudit(stored.results, universeMaxOf(registry, stored.results));
      expect({ shape, relative: recomputed.relative, global: recomputed.global }).toEqual({
        shape,
        ...stored.score,
      });
    }
  });
});

describe('the global score is capped at 100', () => {
  test('earned points above the universe still read 100', () => {
    const rows = Array.from({ length: 3 }, () => ({ keyword: 'must' as const, status: 'pass' as const }));
    expect(scoreWebAudit(rows, 5)).toEqual({ relative: 100, global: 100, earned: 15 });
  });
});
