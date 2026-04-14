// Playwright config — spins up `wrangler dev --local` as the test server
// and runs every spec under tests/playwright/ in chromium. The webServer
// block is the cheap way to keep agents.spec.ts (curl-flavored) and
// flows.spec.ts (browser flows) pointing at the same origin.

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
    { name: 'mobile', use: { ...devices['Pixel 7'] }, testMatch: /flows\.e2e\.ts/ },
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
