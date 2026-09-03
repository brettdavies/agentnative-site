// Every Worker record goes through the emitter. A raw console call under
// src/worker would bypass the closed scope vocabulary, the boundary caps,
// and the swallow posture, and the sink-based test captures would never see
// it, so the convention is enforced here rather than trusted.

import { expect, test } from 'bun:test';
import { Glob } from 'bun';

const EMITTER = 'src/worker/telemetry/log.ts';
const RAW_CONSOLE = /\bconsole\.(log|warn|error|info|debug)\s*\(/;

test('no Worker module outside the emitter calls console directly', async () => {
  const offenders: string[] = [];
  for await (const path of new Glob('src/worker/**/*.ts').scan('.')) {
    if (path === EMITTER || path.endsWith('.d.ts')) continue;
    const source = await Bun.file(path).text();
    source.split('\n').forEach((line, index) => {
      if (RAW_CONSOLE.test(line) && !line.trimStart().startsWith('//')) offenders.push(`${path}:${index + 1}`);
    });
  }
  expect(offenders).toEqual([]);
});
