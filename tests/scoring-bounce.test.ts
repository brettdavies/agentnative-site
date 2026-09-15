import { describe, expect, test } from 'bun:test';
import { bouncePanel, INCOMPLETE_PANEL, NETWORK_PANEL, STREAM_LOST_PANEL } from '../src/client/scoring-bounce';
import type { AuditError } from '../src/shared/audit-events';

// The failed state's panels. A CLI code a visitor can act on carries its own
// copy, two codes read their stderr to tell apart the case they describe, and
// every other code falls back to the error's own message with nothing the
// request carried rendered as markup.

function err(code: string, over: Record<string, unknown> = {}): AuditError {
  return { code, message: 'The run stopped.', cta: 'Run it again.', ...over } as unknown as AuditError;
}

describe('bouncePanel: the codes that read their stderr', () => {
  test('a package the registry does not have is told apart from an install that ran and failed', () => {
    const missing = bouncePanel(err('chain_resolved_install_failed', { details: 'error: could not find package zzz' }));
    expect(missing.headline).toContain("isn't in the registry");

    const failed = bouncePanel(err('chain_resolved_install_failed', { details: 'error: exit status 1' }));
    expect(failed.headline).toContain("didn't run");
  });

  test('an archive missing its binary is told apart from a library that has none', () => {
    const archive = bouncePanel(
      err('chain_resolved_no_binary_produced', { details: 'Archive contains no binary named ouch' }),
    );
    expect(archive.headline).toContain('archive');

    const library = bouncePanel(err('chain_resolved_no_binary_produced', { details: 'installed 41 packages' }));
    expect(library.headline).toContain('library');
  });
});

describe('bouncePanel: the install paths the sandbox refuses', () => {
  test('each package manager names the alternative that works', () => {
    expect(bouncePanel(err('install_unsupported', { pm: 'brew' })).headline).toContain('Homebrew');
    expect(bouncePanel(err('install_unsupported', { pm: 'go_no_binary' })).headline).toContain('Go module');
    expect(bouncePanel(err('install_unsupported', { pm: 'something-else' })).headline).toContain("isn't supported");
  });

  test('the Bun panel lowercases the install link rather than leaving it mid-sentence', () => {
    const panel = bouncePanel(err('install_unsupported', { pm: 'bun' }));
    expect(panel.bodyHtml).toContain('install anc locally');
    expect(panel.bodyHtml).not.toContain('Install anc locally');
  });
});

describe('bouncePanel: the shared fallback', () => {
  test("an unrecognized code carries the error's own message, with its call to action escaped", () => {
    const panel = bouncePanel(
      err('some_code_the_client_has_never_seen', { message: 'The audit stopped early.', cta: '<img src=x onerror=1>' }),
    );
    expect(panel.headline).toBe('The audit stopped early.');
    expect(panel.bodyHtml).toContain('&lt;img');
    expect(panel.bodyHtml).not.toContain('<img');
  });

  test('a rate limit names the wait', () => {
    expect(bouncePanel(err('rate_limited', { retry_after: 45 })).bodyHtml).toContain('45 s');
  });

  test('stderr past the cap is cut and says so, so the panel stays readable', () => {
    const panel = bouncePanel(err('chain_resolved_install_failed', { details: 'x'.repeat(2500) }));
    expect(panel.details).toContain('(truncated)');
    expect((panel.details ?? '').length).toBeLessThan(2500);
  });
});

describe('the panels that carry no error object', () => {
  test('each names what happened and what to do', () => {
    for (const panel of [INCOMPLETE_PANEL, STREAM_LOST_PANEL, NETWORK_PANEL]) {
      expect(panel.headline.length).toBeGreaterThan(0);
      expect(panel.bodyHtml.length).toBeGreaterThan(0);
    }
    expect(INCOMPLETE_PANEL.bodyHtml).toContain('Nothing was saved');
    expect(STREAM_LOST_PANEL.bodyHtml).toContain('may still be running');
    expect(NETWORK_PANEL.headline).toContain('could not be reached');
  });
});
