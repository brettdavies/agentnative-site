import { describe, expect, test } from 'bun:test';
import { renderAuditForm } from '../src/build/audit-form.mjs';

// The entry form is one component on two hosts. These tests pin that the two
// renders agree, that the no-JS submit only prefills the audit page, and
// that the lane-specific parts live in the lane's pane.

describe('the audit entry form', () => {
  test('both hosts render the same markup apart from the ids scoped to their page', () => {
    const home = renderAuditForm({ idPrefix: 'entryhome' });
    const audit = renderAuditForm({ idPrefix: 'entryaudit' });
    expect(home.replaceAll('entryhome', 'PAGE')).toBe(audit.replaceAll('entryaudit', 'PAGE'));
  });

  test('without JavaScript it is a GET to the audit page carrying the lane and the target, so a submit only prefills', () => {
    const html = renderAuditForm({ idPrefix: 'p' });
    expect(html).toMatch(/<form[^>]*method="get"[^>]*action="\/audit"/);
    expect(html).toContain('name="lane" value="cli"');
    expect(html).toContain('name="lane" value="web"');
    expect(html).toContain('name="target"');
    expect(html).not.toContain('/api/score');
  });

  test('the segment radios carry the page-scope ids that swap every [data-s] pane, CLI checked by default', () => {
    const html = renderAuditForm({ idPrefix: 'p' });
    expect(html).toContain('id="s-cli" checked');
    expect(html).toContain('id="s-web"');
  });

  test('the listing checkbox and the website examples sit in the website pane only', () => {
    const html = renderAuditForm({ idPrefix: 'p' });
    expect(html).toMatch(
      /<label class="audit-hero__optin" data-s="web">\s*<input type="checkbox" name="public_listing"/,
    );
    expect(html).toMatch(/<span data-s="web">[^<]*<button[^>]*data-audit-example="anc\.dev"/);
    expect(html).toMatch(/<span data-s="cli">[^<]*<button[^>]*data-audit-example="ripgrep"/);
  });

  test('the target input carries no length cap, so an over-long paste reaches the rejection message', () => {
    expect(renderAuditForm({ idPrefix: 'p' })).not.toContain('maxlength');
  });
});
