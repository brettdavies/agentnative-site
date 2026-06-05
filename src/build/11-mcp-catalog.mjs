// MCP catalog emit. Section 11 of the build pipeline.
//
// Emits `dist/_internal/mcp-catalog.json` — the denormalized projection
// of the registry-index, the eight principles (content + coverage matrix
// rows), and the vendored spec sections. The Worker's MCP module loads
// this artifact once per isolate via `env.ASSETS.fetch` and caches the
// parsed object in module scope (KTD-5 of the MCP endpoint plan).
//
// The `/_internal/` prefix is hard-404'd from public access in
// `src/worker/index.ts`; the Worker's own asset fetch bypasses the
// interceptor by not re-entering dispatch.

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { extractTitle } from './content.mjs';

const SPEC_RE = /^p(\d+)-([a-z0-9-]+)\.md$/;

/**
 * Build a denormalized MCP catalog from already-loaded inputs.
 *
 * Pure function so the unit test can exercise every invariant against
 * synthetic fixtures without hitting disk.
 *
 * @param {object} args
 * @param {{ by_slug: Record<string, object> }} args.registryIndex
 * @param {Array<{ n: number, slug: string, body: string }>} args.principles
 * @param {Array<{ id: string, principle: number, level: string, summary: string, verifiers?: Array<{ audit_id: string }> }>} args.coverageRows
 * @param {Array<{ slug: string, title: string, body: string, level: number, parent_slug?: string|null }>} args.specSections
 * @param {string} args.specVersion
 * @param {string} args.generatedAt — ISO-8601 Z-suffixed
 * @returns {object}
 */
export function buildMcpCatalog({ registryIndex, principles, coverageRows, specSections, specVersion, generatedAt }) {
  const registry = Object.entries(registryIndex.by_slug)
    .map(([slug, entry]) => ({ slug, ...entry }))
    .sort((a, b) => a.slug.localeCompare(b.slug));

  const rowsByPrinciple = new Map();
  for (const row of coverageRows) {
    if (!rowsByPrinciple.has(row.principle)) rowsByPrinciple.set(row.principle, []);
    rowsByPrinciple.get(row.principle).push(row);
  }

  const principlesOut = principles
    .map(({ n, slug, body }) => ({
      n,
      slug,
      title: extractTitle(body),
      body_markdown: body,
      requirements: (rowsByPrinciple.get(n) ?? []).map((r) => ({
        id: r.id,
        level: r.level,
        summary: r.summary,
        audit_ids: (r.verifiers ?? []).map((v) => v.audit_id).filter(Boolean),
      })),
    }))
    .sort((a, b) => a.n - b.n);

  const specOut = specSections
    .map((s) => ({
      slug: s.slug,
      title: s.title,
      level: s.level,
      parent_slug: s.parent_slug ?? null,
      body_markdown: s.body,
    }))
    .sort((a, b) => a.slug.localeCompare(b.slug));

  return {
    generated_at: generatedAt,
    spec_version: specVersion,
    registry,
    principles: principlesOut,
    spec_sections: specOut,
  };
}

async function loadPrinciples(principlesDir) {
  const entries = await readdir(principlesDir);
  const out = [];
  for (const name of entries) {
    const m = name.match(SPEC_RE);
    if (!m) continue;
    const body = await readFile(join(principlesDir, name), 'utf8');
    out.push({ n: Number(m[1]), slug: m[2], body });
  }
  return out.sort((a, b) => a.n - b.n);
}

async function loadSpecSections(specDir) {
  const out = [];

  const root = await readdir(specDir, { withFileTypes: true });
  for (const ent of root) {
    if (ent.isFile() && ent.name.endsWith('.md')) {
      const body = await readFile(join(specDir, ent.name), 'utf8');
      const slug = ent.name === 'README.md' ? 'readme' : ent.name.replace(/\.md$/, '').toLowerCase();
      out.push({ slug, title: extractTitle(body), body, level: 1, parent_slug: null });
    }
  }

  const principlesSubdir = join(specDir, 'principles');
  let principleEntries;
  try {
    principleEntries = await readdir(principlesSubdir);
  } catch {
    principleEntries = [];
  }
  for (const name of principleEntries) {
    if (!name.endsWith('.md')) continue;
    const body = await readFile(join(principlesSubdir, name), 'utf8');
    const slug = name.replace(/\.md$/, '');
    out.push({ slug, title: extractTitle(body), body, level: 2, parent_slug: null });
  }

  return out;
}

/**
 * Emit dist/_internal/mcp-catalog.json. Wraps buildMcpCatalog with the
 * filesystem loads + ensureDir + write.
 *
 * @param {object} args
 * @param {string} args.distDir
 * @param {string} args.repoRoot
 * @param {string=} args.generatedAt — optional override for deterministic tests.
 * @returns {Promise<{ path: string, registryCount: number, principleCount: number, specSectionCount: number }>}
 */
export async function emitMcpCatalog({ distDir, repoRoot, generatedAt }) {
  const internalDir = join(distDir, '_internal');
  await import('node:fs/promises').then((fs) => fs.mkdir(internalDir, { recursive: true }));

  const registryIndexPath = join(distDir, 'registry-index.json');
  const registryIndex = JSON.parse(await readFile(registryIndexPath, 'utf8'));

  const principles = await loadPrinciples(join(repoRoot, 'content', 'principles'));

  const coverageRaw = await readFile(join(repoRoot, 'src', 'data', 'coverage-matrix.json'), 'utf8');
  const coverageRows = JSON.parse(coverageRaw).rows ?? [];

  const specDir = join(repoRoot, 'src', 'data', 'spec');
  const specSections = await loadSpecSections(specDir);
  const specVersion = (await readFile(join(specDir, 'VERSION'), 'utf8')).trim();

  const catalog = buildMcpCatalog({
    registryIndex,
    principles,
    coverageRows,
    specSections,
    specVersion,
    generatedAt: generatedAt ?? new Date().toISOString(),
  });

  const outPath = join(internalDir, 'mcp-catalog.json');
  await writeFile(outPath, `${JSON.stringify(catalog, null, 2)}\n`);

  return {
    path: outPath,
    registryCount: catalog.registry.length,
    principleCount: catalog.principles.length,
    specSectionCount: catalog.spec_sections.length,
  };
}
