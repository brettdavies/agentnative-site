// The refusal a visitor gets for a host anc.dev cannot reach (the
// agentnative-cli plan, U13). A localhost, private or internal target is
// not bad input: it is the exact case the local CLI exists for, and the
// visitor has just proved they want it, so the refusal names the command.

import { describe, expect, test } from 'bun:test';
import { prepareWebTarget, webRefusal } from '../src/worker/audit-web/core';

const LOCAL_COMMAND = /anc web /;

describe('webRefusal', () => {
  test('a blocked host gets the local command it can be audited with', () => {
    const refusal = webRefusal('localhost:8787', 'blocked: localhost is not a public host');
    expect(refusal).toContain('blocked: localhost is not a public host');
    expect(refusal).toContain('anc web localhost:8787');
    expect(refusal).toContain('public hosts only');
    expect(refusal).toContain('https://github.com/brettdavies/agentnative-cli');
  });

  test('a refusal no local command fixes passes through unchanged', () => {
    for (const reason of ['invalid host', 'unparseable url: @@', 'scheme ftp: is not http(s)']) {
      expect(webRefusal('example.com', reason)).toBe(reason);
    }
  });
});

describe('prepareWebTarget', () => {
  test('every unreachable-host class is pointed at the local command', () => {
    const hosts = [
      'localhost',
      'localhost:8787',
      'app.localhost',
      '127.0.0.1',
      '127.0.0.1:3000',
      '10.0.0.5',
      '192.168.1.10',
      '172.16.9.9',
      '169.254.169.254',
      'staging.internal',
      'metadata.google.internal',
      '[::1]',
      '[fe80::1]',
      '[fd00::1]',
    ];
    for (const host of hosts) {
      const prepared = prepareWebTarget(host);
      expect(prepared.ok).toBe(false);
      if (prepared.ok) continue;
      expect(prepared.reason).toMatch(LOCAL_COMMAND);
      expect(prepared.reason).toContain(`anc web ${host}`);
    }
  });

  test('a public host still prepares, and a malformed one still refuses plainly', () => {
    const ok = prepareWebTarget('anc.dev');
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.target.host).toBe('anc.dev');
      expect(ok.target.canonical).toBe('https://anc.dev/');
    }
    const bad = prepareWebTarget('not a host');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).not.toMatch(LOCAL_COMMAND);
  });
});
