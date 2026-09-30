// The markdown-vary check's header pattern must match "both Accept and
// User-Agent are named in Vary, and the Accept token is not a prefix of
// Accept-Encoding / Accept-Language" without lookaround, because the CLI
// compiles every registry pattern with a linear-time engine that has none.
// This pins the rewritten pattern to the lookaround form it replaces over
// a hand-written table and an exhaustive sweep of short header values.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import { normalizeWebAuditRegistry } from '../src/build/13-web-audit-registry.mjs';
import type { WebAuditRegistry } from '../src/worker/audit-web/registry';

const REPO_ROOT = new URL('..', import.meta.url).pathname;
const REGISTRY_PATH = join(REPO_ROOT, 'src', 'data', 'web-audit', 'registry.yaml');

/** The pattern the registry carried before the rewrite; the semantic oracle. */
const LOOKAROUND_FORM = '(?=.*accept(?!-))(?=.*user-agent)';

function registryVaryPattern(): string {
  const registry = normalizeWebAuditRegistry(
    yaml.load(readFileSync(REGISTRY_PATH, 'utf8')) as object,
  ) as WebAuditRegistry;
  const check = registry.checks.find((c) => c.id === 'markdown-vary');
  if (!check) throw new Error('markdown-vary is not in the registry');
  const expect = (check.with as { expect?: { header_regex?: { name: string; pattern: string } } }).expect;
  const spec = expect?.header_regex;
  if (!spec || spec.name !== 'vary') throw new Error('markdown-vary carries no header_regex on vary');
  return spec.pattern;
}

const TABLE = [
  'accept',
  'accept-encoding',
  'accept-encoding, user-agent',
  'accept, user-agent',
  'user-agent, accept',
  'user-agent, accept-encoding',
  'Accept-Language,User-Agent',
  'accept-encoding,accept',
  'accept-encoding, accept, user-agent',
  'User-Agent, Accept-Encoding, Accept',
  'Accept,User-Agent,Accept-Encoding',
  'user-agent',
  'User-Agent',
  'accept ,user-agent',
  'accept-',
  'accept-, user-agent',
  'acceptuser-agent',
  'user-agentaccept',
  'ACCEPT, USER-AGENT',
  '*',
  '',
  ' ',
  'accept user-agent',
  'x-accept, user-agent',
  'accept-x user-agent accept',
];

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
  const tokens = ['accept', 'accept-encoding', 'accept-language', 'user-agent', 'origin', 'accept-', 'acceptx', ''];
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

  test('agrees with the lookaround form over the header-value table', () => {
    const oracle = new RegExp(LOOKAROUND_FORM, 'i');
    const rewritten = new RegExp(registryVaryPattern(), 'i');
    for (const value of TABLE) {
      expect({ value, matches: rewritten.test(value) }).toEqual({ value, matches: oracle.test(value) });
    }
  });

  test('agrees with the lookaround form over every short string of the token alphabet', () => {
    const oracle = new RegExp(LOOKAROUND_FORM, 'i');
    const rewritten = new RegExp(registryVaryPattern(), 'i');
    let checked = 0;
    for (const value of shortStrings(6)) {
      if (rewritten.test(value) !== oracle.test(value)) {
        throw new Error(`disagreement on ${JSON.stringify(value)}`);
      }
      checked += 1;
    }
    expect(checked).toBeGreaterThan(5_000_000);
  });

  test('agrees with the lookaround form over token-built header values', () => {
    const oracle = new RegExp(LOOKAROUND_FORM, 'i');
    const rewritten = new RegExp(registryVaryPattern(), 'i');
    for (const value of tokenStrings()) {
      if (rewritten.test(value) !== oracle.test(value)) {
        throw new Error(`disagreement on ${JSON.stringify(value)}`);
      }
    }
  });
});
