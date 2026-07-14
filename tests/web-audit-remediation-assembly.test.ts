// Remediation prompt/result assembly tests (plan-003 U12, R10) plus the
// MCP inline-remediation surfaces (U13, R14) exercised through the real
// handler with a prefilled cache.

import { describe, expect, test } from 'bun:test';
import { assembleRemediation, resultLine, type WebRemediationEntry } from '../src/worker/audit-web/remediation';

const OPENAPI_ENTRY: WebRemediationEntry = {
  title: 'An OpenAPI description is published',
  goal: 'Publish an OpenAPI description so non-MCP agents can call your API',
  fix: 'Publish an OpenAPI 3.1 description at /openapi.json covering your REST\nsurface (endpoints, params, schemas).',
  resources: [{ label: 'OpenAPI 3.1', url: 'https://spec.openapis.org/oas/latest.html' }],
};

describe('assembleRemediation', () => {
  test('assembles the Goal/Issue/Fix/Skill/Docs prompt with the live evidence as Issue', () => {
    const assembled = assembleRemediation(OPENAPI_ENTRY, {
      checkId: 'openapi',
      origin: 'https://anc.dev',
      evidence: 'https://example.com/openapi.json -> 404 (status 404 not in [200])',
    });
    expect(assembled.prompt.split('\n')).toEqual([
      'Goal: Publish an OpenAPI description so non-MCP agents can call your API',
      'Issue: https://example.com/openapi.json -> 404 (status 404 not in [200])',
      'Fix: Publish an OpenAPI 3.1 description at /openapi.json covering your REST surface (endpoints, params, schemas).',
      'Skill: https://anc.dev/web-audit/skill/openapi',
      'Docs: https://spec.openapis.org/oas/latest.html',
    ]);
    expect(assembled.skill_url).toBe('https://anc.dev/web-audit/skill/openapi');
    expect(assembled.resources).toEqual(OPENAPI_ENTRY.resources);
  });

  test('a missing evidence arg yields a generic Issue line', () => {
    const assembled = assembleRemediation(OPENAPI_ENTRY, { checkId: 'openapi', origin: 'https://anc.dev' });
    expect(assembled.prompt).toContain('Issue: the check did not pass in the latest audit');
  });

  test('the Docs line is omitted when an entry has no resources', () => {
    const assembled = assembleRemediation(
      { ...OPENAPI_ENTRY, resources: [] },
      { checkId: 'openapi', origin: 'https://anc.dev', evidence: 'x' },
    );
    expect(assembled.prompt).not.toContain('Docs:');
  });

  test('a check missing a catalog entry degrades to a generic prompt (no crash)', () => {
    const assembled = assembleRemediation(undefined, {
      checkId: 'mystery-check',
      origin: 'https://anc.dev',
      evidence: 'boom',
    });
    expect(assembled.goal).toContain('mystery-check');
    expect(assembled.skill_url).toBe('https://anc.dev/web-audit/skill/mystery-check');
    expect(assembled.prompt).toContain('Issue: boom');
  });
});

describe('resultLine', () => {
  test('derives affirmative and negative lines from status + evidence', () => {
    expect(resultLine('pass', 'https://x.dev/llms.txt -> 200')).toBe('Verified (https://x.dev/llms.txt -> 200)');
    expect(resultLine('broken', 'wrong content-type')).toBe('Present but broken (wrong content-type)');
    expect(resultLine('absent', 'https://x.dev/openapi.json -> 404')).toBe(
      'Not found (https://x.dev/openapi.json -> 404)',
    );
  });

  test('the two n_a wordings are distinct (antecedent-unmet vs optional-absent)', () => {
    expect(resultLine('n_a', 'no MCP endpoint discovered', 'antecedent-unmet')).toBe(
      'Not applicable (no MCP endpoint discovered)',
    );
    expect(resultLine('n_a', 'x -> 404', 'optional-absent')).toBe('Not implemented, optional (x -> 404)');
  });

  test('skip and error read as not-evaluated', () => {
    expect(resultLine('skip', null)).toContain('Not evaluated');
    expect(resultLine('error', null)).toBe('Not evaluated');
  });
});
