// A row over several targets (the API rows on api-catalog anchors): the
// precedence that picks its status, and what it does with a target it did
// not evaluate.

import { describe, expect, test } from 'bun:test';
import { aggregateTargets, type TargetOutcome, worstTargetStatus } from '../src/worker/audit-web/handlers/shared';
import type { ProbeStatus } from '../src/worker/audit-web/handlers/types';

const PRECEDENCE: Array<[ProbeStatus, ProbeStatus]> = [
  ['broken', 'noncompliant'],
  ['noncompliant', 'absent'],
  ['absent', 'error'],
  ['error', 'pass'],
];

function target(status: ProbeStatus, host: string, na_reason?: TargetOutcome['na_reason']): TargetOutcome {
  return { status, evidence: [{ host }], ...(na_reason !== undefined ? { na_reason } : {}) };
}

describe('worstTargetStatus', () => {
  test.each(PRECEDENCE)('%s outranks %s in either order', (worse, better) => {
    expect(worstTargetStatus([worse, better])).toBe(worse);
    expect(worstTargetStatus([better, worse])).toBe(worse);
  });

  test.each<[ProbeStatus[], ProbeStatus]>([
    [['na', 'pass'], 'pass'],
    [['pass', 'na'], 'pass'],
    [['na', 'absent'], 'absent'],
    [['absent', 'na'], 'absent'],
    [['na', 'na'], 'na'],
    [[], 'na'],
  ])('a target not evaluated neither passes nor fails the row: %p reads %s', (statuses, row) => {
    expect(worstTargetStatus(statuses)).toBe(row);
  });
});

describe('aggregateTargets', () => {
  test('the row takes the worst evaluated status, and each item keeps its own target status and reason', () => {
    const outcome = aggregateTargets([
      target('na', 'a.example.net', 'declared-host-unreachable'),
      target('broken', 'b.example.net'),
      target('pass', 'c.example.net'),
    ]);
    expect(outcome.status).toBe('broken');
    expect(outcome.na_reason).toBeUndefined();
    expect(outcome.evidence).toEqual([
      { host: 'a.example.net', target_status: 'na', na_reason: 'declared-host-unreachable' },
      { host: 'b.example.net', target_status: 'broken' },
      { host: 'c.example.net', target_status: 'pass' },
    ]);
  });

  test("with no target evaluated, the row reads n/a with the first target's reason", () => {
    const outcome = aggregateTargets([
      target('na', 'a.example.net', 'follow-disabled'),
      target('na', 'b.example.net', 'declared-host-blocked'),
    ]);
    expect(outcome).toMatchObject({ status: 'na', na_reason: 'follow-disabled' });
  });
});
