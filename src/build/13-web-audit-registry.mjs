// Web-audit registry projection: src/data/web-audit/registry.yaml →
// dist/_internal/web-audit-registry.json.
//
// The YAML is the single in-repo source (STAR) for the 32-check web
// audit; Workers have no YAML runtime, so this stage normalizes it to
// JSON the same way registry-index.mjs projects registry.yaml. The
// Worker's /_internal/ interceptor hard-404s public access; the engine
// reads via env.ASSETS.fetch (src/worker/audit-web/registry.ts).
//
// `keyword` is DERIVED here from `tier` (required→must, recommended→
// should, optional→may), never hand-authored — a `keyword` field in the
// YAML aborts the build so the two can't drift.

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import yaml from 'js-yaml';

export const KEYWORD_BY_TIER = Object.freeze({
  required: 'must',
  recommended: 'should',
  optional: 'may',
});

export const WEB_AUDIT_HANDLERS = new Set(['http', 'cors-preflight', 'mcp', 'dns-doh']);
export const WEB_AUDIT_APPLIES_TO = new Set(['any', 'docs-site', 'mcp-present']);

const PRINCIPLE_RE = /^P[1-8]$/;
const CHECK_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Validate + normalize a parsed registry document. Pure. Throws a named
 * error on any missing/invalid field so the build fails loudly.
 *
 * @param {object} doc — js-yaml load of src/data/web-audit/registry.yaml
 * @returns {{ version: number, mcp_discovery: object, categories: Record<string,string>, checks: Array<object> }}
 */
export function normalizeWebAuditRegistry(doc) {
  if (!doc || typeof doc !== 'object') {
    throw new Error('web-audit registry: expected a YAML mapping at the top level');
  }
  const discovery = doc.mcp_discovery;
  if (
    !discovery ||
    !Array.isArray(discovery.well_known) ||
    !Array.isArray(discovery.common_paths) ||
    typeof discovery.protocol_version !== 'string'
  ) {
    throw new Error('web-audit registry: mcp_discovery must carry well_known[], common_paths[], protocol_version');
  }
  const categories = doc.categories;
  if (!categories || typeof categories !== 'object') {
    throw new Error('web-audit registry: expected a top-level "categories" mapping');
  }
  const checks = doc.checks;
  if (!Array.isArray(checks) || checks.length === 0) {
    throw new Error('web-audit registry: expected a non-empty top-level "checks" array');
  }

  const seen = new Set();
  const normalized = checks.map((check) => {
    const id = check?.id;
    if (typeof id !== 'string' || !CHECK_ID_RE.test(id)) {
      throw new Error(`web-audit registry: check id ${JSON.stringify(id)} must match /^[a-z0-9][a-z0-9-]*$/`);
    }
    if (seen.has(id)) throw new Error(`web-audit registry: duplicate check id "${id}"`);
    seen.add(id);

    if (!Object.hasOwn(categories, check.category)) {
      throw new Error(`web-audit registry: check "${id}" names unknown category "${check.category}"`);
    }
    const keyword = KEYWORD_BY_TIER[check.tier];
    if (!keyword) {
      throw new Error(
        `web-audit registry: check "${id}" has invalid tier "${check.tier}" (want required|recommended|optional)`,
      );
    }
    if ('keyword' in check && check.keyword !== keyword) {
      throw new Error(
        `web-audit registry: check "${id}" hand-authors keyword "${check.keyword}" but tier "${check.tier}" derives "${keyword}" — remove the keyword field`,
      );
    }
    if ('keyword' in check) {
      throw new Error(
        `web-audit registry: check "${id}" hand-authors a keyword field — keyword is derived from tier at build time`,
      );
    }
    if (typeof check.principle !== 'string' || !PRINCIPLE_RE.test(check.principle)) {
      throw new Error(
        `web-audit registry: check "${id}" needs a principle in P1..P8 (got ${JSON.stringify(check.principle)})`,
      );
    }
    const appliesTo = check.applies_to ?? 'any';
    if (!WEB_AUDIT_APPLIES_TO.has(appliesTo)) {
      throw new Error(`web-audit registry: check "${id}" has invalid applies_to "${appliesTo}"`);
    }
    if (!Number.isInteger(check.weight) || check.weight <= 0) {
      throw new Error(
        `web-audit registry: check "${id}" needs a positive integer weight (got ${JSON.stringify(check.weight)})`,
      );
    }
    if (typeof check.title !== 'string' || check.title.length === 0) {
      throw new Error(`web-audit registry: check "${id}" missing title`);
    }
    if (typeof check.hint !== 'string' || check.hint.length === 0) {
      throw new Error(`web-audit registry: check "${id}" missing hint`);
    }
    if (!WEB_AUDIT_HANDLERS.has(check.handler)) {
      throw new Error(`web-audit registry: check "${id}" names unknown handler "${check.handler}"`);
    }
    if (!check.with || typeof check.with !== 'object') {
      throw new Error(`web-audit registry: check "${id}" missing "with" handler parameters`);
    }

    return {
      id,
      category: check.category,
      tier: check.tier,
      keyword,
      principle: check.principle,
      applies_to: appliesTo,
      weight: check.weight,
      title: check.title,
      hint: check.hint,
      handler: check.handler,
      with: check.with,
    };
  });

  return {
    version: doc.version ?? 1,
    mcp_discovery: {
      well_known: discovery.well_known,
      common_paths: discovery.common_paths,
      protocol_version: discovery.protocol_version,
    },
    categories,
    checks: normalized,
  };
}

/**
 * Load, normalize, and emit the web-audit registry projection.
 *
 * @param {{ registryPath: string, distDir: string }} opts
 * @returns {Promise<{ checks: number }>}
 */
export async function emitWebAuditRegistry({ registryPath, distDir }) {
  const raw = await readFile(registryPath, 'utf8');
  const normalized = normalizeWebAuditRegistry(yaml.load(raw));
  await writeFile(join(distDir, '_internal', 'web-audit-registry.json'), `${JSON.stringify(normalized, null, 2)}\n`);
  return { checks: normalized.checks.length };
}
