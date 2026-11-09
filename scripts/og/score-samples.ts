// Render sample scorecard cards for visual review:
//   bun scripts/og/score-samples.ts [out-dir]   (default .context/og-samples)
// Railway's score is read from the live JSON twin when it answers; the CLI
// cards are read from the committed scorecards. Logos use the same fetcher
// the Worker uses, and a failure becomes the wordmark.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cliOgIdentity, type ScoreOgCard, scoreOgEdition } from '../../src/shared/score-og';
import { resolveLogo } from '../../src/og-render/logo';
import { renderScoreOgPng, type ScoreOgFonts } from '../../src/og-render/render';

const ROOT = new URL('../..', import.meta.url);
const OUT = process.argv[2] ?? join(ROOT.pathname, '.context', 'og-samples');

async function fonts(): Promise<ScoreOgFonts> {
  const dir = new URL('../../src/og-render/fonts/', import.meta.url);
  const [regular, bold, mono] = await Promise.all([
    readFile(new URL('uncut-sans-600.ttf', dir)),
    readFile(new URL('uncut-sans-700.ttf', dir)),
    readFile(new URL('monaspace-xenon-500.otf', dir)),
  ]);
  return [new Uint8Array(regular), new Uint8Array(bold), new Uint8Array(mono)];
}

async function writeCard(name: string, card: ScoreOgCard, face: ScoreOgFonts): Promise<void> {
  const png = await renderScoreOgPng(card, face);
  const path = join(OUT, name);
  await writeFile(path, png);
  console.log(`${path} ${png.byteLength} ${card.name} ${card.scorePct ?? (card.pending ? 'pending' : 'unscored')}`);
}

async function logoFor(page: string | null, face: ScoreOgFonts): Promise<ScoreOgCard['logo']> {
  if (!page) return null;
  return (await resolveLogo({ pages: [page], fonts: face, budgetMs: 8_000 })).logo;
}

type CliFile = {
  spec_version?: string;
  badge?: { score_pct?: number };
  tool?: { name?: string; binary?: string; version?: string };
};

async function cliCard(file: string, slug: string, homepage: string | null, face: ScoreOgFonts): Promise<ScoreOgCard> {
  const scorecard = JSON.parse(await readFile(new URL(file, ROOT), 'utf8')) as CliFile;
  const identity = cliOgIdentity(slug, scorecard.tool, slug);
  return {
    ...identity,
    lane: 'cli',
    scorePct: scorecard.badge?.score_pct ?? null,
    pending: false,
    specVersion: scorecard.spec_version ?? null,
    edition: scoreOgEdition({ lane: 'cli', toolVersion: scorecard.tool?.version }),
    logo: await logoFor(homepage, face),
  };
}

const face = await fonts();
await mkdir(OUT, { recursive: true });

let railwayScore = 80;
let railwaySpec = '0.6.0';
let railwayScoredAt = '2026-10-26T12:00:00.000Z';
try {
  const live = await fetch('https://anc.dev/score/railway.com/json', { headers: { accept: 'application/json' } });
  if (live.ok) {
    const body = (await live.json()) as {
      score_pct?: unknown;
      spec_version?: unknown;
      freshness?: { scored_at?: unknown };
    };
    if (typeof body.score_pct === 'number') railwayScore = body.score_pct;
    if (typeof body.spec_version === 'string') railwaySpec = body.spec_version;
    if (typeof body.freshness?.scored_at === 'string') railwayScoredAt = body.freshness.scored_at;
  }
} catch {
  // The known public score stands when the twin cannot be read.
}

const railwayLogo = await logoFor('https://railway.com/', face);
await writeCard(
  'score-og-railway.png',
  {
    name: 'Railway',
    subtitle: 'railway.com',
    lane: 'web',
    scorePct: railwayScore,
    pending: false,
    specVersion: railwaySpec,
    edition: scoreOgEdition({ lane: 'web', scoredAt: railwayScoredAt }),
    logo: railwayLogo,
  },
  face,
);

await writeCard('score-og-curl.png', await cliCard('scorecards/curl-v8.22.0.json', 'curl', 'https://curl.se', face), face);
await writeCard('score-og-ripgrep.png', await cliCard('scorecards/ripgrep-v15.2.0.json', 'ripgrep', null, face), face);
await writeCard(
  'score-og-pending.png',
  {
    name: 'internationalized-software-foundation',
    subtitle: 'no homepage',
    lane: 'cli',
    scorePct: null,
    pending: true,
    specVersion: '0.6.0',
    edition: null,
    logo: null,
  },
  face,
);
