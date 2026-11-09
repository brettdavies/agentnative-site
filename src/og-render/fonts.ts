/// <reference path="./bundled-modules.ts" />
// Static cuts of the site's OFL faces, instanced from public/fonts/full at
// weights the card actually uses (Uncut Sans 600 and 700, Monaspace Xenon
// Medium). resvg does not load the variable woff2 files the pages use. They
// bundle into the render Worker as Data modules; the public site does not
// serve them.

import mono from './fonts/monaspace-xenon-500.otf';
import semibold from './fonts/uncut-sans-600.ttf';
import bold from './fonts/uncut-sans-700.ttf';
import { bundledBytes, type ScoreOgFonts } from './render';

let cached: Promise<ScoreOgFonts> | null = null;

export function loadScoreOgFonts(): Promise<ScoreOgFonts> {
  cached ??= Promise.all([semibold, bold, mono].map(bundledBytes)).then(
    ([regular, heavy, monospace]) => [regular, heavy, monospace] as const,
  );
  return cached;
}
