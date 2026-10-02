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
      /<div class="audit-form__web" data-s="web">[\s\S]*<input type="checkbox" name="public_listing"[\s\S]*<\/div>/,
    );
    expect(html).toMatch(/<span data-s="web">[^<]*<button[^>]*data-audit-example="anc\.dev"/);
    expect(html).toMatch(/<span data-s="cli">[^<]*<button[^>]*data-audit-example="ripgrep"/);
  });

  test('the follow checkbox sits in the website pane, checked by default, described by its help line', () => {
    const html = renderAuditForm({ idPrefix: 'p' });
    const pane = html.slice(
      html.indexOf('<div class="audit-form__web" data-s="web">'),
      html.indexOf('</div>', html.indexOf('audit-form__web')),
    );
    expect(pane).toMatch(
      /<input type="checkbox" name="follow_declarations" value="true" checked aria-describedby="p-follow-help" data-audit-follow \/>\s*Include hosts this site declares \(MCP server, API\)/,
    );
    expect(pane).toContain(
      '<p id="p-follow-help" class="audit-form__note">anc sends a few requests to each host the site points to. Unchecked, the result is not saved or listed.</p>',
    );
    // The follow choice comes before the listing choice it gates.
    expect(pane.indexOf('data-audit-follow')).toBeLessThan(pane.indexOf('data-audit-listing'));
  });

  test('the note the listing box points at while following is off starts hidden and undescribed', () => {
    const html = renderAuditForm({ idPrefix: 'p' });
    expect(html).toContain(
      '<p id="p-listing-note" class="audit-form__note" data-audit-listing-note hidden>Results without declared hosts are not saved or listed.</p>',
    );
    expect(html).toMatch(/<input type="checkbox" name="public_listing" value="true" data-audit-listing \/>/);
  });

  test('the target input carries no length cap, so an over-long paste reaches the rejection message', () => {
    expect(renderAuditForm({ idPrefix: 'p' })).not.toContain('maxlength');
  });
});
