// The release orchestrators share the template's usage contract: `--help`
// prints the header comment and exits 0, and an unknown flag prints the same
// header and exits 2. The header ends past its `Exit codes:` block, so a
// truncated header loses that line.

import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { REPO_ROOT } from './helpers/workflows';

const SCRIPTS = [
  { name: 'preflight.sh', unknown: 'unknown arg: --bogus' },
  { name: 'postflight.sh', unknown: 'unknown arg: --bogus' },
  { name: 'mcp-smoke.sh', unknown: 'unknown flag: --bogus' },
];

function run(script: string, arg: string): { status: number; output: string } {
  const proc = Bun.spawnSync(['bash', join(REPO_ROOT, 'scripts/release', script), arg], { cwd: REPO_ROOT });
  return { status: proc.exitCode, output: proc.stdout.toString() + proc.stderr.toString() };
}

describe.each(SCRIPTS)('$name usage', ({ name, unknown }) => {
  test('--help prints the header and exits 0', () => {
    const { status, output } = run(name, '--help');
    expect(output).toContain('Exit codes:');
    expect(status).toBe(0);
  });

  test('an unknown flag prints the header and exits 2', () => {
    const { status, output } = run(name, '--bogus');
    expect(output).toContain(unknown);
    expect(output).toContain('Exit codes:');
    expect(status).toBe(2);
  });
});
