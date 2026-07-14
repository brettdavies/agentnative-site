import { describe, expect, test } from 'bun:test';
import { resolveAntecedent } from '../src/worker/audit-web/antecedents';
import type { ProbeResponse } from '../src/worker/audit-web/assert';
import { ctx } from './web-audit-antecedents-helpers';

describe('resolveAntecedent: root', () => {
  test('none always applies', () => {
    expect(resolveAntecedent('none', ctx())).toBe('apply');
  });

  test('http-root applies on any HTTP answer and errors on a network failure', () => {
    expect(resolveAntecedent('http-root', ctx())).toBe('apply');
    expect(resolveAntecedent('http-root', ctx({ root: null }))).toBe('error');
  });

  test('html-root requires a text/html content-type', () => {
    expect(resolveAntecedent('html-root', ctx())).toBe('apply');
    const jsonRoot: ProbeResponse = {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: '{}',
      error: null,
    };
    expect(resolveAntecedent('html-root', ctx({ root: jsonRoot }))).toBe('n_a');
    expect(resolveAntecedent('html-root', ctx({ root: null }))).toBe('error');
  });
});
