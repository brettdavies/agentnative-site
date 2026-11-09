import { describe, expect, test } from 'bun:test';
import { ancWebCommand } from '../src/worker/audit-web/anc-web-command';
import { prepareWebTarget, type WebTargetRefusal } from '../src/worker/audit-web/core';
import { localTargetRefusal } from '../src/worker/audit-web/local-target';
import { isMetadataHost } from '../src/worker/audit-web/ssrf';

const ORIGIN = 'https://anc.dev';

function refused(host: string): WebTargetRefusal {
  const prepared = prepareWebTarget(host);
  if (prepared.ok) throw new Error(`expected the gate to refuse ${host}`);
  return prepared;
}

describe('ancWebCommand', () => {
  test('prints a host with its port', () => {
    expect(ancWebCommand('localhost:3000', true)).toBe('anc web localhost:3000');
    expect(ancWebCommand('10.0.0.1', true)).toBe('anc web 10.0.0.1');
    expect(ancWebCommand('my_service.internal:8443', true)).toBe('anc web my_service.internal:8443');
  });

  test('quotes a bracketed IPv6 literal, which zsh would read as a glob', () => {
    expect(ancWebCommand('[::1]:3000', true)).toBe("anc web '[::1]:3000'");
    expect(ancWebCommand('[fd00::1]', true)).toBe("anc web '[fd00::1]'");
  });

  test('a host a shell or a flag parser would read as something else is never printed', () => {
    for (const host of [
      'a$(id).internal',
      'a`id`.internal',
      'a;b.internal',
      'a&b.internal',
      'a|b.internal',
      "a'b.internal",
      'a*.internal',
      '-rf.internal',
      '--ca-cert=x.internal',
      '[::1]$(id)',
    ]) {
      expect({ host, command: ancWebCommand(host, true) }).toEqual({ host, command: null });
    }
  });

  test('never prints a metadata destination, with or without a port, even one the SSRF gate does not block', () => {
    for (const host of ['169.254.169.254', '100.100.100.200:8443', '168.63.129.16', '[fd20:ce::254]:443']) {
      expect({ host, command: ancWebCommand(host, true) }).toEqual({ host, command: null });
    }
  });

  test('names nothing until a published release has the command', () => {
    expect(ancWebCommand('localhost:3000', false)).toBeNull();
  });
});

describe('isMetadataHost', () => {
  test('matches what anc web refuses in every spelling the URL parser leaves', () => {
    for (const host of [
      '169.254.169.254',
      '169.254.1.1',
      'metadata.google.internal',
      'metadata.google.internal.',
      '[fd00:ec2::254]',
      '[fd20:ce::254]',
      '[fe80::a9fe:a9fe]',
      '[fd00:a9fe:a9fe::1]',
      '[fd00:42::42]',
      '100.100.100.200',
      '168.63.129.16',
      '[::ffff:a9fe:a9fe]',
      '[::a9fe:a9fe]',
      '[::ffff:6464:64c8]',
      '[::ffff:a83f:8110]',
    ]) {
      expect({ host, metadata: isMetadataHost(host) }).toEqual({ host, metadata: true });
    }
  });

  test('leaves the hosts anc web audits', () => {
    for (const host of [
      'localhost',
      '10.0.0.1',
      '127.0.0.1',
      'build.internal',
      '[::1]',
      '[fd00::1]',
      '[fe80::1]',
      '100.100.100.199',
      '168.63.129.17',
      '[fd20:ce::255]',
      '[fe80::a9fe:a9ff]',
      '[fd00:42::43]',
    ]) {
      expect({ host, metadata: isMetadataHost(host) }).toEqual({ host, metadata: false });
    }
  });
});

describe('localTargetRefusal', () => {
  test('carries the gate reason, the offending host, and the runnable next step', () => {
    expect(localTargetRefusal(refused('localhost:3000'), ORIGIN)?.error).toMatchObject({
      code: 'invalid_target',
      reason: 'local-target',
      value: 'localhost:3000',
      details: 'blocked: localhost is not a public host',
      next_step: {
        action: 'run',
        command: 'anc web localhost:3000',
        docs: 'https://anc.dev/install#audit-a-local-site',
      },
    });
  });

  test('its docs link stays on the deployment that answered', () => {
    const staging = 'https://agentnative-site-staging.example.workers.dev';
    expect(localTargetRefusal(refused('10.0.0.1'), staging)?.error.next_step?.docs).toBe(
      `${staging}/install#audit-a-local-site`,
    );
  });

  test('stands aside for every case the generic refusal covers', () => {
    expect(localTargetRefusal(refused('localhost:3000'), ORIGIN, false)).toBeNull();
    expect(localTargetRefusal(refused('169.254.169.254'), ORIGIN)).toBeNull();
    expect(localTargetRefusal(refused('100.100.100.200'), ORIGIN)).toBeNull();
    expect(localTargetRefusal(refused('[fd20:ce::254]'), ORIGIN)).toBeNull();
    expect(localTargetRefusal(refused('metadata.google.internal'), ORIGIN)).toBeNull();
    expect(refused('metadata.google.internal').reason).toBe('blocked: cloud metadata hostnames are blocked');
    expect(localTargetRefusal(refused('a$(id).internal'), ORIGIN)).toBeNull();
    expect(localTargetRefusal({ ok: false, refused: 'url', reason: 'invalid url' }, ORIGIN)).toBeNull();
  });
});
