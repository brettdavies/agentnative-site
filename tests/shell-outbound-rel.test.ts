import { describe, expect, test } from 'bun:test';
import { AI_PROVIDERS, emitShell } from '../src/build/shell.mjs';

const html = emitShell({
  title: 'About',
  description: 'About anc.dev',
  canonicalPath: '/about',
  breadcrumb: 'About',
  bodyHtml: '<article>body</article>',
  themeInitJs: '/* theme init */',
  baseUrl: undefined,
});

function region(open: string, close: string): string {
  const start = html.indexOf(open);
  expect(start, `${open} is missing from the shell`).toBeGreaterThan(-1);
  return html.slice(start, html.indexOf(close, start));
}

function anchorTags(markup: string): string[] {
  return markup.match(/<a\b[^>]*>/g) ?? [];
}

describe('emitShell: outbound links tell the destination the visit came from anc.dev', () => {
  const askAi = anchorTags(region('<div class="ai-summary__icons">', '</div>'));
  const sourceRepos = anchorTags(region('<p class="site-footer__source">', '</p>'));

  test('no anchor in the shell carries a noreferrer token', () => {
    expect(anchorTags(html).filter((tag) => tag.includes('noreferrer'))).toEqual([]);
  });

  test('every "Ask <assistant>" link is rel="noopener"', () => {
    expect(askAi).toHaveLength(AI_PROVIDERS.length);
    for (const tag of askAi) expect(tag).toContain(' rel="noopener" ');
  });

  test('every footer source-repo link is rel="noopener"', () => {
    expect(sourceRepos.length).toBeGreaterThan(0);
    for (const tag of sourceRepos) expect(tag).toContain(' rel="noopener">');
  });
});
