// 4-host skill-distribution install verification + bare-clone footgun
// check. This is the live-network e2e: it fetches /skill.json from the
// local Worker, runs every advertised host's clone command into a sandbox
// HOME, and asserts SKILL.md lands at the expected path on the skill
// repo's default branch.
//
// Isolation: this spec runs only under the `skill` Playwright project
// (see playwright.config.ts). It is excluded from the default `bun run
// test:e2e` run so the daily deep-check schedule does not break against
// the still-private producer repo before the Unit 5 cutover.
//
// Pre-cutover usage (producer is private):
//   ANC_SKILL_URL=git@github.com:brettdavies/agentnative-skill.git \
//     bun x playwright test --project=skill
//
// Post-cutover usage (producer is public — HTTPS works as advertised):
//   bun x playwright test --project=skill
//
// The URL override only swaps the clone source; the destination paths and
// host names are still drawn from /skill.json.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

const BASE = 'http://localhost:8787';
const URL_OVERRIDE = process.env.ANC_SKILL_URL;

interface Manifest {
  source: { url: string };
  install: Record<string, string>;
}

async function fetchManifest(request: import('@playwright/test').APIRequestContext): Promise<Manifest> {
  const res = await request.get(`${BASE}/skill.json`);
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toContain('application/json');
  return (await res.json()) as Manifest;
}

/**
 * Apply the SSH-URL override if the env var is set. Replaces the manifest's
 * HTTPS URL with the operator-supplied URL inside the host command. Leaves
 * the destination path (and every other token) intact.
 */
function rewriteCommand(command: string, manifestUrl: string): string {
  if (!URL_OVERRIDE) return command;
  return command.replace(manifestUrl, URL_OVERRIDE);
}

/**
 * Resolve a `~/...` destination against a sandbox HOME. The manifest emits
 * paths like `~/.claude/skills/agent-native-cli`; we need the absolute path
 * after substituting HOME with the test's tmpdir.
 */
function resolveDest(command: string, sandboxHome: string): string {
  const tokens = command.trim().split(/\s+/);
  const dest = tokens[tokens.length - 1];
  if (!dest.startsWith('~/')) {
    throw new Error(`expected ~-prefixed destination, got "${dest}"`);
  }
  return join(sandboxHome, dest.slice(2));
}

/** Run a shell command with a sandboxed HOME so ~ expands to the tmpdir. */
function runInSandbox(command: string, sandboxHome: string): void {
  execFileSync('bash', ['-c', command], {
    env: { ...process.env, HOME: sandboxHome },
    stdio: 'pipe',
  });
}

test.describe('skill-distribution install — 4-host live clone', () => {
  test('every advertised host clones and lands SKILL.md', async ({ request }) => {
    const manifest = await fetchManifest(request);
    expect(Object.keys(manifest.install).length).toBeGreaterThanOrEqual(1);

    for (const [host, rawCommand] of Object.entries(manifest.install)) {
      const sandboxHome = mkdtempSync(join(tmpdir(), `anc-install-${host}-`));
      try {
        const command = rewriteCommand(rawCommand, manifest.source.url);
        runInSandbox(command, sandboxHome);

        const dest = resolveDest(rawCommand, sandboxHome);
        // SKILL.md MUST land at the install dir root — the producer repo's
        // canonical entry point.
        const skillPath = join(dest, 'SKILL.md');
        expect({ host, exists: statSync(skillPath).isFile() }).toEqual({ host, exists: true });
      } finally {
        rmSync(sandboxHome, { recursive: true, force: true });
      }
    }
  });

  test('bare-clone footgun: clone without dest lands on agentnative-skill, not agent-native-cli', () => {
    // This test ASSERTS the asymmetry exists. The repo is named
    // agentnative-skill; the skill is named agent-native-cli. A bare
    // `git clone` with no destination produces a directory named after
    // the repo, not the skill — which is why every install command in
    // /skill.json MUST advertise an explicit destination path.
    const sandboxHome = mkdtempSync(join(tmpdir(), 'anc-install-bare-'));
    const manifestUrl = 'https://github.com/brettdavies/agentnative-skill.git';
    const url = URL_OVERRIDE ?? manifestUrl;
    try {
      execFileSync('git', ['clone', '--depth', '1', url], { cwd: sandboxHome, stdio: 'pipe' });
      const expectedDir = join(sandboxHome, 'agentnative-skill');
      expect(statSync(expectedDir).isDirectory()).toBe(true);
      // The install commands name agent-native-cli — confirm the bare clone
      // did NOT land there.
      let bareLandedOnSkillName = false;
      try {
        bareLandedOnSkillName = statSync(join(sandboxHome, 'agent-native-cli')).isDirectory();
      } catch {
        // intentional: missing path means bare clone correctly used repo name
      }
      expect(bareLandedOnSkillName).toBe(false);
    } finally {
      rmSync(sandboxHome, { recursive: true, force: true });
    }
  });
});
