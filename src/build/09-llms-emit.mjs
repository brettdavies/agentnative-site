// llms.txt + llms-full.txt emit. Section 9 of the build pipeline.
//
// llms.txt is the structured index per https://llmstxt.org/ — H1 title, a
// `>` summary line, then sections listing every page as a markdown link.
// llms-full.txt embeds each page's markdown body verbatim with the .md-twin
// absolutification policy so site-relative links resolve when an agent
// fetches /llms-full.txt directly.

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildLlmsFull, buildLlmsIndex } from './llms.mjs';
import { buildLeaderboardMarkdown } from './scorecards-render.mjs';
import { absolutifyMarkdownLinks } from './util.mjs';

/**
 * Emit dist/llms.txt and dist/llms-full.txt.
 *
 * @param {object} args
 * @param {string} args.distDir
 * @param {string} args.introTitle
 * @param {string} args.introSummary
 * @param {string} args.introSource
 * @param {Array<{n: number, slug: string, title: string, source: string}>} args.principles
 * @param {Array<{name: string, source: string, title: string}>} args.subPageData
 * @param {Array<object>} args.leaderboard         — per-tool entries; .tool.name is the canonical slug
 * @param {string} args.coverageMarkdown            — pre-built coverage page body
 * @param {object} args.skillData                   — manifest object; .name embedded in the section heading
 * @param {string} args.skillMarkdown               — pre-built skill page body
 */
export async function emitLlmsSurface({
  distDir,
  introTitle,
  introSummary,
  introSource,
  principles,
  subPageData,
  leaderboard,
  coverageMarkdown,
  skillData,
  skillMarkdown,
}) {
  const llmsIndex = buildLlmsIndex({
    introTitle,
    summary: introSummary,
    principles: principles.map((p) => ({ n: p.n, slug: p.slug, title: p.title })),
    subPages: subPageData.map((s) => ({ name: s.name, title: s.title })),
    scorecardLinks: [
      { name: 'Leaderboard', path: '/scorecards.md' },
      { name: 'Coverage Matrix', path: '/coverage.md' },
      // Per-tool scorecards alphabetical so the llms.txt index reads as a
      // browseable directory; the leaderboard itself owns rank-order presentation.
      ...leaderboard
        .map((e) => ({ name: e.tool.name, path: `/score/${e.tool.name}.md` }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    ],
    skillLinks: [
      { name: 'Skill (HTML)', path: '/skill.md' },
      { name: 'Skill (canonical JSON)', path: '/skill.json' },
    ],
  });
  await writeFile(join(distDir, 'llms.txt'), llmsIndex);

  // llms-full.txt embeds each page's markdown body verbatim. Apply the same
  // .md-twin absolutification policy so site-relative links resolve when an
  // agent fetches /llms-full.txt directly.
  const llmsFull = buildLlmsFull({
    sections: [
      { title: introTitle, body: absolutifyMarkdownLinks(introSource), htmlPath: '/', mdPath: '/index.md' },
      ...principles.map((p) => ({
        title: p.title,
        body: absolutifyMarkdownLinks(p.source),
        htmlPath: `/p${p.n}`,
        mdPath: `/p${p.n}.md`,
      })),
      ...subPageData.map((s) => ({
        title: s.title,
        body: absolutifyMarkdownLinks(s.source),
        htmlPath: `/${s.name}`,
        mdPath: `/${s.name}.md`,
      })),
      {
        title: 'ANC 100 — Agent-Native CLI Leaderboard',
        body: absolutifyMarkdownLinks(buildLeaderboardMarkdown(leaderboard)),
        htmlPath: '/scorecards',
        mdPath: '/scorecards.md',
      },
      {
        title: 'Spec Coverage Matrix',
        body: absolutifyMarkdownLinks(coverageMarkdown),
        htmlPath: '/coverage',
        mdPath: '/coverage.md',
      },
      {
        title: `Install ${skillData.name}`,
        body: absolutifyMarkdownLinks(skillMarkdown),
        htmlPath: '/skill',
        mdPath: '/skill.md',
      },
    ],
  });
  await writeFile(join(distDir, 'llms-full.txt'), llmsFull);
}
