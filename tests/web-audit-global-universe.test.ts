// The global score's universe on the real registry: the most a single site
// could earn, counting only the MCP access designs the site presents, read
// from its rows alone so a stored scorecard recomputes the same value. The
// sign-in checks are the only checks a design owns; the session checks count
// for every site, so the rows sign-in keeps a public audit from reaching stay
// in a protected endpoint's universe. The protected shape takes its
// auth-required rows from the corpus's correctly protected endpoint, so it is
// a shape the engine produces.

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

const SESSION: ReadonlySet<AntecedentToken> = new Set(['mcp-session', 'mcp-resources']);
const PROTECTED: ReadonlySet<AntecedentToken> = new Set(['mcp-auth-required']);
const OTHER_MCP: ReadonlySet<AntecedentToken> = new Set(['mcp-present', 'mcp-auth']);

const protectedFixture = JSON.parse(await readFile(PROTECTED_FIXTURE, 'utf8')) as WebScorecard;

/** Rows outside the session and sign-in checks that a correctly protected endpoint's 401s leave auth-required. */
const REFUSED_HANDSHAKE_ROWS: ReadonlySet<string> = new Set(
  protectedFixture.results
    .filter((row) => row.status === 'n_a' && row.na_reason === 'auth-required')
    .map((row) => row.id)
    .filter((id) => {
      const antecedent = registry.checks.find((check) => check.id === id)?.antecedent;
      return antecedent !== undefined && !SESSION.has(antecedent) && !PROTECTED.has(antecedent);
    }),
);

type Outcome = { status: ScorecardStatus; na_reason?: NaReason };

const PASS: Outcome = { status: 'pass' };
const na = (reason?: NaReason): Outcome => ({ status: 'n_a', ...(reason !== undefined ? { na_reason: reason } : {}) });

/**
 * One row per registry check; checks outside MCP always pass. `refused`
 * reads on the handshake rows a correctly protected endpoint answers with
 * a 401.
 */
function siteRows(shape: {
  session: Outcome;
  protected: Outcome;
  otherMcp?: Outcome;
  refused?: Outcome;
}): EngineResult[] {
  return registry.checks.map((check) => {
    const outcome = SESSION.has(check.antecedent)
      ? shape.session
      : PROTECTED.has(check.antecedent)
        ? shape.protected
        : shape.refused !== undefined && REFUSED_HANDSHAKE_ROWS.has(check.id)
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
  open: siteRows({ session: PASS, protected: na('antecedent-unmet') }),
  protected: siteRows({ session: na('auth-required'), protected: PASS, refused: na('auth-required') }),
  hybrid: siteRows({ session: PASS, protected: PASS }),
  'no MCP': siteRows({
    session: na('antecedent-unmet'),
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

describe('the global universe counts the MCP access designs a site presents', () => {
  // Outside the group the registry weighs 155, session checks included; the
  // protected design weighs 3 and the open design owns no checks. A site
  // presenting neither counts the larger.
  test('open, protected, hybrid, and no-MCP sites each get their own universe', () => {
    const universes = Object.fromEntries(
      Object.entries(SHAPES).map(([shape, rows]) => [shape, universeMaxOf(registry, rows)]),
    );
    expect(universes).toEqual({ open: 155, protected: 158, hybrid: 158, 'no MCP': 158 });
  });

  test('sign-in limits what a public audit reaches, never the universe: a protected endpoint keeps the universe a credentialed audit of it scores against', () => {
    const credentialed = siteRows({ session: PASS, protected: PASS });
    expect(universeMaxOf(registry, SHAPES.protected)).toBe(universeMaxOf(registry, credentialed));
  });

  test('the open design is presented when a session row applied, whatever that row scored', () => {
    const appliedOutcomes: Outcome[] = [
      { status: 'broken' },
      { status: 'noncompliant' },
      { status: 'absent' },
      { status: 'skip' },
      { status: 'error' },
      na('optional-absent'),
      na('posture-consistent'),
    ];
    const universes = appliedOutcomes.map((session) =>
      universeMaxOf(registry, siteRows({ session, protected: na('antecedent-unmet') })),
    );
    expect(universes).toEqual(appliedOutcomes.map(() => 155));
  });

  test('session rows that all read n_a for a reason a non-applicable check carries present no design', () => {
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
    const universes = notApplied.map((session) =>
      universeMaxOf(registry, siteRows({ session, protected: na('antecedent-unmet') })),
    );
    expect(universes).toEqual(notApplied.map(() => 158));
  });

  test('one applied session row presents the open design', () => {
    const rows = siteRows({ session: na('auth-required'), protected: na('antecedent-unmet') }).map(
      ({ na_reason, ...row }) =>
        row.id === 'mcp-server-discover' ? { ...row, status: 'pass' as const } : { ...row, na_reason },
    );
    expect(universeMaxOf(registry, rows)).toBe(155);
  });

  test('the rows a protected endpoint answers with a 401 outside the session and sign-in checks are the handshake and the conformance rows', () => {
    expect([...REFUSED_HANDSHAKE_ROWS].sort()).toEqual([
      'mcp-batch-reject',
      'mcp-initialize',
      'mcp-modern-clientcaps',
      'mcp-modern-header-mismatch',
      'mcp-modern-unknown-method',
      'mcp-unknown-method',
    ]);
  });

  test('an open or hybrid site that passes every check it presents scores 100 global, a protected-only one tops out near 68 on a public audit, and a site without MCP sees what MCP is worth', () => {
    const scores = Object.fromEntries(
      Object.entries(SHAPES).map(([shape, rows]) => {
        const { score } = scorecardOf(rows);
        return [shape, `${score.relative}/${score.global}`];
      }),
    );
    // Protected: the session rows (31 points) and the six handshake rows
    // its 401s answer (20 points) stay in the 158-point universe, so it
    // earns 107 of 158. No MCP: 83 earned outside every MCP check, over 155
    // + the larger design.
    expect(scores).toEqual({ open: '100/100', protected: '100/68', hybrid: '100/100', 'no MCP': '100/53' });
    expect(scoreWebAudit(SHAPES.protected, universeMaxOf(registry, SHAPES.protected))).toEqual({
      relative: 100,
      global: 68,
      earned: 107,
    });
  });

  // The published copy states the protected ceiling as a number, so a
  // registry change that moves it must move the copy too.
  test('the methodology and the scorecard schema state the protected ceiling the registry produces', async () => {
    const ceiling = scorecardOf(SHAPES.protected).score.global;
    const docs = ['methodology.md', 'web-scorecard-schema.md'];
    const stated = await Promise.all(
      docs.map(async (doc) => {
        const text = (await readFile(join(REPO_ROOT, 'content', doc), 'utf8')).replace(/\s+/g, ' ');
        return [doc, text.includes(`on a public audit tops out near ${ceiling},`)];
      }),
    );
    expect(Object.fromEntries(stated)).toEqual(Object.fromEntries(docs.map((doc) => [doc, true])));
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
