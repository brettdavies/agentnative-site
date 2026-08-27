// Extract canonical install commands from content/install.md.
// Those fences are the sole authored source (regression #6); the header pill
// and any other surface MUST pull through this helper rather than re-stating
// the command strings in src/.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * @param {string} contentDir absolute path to content/
 * @returns {{ brew: string, cargo: string, binstall: string }}
 */
export function loadInstallCommands(contentDir) {
  const md = readFileSync(join(contentDir, 'install.md'), 'utf8');
  const fenced = [...md.matchAll(/```bash\n([^\n]+)\n```/g)].map((m) => m[1].trim());
  const brew = fenced.find((c) => /^brew install\b/.test(c));
  const cargo = fenced.find((c) => /^cargo install\b/.test(c));
  const binstall = fenced.find((c) => /^cargo binstall\b/.test(c));
  if (!brew || !cargo || !binstall) {
    throw new Error(
      'content/install.md must contain fenced `brew install …`, `cargo install …`, and `cargo binstall …` commands',
    );
  }
  return { brew, cargo, binstall };
}
