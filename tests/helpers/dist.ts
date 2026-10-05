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

export async function distStylesheets(distDir: string): Promise<{ file: string; css: string }[]> {
  const entries = await readdir(distDir, { recursive: true, withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.css'))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
  return Promise.all(files.map(async (file) => ({ file: relative(distDir, file), css: await readFile(file, 'utf8') })));
}

/** A Worker env whose assets are the files of a built dist/ directory. */
export function distAssetsEnv(distDir: string): { ASSETS: Fetcher } {
  return {
    ASSETS: {
      async fetch(input: Request | string): Promise<Response> {
        const path = new URL(typeof input === 'string' ? input : input.url).pathname;
        try {
          return new Response(await readFile(join(distDir, path)), { status: 200 });
        } catch {
          return new Response('not found', { status: 404 });
        }
      },
    } as unknown as Fetcher,
  };
}
