import { describe, expect, test } from 'bun:test';
import { resolveAntecedent } from '../src/worker/audit-web/antecedents';
import { ctx, outcome } from './web-audit-antecedents-helpers';

describe('resolveAntecedent: content', () => {
  test('docs-site holds for a declared content type or a present root llms.txt', () => {
    expect(resolveAntecedent('docs-site', ctx({ siteType: 'content' }))).toBe('apply');
    const llmsPass = ctx({ sources: new Map([['llms-txt', outcome('pass')]]) });
    expect(resolveAntecedent('docs-site', llmsPass)).toBe('apply');
    expect(resolveAntecedent('docs-site', ctx({ siteType: 'api' }))).toBe('n_a');
  });

  test('root-llms-txt / root-llms-full-txt reuse the wave-1 probe results', () => {
    const sources = new Map([
      ['llms-txt', outcome('pass')],
      ['llms-full-txt', outcome('absent')],
    ]);
    expect(resolveAntecedent('root-llms-txt', ctx({ sources }))).toBe('apply');
    expect(resolveAntecedent('root-llms-full-txt', ctx({ sources }))).toBe('n_a');
  });
});

describe('resolveAntecedent: markdown-twin', () => {
  const mdAlternateRoot = () =>
    ctx({
      root: {
        status: 200,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          link: '</index.md>; rel="alternate"; type="text/markdown"',
        },
        body: '<html></html>',
        error: null,
      },
    });

  test('applies when the wave-1 accept-markdown probe passed', () => {
    const md = ctx({ sources: new Map([['accept-markdown', outcome('pass')]]) });
    expect(resolveAntecedent('markdown-twin', md)).toBe('apply');
  });

  test('applies when the wave-1 llms.txt probe passed', () => {
    const md = ctx({ sources: new Map([['llms-txt', outcome('pass')]]) });
    expect(resolveAntecedent('markdown-twin', md)).toBe('apply');
  });

  test('applies when the root advertises a text/markdown rel=alternate Link', () => {
    expect(resolveAntecedent('markdown-twin', mdAlternateRoot())).toBe('apply');
  });

  test('is n_a when the root is HTML but no markdown signal holds', () => {
    expect(resolveAntecedent('markdown-twin', ctx())).toBe('n_a');
  });

  test('is n_a on a non-HTML root even when llms.txt passed (the HTML precondition wins)', () => {
    const apiRoot = ctx({
      root: { status: 200, headers: { 'content-type': 'application/json' }, body: '{}', error: null },
      sources: new Map([['llms-txt', outcome('pass')]]),
    });
    expect(resolveAntecedent('markdown-twin', apiRoot)).toBe('n_a');
  });

  test('is error when the root failed at the network level', () => {
    expect(resolveAntecedent('markdown-twin', ctx({ root: null }))).toBe('error');
  });

  test('does not false-positive on a non-markdown rel=alternate Link', () => {
    const jsonAlternate = ctx({
      root: {
        status: 200,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          link: '</index.json>; rel="alternate"; type="application/json"',
        },
        body: '<html></html>',
        error: null,
      },
    });
    expect(resolveAntecedent('markdown-twin', jsonAlternate)).toBe('n_a');
  });
});
