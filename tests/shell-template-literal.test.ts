import { describe, expect, test } from 'bun:test';
import { BREADCRUMB_JSONLD_TOKEN } from '../src/shared/breadcrumb';
import { substituteShell } from '../src/worker/shell-template';

const TEMPLATE = [
  '<title>{{TITLE}}</title>',
  '<meta content="{{DESCRIPTION}}">',
  '<link href="{{CANONICAL_PATH}}">',
  '<link href="{{MARKDOWN_TWIN_PATH}}">',
  '{{ALTERNATES}}',
  '<meta content="{{OG_IMAGE}}">',
  '<meta content="{{OG_IMAGE_ALT}}">',
  '{{OG_VIDEO}}',
  '{{BREADCRUMB_NAV}}',
  '<main>{{BODY}}</main>',
].join('\n');

const PATTERNS = ['$&', '$`', "$'", '$$', '$1'];

function render(overrides: Partial<Parameters<typeof substituteShell>[1]>): string {
  return substituteShell(TEMPLATE, {
    title: 'title',
    description: 'description',
    canonicalPath: '/score/tool',
    breadcrumb: 'tool',
    body: 'body',
    ...overrides,
  });
}

describe('substituteShell keeps replacement text literal', () => {
  test('a path and breadcrumb holding a dollar sequence render as written in the link, twin, nav, and JSON-LD slots', () => {
    const html = substituteShell(`${TEMPLATE}\n[{},"${BREADCRUMB_JSONLD_TOKEN}"]`, {
      title: 'title',
      description: 'description',
      canonicalPath: '/score/a$&b',
      markdownTwinPath: '/score/twin$&c',
      breadcrumb: 'crumb$&d',
      body: 'body',
    });
    expect(html).toContain('<link href="/score/a$&amp;b">');
    expect(html).toContain('<link href="/score/twin$&amp;c">');
    expect(html).toContain('crumb$&amp;d');
    expect(html).toContain('"name":"crumb$&d"');
    expect(html).not.toContain('{{');
  });

  test.each(PATTERNS)('a body containing %s', (pattern) => {
    const html = render({ body: `<p>cost ${pattern} here</p>` });
    expect(html).toContain(`<main><p>cost ${pattern} here</p></main>`);
    expect(html.match(/<main>/g)).toHaveLength(1);
  });

  test.each(PATTERNS)('raw alternates and video markup containing %s', (pattern) => {
    const html = render({ alternatesHtml: `<a data-x="${pattern}">`, ogVideoHtml: `<b data-y="${pattern}">` });
    expect(html).toContain(`<a data-x="${pattern}">`);
    expect(html).toContain(`<b data-y="${pattern}">`);
  });

  test('a title holding an apostrophe after a dollar sign renders as its escaped text', () => {
    const html = render({ title: "cost$'s" });
    expect(html).toContain('<title>cost$&#39;s</title>');
    expect(html).not.toContain('{{TITLE}}');
  });

  test('a description, image, and image text holding an apostrophe after a dollar sign render as their escaped text', () => {
    const html = render({ description: "a$'b", ogImage: "/i$'.png", ogImageAlt: "alt$'" });
    expect(html).toContain('<meta content="a$&#39;b">');
    expect(html).toContain('<meta content="/i$&#39;.png">');
    expect(html).toContain('<meta content="alt$&#39;">');
  });
});
