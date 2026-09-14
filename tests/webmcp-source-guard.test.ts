// R19: the in-page tools prepare both entry pages and never transact. The
// guard reads the shipped sources rather than the tools' behavior, so a new
// tool cannot reintroduce a submit path that no behavioral test happens to
// call.

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatHits, GUARD_RULES, scanWebMcpSource } from './helpers/webmcp-source-guard';

const REPO_ROOT = join(fileURLToPath(import.meta.url), '..', '..');

/** Every module that ships inside the WebMCP bundle. */
const WEBMCP_SOURCES = [
  'client/webmcp.ts',
  'client/webmcp-lib.ts',
  'client/webmcp-entry.ts',
  'client/webmcp-result.ts',
  'client/webmcp-orientation.ts',
  'client/assemble-prompt.ts',
  'shared/web-audit-findings.ts',
];

describe('WebMCP source guard', () => {
  test('no module in the bundle carries a transacting construct', async () => {
    const hits = [];
    for (const file of WEBMCP_SOURCES) {
      hits.push(...scanWebMcpSource(await readFile(join(REPO_ROOT, 'src', file), 'utf8'), file));
    }
    expect(hits.length === 0 ? '' : formatHits(hits)).toBe('');
  });

  test('the guard fails on a fixture containing requestSubmit(', () => {
    const hits = scanWebMcpSource('const f = doc.forms[0];\nf.requestSubmit();\n', 'fixture.ts');
    expect(hits).toEqual([{ file: 'fixture.ts', line: 2, rule: 'requestSubmit', text: 'f.requestSubmit();' }]);
  });

  test('every rule catches its own construct and the allowed form GET survives', () => {
    const fixtures: Record<string, string> = {
      requestSubmit: 'form.requestSubmit();',
      'synthetic submit event': "el.dispatchEvent(new Event('submit'));",
      'element click': 'button.click();',
      'reaudit control': "doc.querySelector('[data-reaudit]');",
      startAudit: 'void startAudit({ target });',
      'progress page navigation': "const next = '/scoring';",
      'direct navigation': 'location.href = next;',
    };
    for (const rule of GUARD_RULES) {
      const source = fixtures[rule.rule];
      expect({ rule: rule.rule, caught: scanWebMcpSource(source, 'f.ts').map((h) => h.rule) }).toEqual({
        rule: rule.rule,
        caught: [rule.rule],
      });
    }
    // The entry form's own GET is how open_audit hops; it fires no handler.
    expect(scanWebMcpSource('form.submit();', 'f.ts')).toEqual([]);
  });

  test('a comment naming a banned construct is not a hit', () => {
    const source = ['// never call requestSubmit( here', ' * no .click() on the submit control', '# startAudit'].join(
      '\n',
    );
    expect(scanWebMcpSource(source, 'f.ts')).toEqual([]);
  });
});
