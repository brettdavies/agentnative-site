// Static cuts of the site's OFL faces, instanced from public/fonts/full at
// weights the card actually uses (Uncut Sans 600 and 700, Monaspace Xenon
// Medium). resvg does not load the variable woff2 files the pages use.
// The build copies these into dist/_internal/og-fonts/; the public site
// does not serve them.

import type { ScoreOgFonts } from './render';

const FONT_PATHS = [
  '/_internal/og-fonts/uncut-sans-600.ttf',
  '/_internal/og-fonts/uncut-sans-700.ttf',
  '/_internal/og-fonts/monaspace-xenon-500.otf',
] as const;

let cached: { env: { ASSETS: Fetcher }; fonts: ScoreOgFonts } | null = null;

export async function loadScoreOgFonts(env: { ASSETS: Fetcher }): Promise<ScoreOgFonts> {
  if (cached && cached.env === env) return cached.fonts;
  const buffers = await Promise.all(
    FONT_PATHS.map(async (path) => {
      const res = await env.ASSETS.fetch(new Request(`https://assets.internal${path}`));
      if (!res.ok) throw new Error(`scorecard OG font missing: ${path} (${res.status})`);
      return new Uint8Array(await res.arrayBuffer());
    }),
  );
  const fonts = buffers as unknown as ScoreOgFonts;
  cached = { env, fonts };
  return fonts;
}

/** Test-only: drop the isolate cache. */
export function _resetScoreOgFonts(): void {
  cached = null;
}
