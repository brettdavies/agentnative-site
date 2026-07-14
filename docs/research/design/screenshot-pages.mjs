// Design-iteration screenshot tool. Captures the given site paths in
// light + dark at desktop (1440) and mobile (390) against a running dev
// server, for eyeballing against the prototype shots in
// .context/design-overhaul/prototype-shots/.
//
// Run:  bun docs/research/design/screenshot-pages.mjs [options] [path ...]
//   --base <url>     server origin        (default http://localhost:8787)
//   --out <dir>      output directory     (default /tmp/anc-shots)
//   --channel <name> browser channel      (default chrome — PW-managed
//                    browser downloads stall on some dev machines)
//   --full           full-page captures   (default viewport-height)
//   path ...         site paths           (default: /, /p1, /scorecards,
//                    /score/ripgrep, /web, /web-audit, /audit)
//
// Start the server first: bun run build && bun x wrangler dev --local
// --env staging --port 8787 --enable-containers=false

import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : fallback;
};
const base = flag('--base', 'http://localhost:8787');
const out = flag('--out', '/tmp/anc-shots');
const channel = flag('--channel', 'chrome');
const fullPage = args.includes('--full');
const pagePaths = (() => {
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      if (['--base', '--out', '--channel'].includes(args[i])) i += 1;
      continue;
    }
    positional.push(args[i]);
  }
  return positional.length > 0 ? positional : ['/', '/p1', '/scorecards', '/score/ripgrep', '/web', '/web-audit', '/audit'];
})();

mkdirSync(out, { recursive: true });
const slug = (p) => (p === '/' ? 'home' : p.replaceAll('/', '-').replace(/^-/, ''));

const browser = await chromium.launch({ channel });
for (const [scheme, width, tag] of [
  ['light', 1440, 'light-1440'],
  ['dark', 1440, 'dark-1440'],
  ['light', 390, 'light-390'],
]) {
  const ctx = await browser.newContext({
    viewport: { width, height: width < 600 ? 844 : 900 },
    colorScheme: scheme,
  });
  const page = await ctx.newPage();
  for (const path of pagePaths) {
    await page.goto(base + path, { waitUntil: 'networkidle' });
    const file = `${out}/${slug(path)}-${tag}.png`;
    await page.screenshot({ path: file, fullPage });
    console.log(file);
  }
  await ctx.close();
}
await browser.close();
