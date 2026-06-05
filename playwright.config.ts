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
  // Failure artifacts (traces, screenshots, error-context) land under
  // .context/test-results/ — gitignored, organized with the rest of the
  // local-only ce-work scratch directory.
  outputDir: './.context/test-results',
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
      // Live opt-in projects (skill, homepage-score-live, staging-mcp)
      // are excluded from the default suite — they hit real network
      // endpoints (github.com clone hosts, the staging Worker) that the
      // deep-check daily schedule shouldn't depend on.
      testIgnore: [
        /skill\.e2e\.ts/,
        /homepage-score-live\.e2e\.ts/,
        /mcp\.e2e\.ts/,
        /discoverability\.e2e\.ts/,
      ],
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
    {
      name: 'homepage-score-live',
      // Live staging Worker. Set ANC_STAGING_BASE_URL before invoking;
      // see tests/e2e/homepage-score-live.e2e.ts for full env contract.
      // Excluded from the default suite; run with --project=homepage-score-live.
      use: { ...devices['Desktop Chrome'] },
      testMatch: /homepage-score-live\.e2e\.ts/,
      // Real Sandbox container cold starts and Turnstile siteverify
      // round-trips push the per-test budget past Playwright's default.
      timeout: 120_000,
    },
    {
      name: 'staging-mcp',
      // Live staging Worker — MCP transport plus the four
      // discoverability surfaces (.well-known/{mcp, security.txt,
      // ai.txt}, llms.txt Programmatic access, /mcp-docs.{html,md}).
      // Set ANC_STAGING_BASE_URL before invoking (and
      // ANC_STAGING_ACCESS_CLIENT_ID/SECRET for headless Access auth).
      // Excluded from the default suite; run with `bun x playwright test
      // --project=staging-mcp` after a staging deploy or when triaging
      // an MCP regression the bun unit layer can't reproduce against
      // workerd.
      use: { ...devices['Desktop Chrome'] },
      testMatch: /(?:mcp|discoverability)\.e2e\.ts/,
    },
  ],
  webServer: {
    // --env staging: the staging-pinned Sandbox image is the one we keep
    // locally; the top-level prod image is rotated less frequently and
    // often isn't in the dev Docker cache, which makes `wrangler dev
    // --local` (no --env) fail with a misleading "container Sandbox does
    // not expose any ports" error during prepareContainerImagesForDev.
    // Using --env staging also gives the homepage-score E2E suite a real
    // TURNSTILE_SITEKEY var to substitute into the meta tag — matches
    // staging behavior directly.
    command: 'bun run build && bun x wrangler dev --local --env staging --port ' + PORT,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
