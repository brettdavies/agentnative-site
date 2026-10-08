// Every request the web audit sends goes through guardedFetch, which is what
// enforces the SSRF ranges, the redirect policy, and "anc sends no plaintext
// request". The published rule rests on there being no other egress, so a
// module that reaches the network by itself is a test failure here, not a
// reviewer's catch. The scan reads the syntax tree rather than the text, so a
// string or comment that says "fetch" is not a call, and an aliased global
// (`const f = fetch`) still is.
//
// Every allowlist entry names the exact line and a reason, so a second request
// path inside ssrf.ts fails as surely as one anywhere else.

import { expect, test } from 'bun:test';
import { Glob } from 'bun';
import ts from 'typescript';

const AUDIT_WEB = 'src/worker/audit-web/**/*.ts';
const GLOBAL_OBJECTS: ReadonlySet<string> = new Set(['globalThis', 'self', 'window']);
const INJECTED_FETCH: ReadonlySet<string> = new Set(['fetchImpl', 'probeFetch']);

const ALLOWED: Record<string, string> = {
  'src/worker/audit-web/ssrf.ts: const fetchImpl = opts.fetchImpl ?? fetch;':
    'guardedFetch itself: production requests reach the global fetch only here',
  'src/worker/audit-web/ssrf.ts: response = await fetchImpl(request.url, {':
    'guardedFetch itself: the one request each hop sends, after the guard admits its URL',
};

/** A name in a position that is not a value: a property, a key, a member, or a type query. */
function isNotAValue(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (ts.isTypeQueryNode(parent)) return true;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return true;
  return (
    (ts.isPropertyAssignment(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isMethodSignature(parent)) &&
    parent.name === node
  );
}

/** The global fetch reached as a value, or an injected fetch called directly. */
function isEgress(node: ts.Node): boolean {
  if (ts.isIdentifier(node)) return node.text === 'fetch' && !isNotAValue(node);
  if (ts.isPropertyAccessExpression(node)) {
    return node.name.text === 'fetch' && ts.isIdentifier(node.expression) && GLOBAL_OBJECTS.has(node.expression.text);
  }
  if (ts.isElementAccessExpression(node)) {
    return (
      ts.isIdentifier(node.expression) &&
      GLOBAL_OBJECTS.has(node.expression.text) &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      node.argumentExpression.text === 'fetch'
    );
  }
  if (ts.isCallExpression(node)) {
    const callee = node.expression;
    const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : '';
    return INJECTED_FETCH.has(name);
  }
  return false;
}

test('no web-audit module sends a request except through guardedFetch', async () => {
  const found: string[] = [];
  for await (const path of new Glob(AUDIT_WEB).scan('.')) {
    if (path.endsWith('.d.ts')) continue;
    const source = ts.createSourceFile(path, await Bun.file(path).text(), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (isEgress(node)) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
        found.push(`${path}: ${source.text.split('\n')[line].trim()}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  expect(found.filter((entry) => !(entry in ALLOWED))).toEqual([]);
  // Each allowance is still where it says, once: the scan is reading the
  // module that holds the one sanctioned request, and a copy of an allowed
  // line is a second request path.
  const occurrences = (entry: string): number => found.filter((f) => f === entry).length;
  expect(Object.keys(ALLOWED).map((entry) => [entry, occurrences(entry)])).toEqual(
    Object.keys(ALLOWED).map((entry) => [entry, 1]),
  );
});
