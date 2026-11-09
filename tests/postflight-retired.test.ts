// scripts/release/postflight.sh's `retired` gate reads each retired redirect
// from the deployed edge after a release purges the zone. Its rows are bash
// literals, so this holds them to the table the Worker serves.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RETIRED_REDIRECTS } from '../src/shared/audit-routes';
import { REPO_ROOT } from './helpers/workflows';

const POSTFLIGHT = join(REPO_ROOT, 'scripts/release/postflight.sh');

/** The gate's `<path>|<location>` rows, keyed by path. */
function gateRedirects(): Map<string, string> {
  const script = readFileSync(POSTFLIGHT, 'utf8');
  const block = /^RETIRED_REDIRECTS=\(\n([\s\S]*?)^\)/m.exec(script);
  if (!block) throw new Error('RETIRED_REDIRECTS=( ... ) not found in scripts/release/postflight.sh');
  return new Map([...block[1].matchAll(/^\s*"([^"|]+)\|([^"]+)"/gm)].map(([, path, location]) => [path, location]));
}

describe('postflight retired gate', () => {
  test('checks every retired redirect the Worker serves, at the same destination', () => {
    const gate = gateRedirects();
    for (const [path, location] of Object.entries(RETIRED_REDIRECTS)) {
      expect(gate.get(path), `scripts/release/postflight.sh RETIRED_REDIRECTS must carry "${path}|${location}"`).toBe(
        location,
      );
    }
  });
});
