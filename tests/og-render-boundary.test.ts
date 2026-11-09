// The site Worker reaches the render Worker only over its RENDER service
// binding. An import from src/og-render/ would pull resvg, the card fonts
// and the drawing code back into the site bundle.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const IMPORT_RE = /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g;

describe('render Worker import boundary', () => {
  test('no module under src/worker/ imports from src/og-render/', () => {
    const offenders: string[] = [];
    for (const file of new Bun.Glob('src/worker/**/*.ts').scanSync({ cwd: ROOT })) {
      const source = readFileSync(join(ROOT, file), 'utf8');
      for (const match of source.matchAll(IMPORT_RE)) {
        if (!match[1].startsWith('.')) continue;
        const target = relative(ROOT, resolve(ROOT, dirname(file), match[1]));
        if (target.startsWith('src/og-render/')) offenders.push(`${file}: ${match[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
