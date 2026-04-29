// Playwright config — spins up `wrangler dev --local` as the test server
// and runs every `*.e2e.ts` spec under tests/e2e/. The webServer block
// keeps agents.e2e.ts (Worker integration via fetch) and flows.e2e.ts
// (browser flows) pointing at the same origin.
//
// Project matrix:
//   chromium       — desktop Chrome. Runs every spec EXCEPT skill.e2e.ts.
//                    Primary project for the default `bun run test:e2e`.
//   mobile-android — Pixel 7, Android Chrome. Runs flows only.
//   mobile-ios     — iPhone 13, iOS Safari (WebKit). Runs flows only.
//   tablet         — iPad Pro 11, iPadOS Safari (WebKit). Runs flows only.
//   skill          — Live network e2e for skill distribution. Excluded from
//                    the default suite so deep-check's daily schedule does
//                    not break against the still-private producer pre-cutover.
//                    Run with `bun x playwright test --project=skill`.
//
// WebKit projects require `bun x playwright install webkit` locally and
// the matching `--with-deps` line in .github/workflows/ci.yml.

import { defineConfig, devices } from '@playwright/test';

const PORT = 8787;
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: /\.e2e\.ts$/,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  // Tests within a single spec file run in parallel; each test gets a
  // fresh browser context so localStorage / URL state don't leak between
  // them. `wrangler dev` handles concurrent requests without issue.
  fullyParallel: true,
  workers: process.env.CI ? 3 : undefined,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      testIgnore: /skill\.e2e\.ts/,
    },
    { name: 'mobile-android', use: { ...devices['Pixel 7'] }, testMatch: /flows\.e2e\.ts/ },
    { name: 'mobile-ios', use: { ...devices['iPhone 13'] }, testMatch: /flows\.e2e\.ts/ },
    { name: 'tablet', use: { ...devices['iPad Pro 11'] }, testMatch: /flows\.e2e\.ts/ },
    {
      name: 'skill',
      use: { ...devices['Desktop Chrome'] },
      testMatch: /skill\.e2e\.ts/,
      // Live `git clone` against github.com over the network — give it room.
      timeout: 60_000,
    },
  ],
  webServer: {
    command: 'bun run build && bun x wrangler dev --local --port ' + PORT,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
