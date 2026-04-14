// Playwright config — spins up `wrangler dev --local` as the test server
// and runs every `*.e2e.ts` spec under tests/e2e/. The webServer block
// keeps agents.e2e.ts (Worker integration via fetch) and flows.e2e.ts
// (browser flows) pointing at the same origin.
//
// Project matrix:
//   chromium       — desktop Chrome. Runs every spec. Primary project.
//   mobile-android — Pixel 7, Android Chrome. Runs flows only.
//   mobile-ios     — iPhone 13, iOS Safari (WebKit). Runs flows only.
//   tablet         — iPad Pro 11, iPadOS Safari (WebKit). Runs flows only.
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
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile-android', use: { ...devices['Pixel 7'] }, testMatch: /flows\.e2e\.ts/ },
    { name: 'mobile-ios', use: { ...devices['iPhone 13'] }, testMatch: /flows\.e2e\.ts/ },
    { name: 'tablet', use: { ...devices['iPad Pro 11'] }, testMatch: /flows\.e2e\.ts/ },
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
