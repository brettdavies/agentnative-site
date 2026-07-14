// Proof gate for the homepage's CSS-only surface toggle (DESIGN.md §4.15,
// plan KTD4): with JavaScript disabled, one radio change must swap the
// board, the spec index, and the try-form together, and back.
//
// Run:  bun docs/research/design/prove-has-toggle.mjs
// Uses the installed Google Chrome (PW-managed browser downloads stall on
// some dev machines); pass --channel <name> to override.

import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const channelFlag = process.argv.indexOf('--channel');
const channel = channelFlag !== -1 ? process.argv[channelFlag + 1] : 'chrome';
const fixture = fileURLToPath(new URL('./has-toggle-proof.html', import.meta.url));

const browser = await chromium.launch({ channel });
const ctx = await browser.newContext({ javaScriptEnabled: false });
const page = await ctx.newPage();
await page.goto(`file://${fixture}`);

const state = async () => ({
  boardCli: await page.locator('#board-cli').isVisible(),
  boardWeb: await page.locator('#board-web').isVisible(),
  specCli: await page.locator('#spec-cli').isVisible(),
  specWeb: await page.locator('#spec-web').isVisible(),
  formCli: await page.locator('form[data-s="cli"]').isVisible(),
  formWeb: await page.locator('form[data-s="web"]').isVisible(),
});

const expectState = (label, actual, cli) => {
  const want = { boardCli: cli, boardWeb: !cli, specCli: cli, specWeb: !cli, formCli: cli, formWeb: !cli };
  const bad = Object.entries(want).filter(([k, v]) => actual[k] !== v);
  if (bad.length > 0) {
    console.error(`FAIL ${label}: ${bad.map(([k]) => `${k}=${actual[k]}`).join(', ')}`);
    process.exitCode = 1;
  } else {
    console.log(`ok ${label}`);
  }
};

expectState('default (CLI, no JS)', await state(), true);
await page.locator('label[for="s-web"]').click();
expectState('after web click', await state(), false);
await page.locator('label[for="s-cli"]').click();
expectState('back to CLI', await state(), true);

await browser.close();
