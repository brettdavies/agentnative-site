// Shared access to built output for tests that assert on dist/ bytes.

import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

export function requireDistBuild(distDir: string): void {
  if (!existsSync(distDir)) {
    throw new Error(
      `Built output missing at ${distDir}. Run \`bun run build\` first: ` +
        'bun test does not build, and these tests read the shipped dist/ bytes.',
    );
  }
}

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(full)));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files;
}

export async function distStylesheets(distDir: string): Promise<{ file: string; css: string }[]> {
  const files = (await walk(distDir)).filter((f) => f.endsWith('.css')).sort();
  return Promise.all(files.map(async (file) => ({ file: relative(distDir, file), css: await readFile(file, 'utf8') })));
}
