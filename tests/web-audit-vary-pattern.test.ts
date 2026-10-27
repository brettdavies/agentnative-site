// The markdown-vary check's header pattern passes when Vary names `accept`
// or `*` as a whole field name, so Accept-Encoding and Accept-Language do not
// count. It is spelled without lookaround because the CLI compiles every
// registry pattern with a linear-time engine that has none. This holds the
// pattern to a token-splitting oracle over a hand-written table and an
// exhaustive sweep of short header values.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import { normalizeWebAuditRegistry } from '../src/build/13-web-audit-registry.mjs';
import type { WebAuditRegistry } from '../src/worker/audit-web/registry';

const REPO_ROOT = new URL('..', import.meta.url).pathname;
const REGISTRY_PATH = join(REPO_ROOT, 'src', 'data', 'web-audit', 'registry.yaml');

/** The rule the pattern implements: some whitespace- or comma-separated name is `accept` or `*`. */
function semanticMatch(value: string): boolean {
  const names = value.toLowerCase().split(/[\s,]+/);
  return names.includes('accept') || names.includes('*');
}

function registryVaryPattern(): string {
  const registry = normalizeWebAuditRegistry(
    yaml.load(readFileSync(REGISTRY_PATH, 'utf8')) as object,
  ) as WebAuditRegistry;
  const check = registry.checks.find((c) => c.id === 'markdown-vary');
  if (!check) throw new Error('markdown-vary is not in the registry');
  const expect = (check.with as { expect?: { header_regex?: { name: string; pattern: string } } }).expect;
  const spec = expect?.header_regex;
  if (spec?.name !== 'vary') throw new Error('markdown-vary carries no header_regex on vary');
  return spec.pattern;
}

const TABLE = [
  ['accept', true],
  ['accept-encoding', false],
  ['accept-encoding, user-agent', false],
  ['accept, user-agent', true],
  ['user-agent, accept', true],
  ['user-agent, accept-encoding', false],
  ['Accept-Language,User-Agent', false],
  ['accept-encoding,accept', true],
  ['accept-encoding, accept, user-agent', true],
  ['User-Agent, Accept-Encoding, Accept', true],
  ['Accept,User-Agent,Accept-Encoding', true],
  ['user-agent', false],
  ['User-Agent', false],
  ['accept ,user-agent', true],
  ['accept-', false],
  ['accept-, user-agent', false],
  ['acceptuser-agent', false],
  ['user-agentaccept', false],
  ['ACCEPT, USER-AGENT', true],
  ['*', true],
  ['accept-encoding, *', true],
  ['x-*', false],
  ['accept1', false],
  ['accept;q=1', false],
  ['', false],
  [' ', false],
  ['accept user-agent', true],
  ['x-accept, user-agent', false],
  ['accept-x user-agent accept', true],
] as const;

const ALPHABET = ['a', 'c', 'e', 'p', 't', 'u', 's', 'r', '-', 'g', 'n', ',', ' '];

function* shortStrings(maxLen: number): Generator<string> {
  let layer = [''];
  yield '';
  for (let len = 1; len <= maxLen; len++) {
    const next: string[] = [];
    for (const prefix of layer) {
      for (const ch of ALPHABET) {
        const s = prefix + ch;
        next.push(s);
        yield s;
      }
    }
    layer = next;
  }
}

/** Deterministic header values built from the tokens the pattern cares about. */
function tokenStrings(): string[] {
  const tokens = [
    'accept',
    'accept-encoding',
    'accept-language',
    'user-agent',
    'origin',
    'accept-',
    'acceptx',
    '*',
    'x-*',
    '',
  ];
  const seps = [', ', ',', ' ', '', '\n', '\r\n', '\u2028'];
  const out: string[] = [];
  for (const a of tokens) {
    for (const b of tokens) {
      for (const c of tokens) {
        for (const sep of seps) out.push([a, b, c].join(sep));
      }
    }
  }
  return out;
}

describe('markdown-vary header pattern', () => {
  test('carries no lookaround or backreference', () => {
    expect(registryVaryPattern()).not.toMatch(/\(\?[=!<]|\\[1-9]/);
  });

  test('agrees with the semantic requirement over the header-value table', () => {
    const rewritten = new RegExp(registryVaryPattern(), 'i');
    for (const [value, expected] of TABLE) {
      expect({ value, matches: rewritten.test(value) }).toEqual({ value, matches: expected });
    }
  });

  test('agrees with the semantic requirement over every short string of the token alphabet', () => {
    const rewritten = new RegExp(registryVaryPattern(), 'i');
    let checked = 0;
    for (const value of shortStrings(6)) {
      const expected = semanticMatch(value);
      if (rewritten.test(value) !== expected) {
        throw new Error(
          `disagreement on ${JSON.stringify(value)}: pattern=${rewritten.test(value)}, semantic=${expected}`,
        );
      }
      checked += 1;
    }
    expect(checked).toBeGreaterThan(5_000_000);
  });

  test('agrees with the semantic requirement over token-built header values', () => {
    const rewritten = new RegExp(registryVaryPattern(), 'i');
    for (const value of tokenStrings()) {
      const expected = semanticMatch(value);
      if (rewritten.test(value) !== expected) {
        throw new Error(
          `disagreement on ${JSON.stringify(value)}: pattern=${rewritten.test(value)}, semantic=${expected}`,
        );
      }
    }
  });
});
