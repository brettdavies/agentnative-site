// Web-audit registry projection: src/data/web-audit/registry.yaml →
// dist/_internal/web-audit-registry.json.
//
// The YAML is the single in-repo source (STAR) for the web audit;
// Workers have no YAML runtime, so this stage normalizes it to
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

export const WEB_AUDIT_HANDLERS = new Set(['http', 'cors-preflight', 'mcp', 'dns-doh', 'auth-md', 'webmcp']);
export const WEB_AUDIT_SITE_TYPES = new Set(['content', 'api', 'mcp', 'all']);
export const WEB_AUDIT_ANTECEDENTS = new Set([
  'none',
  'http-root',
  'html-root',
  'mcp-present',
  'mcp-auth',
  'api-surface',
  'schemas-ref',
  'docs-site',
  'root-llms-txt',
  'root-llms-full-txt',
  'robots-present',
  'auth-present',
]);
export const WEB_AUDIT_EVAL_RULES = new Set(['canonical-redirect', 'scoped-discovery']);

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
  const categoryOrder = doc.category_order;
  if (!Array.isArray(categoryOrder) || categoryOrder.length === 0) {
    throw new Error('web-audit registry: expected a top-level "category_order" array');
  }
  const categoryKeys = Object.keys(categories);
  if (categoryOrder.length !== categoryKeys.length || !categoryOrder.every((slug) => Object.hasOwn(categories, slug))) {
    throw new Error('web-audit registry: category_order must list every categories key exactly once');
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
    if ('applies_to' in check) {
      throw new Error(
        `web-audit registry: check "${id}" carries the retired applies_to field — use site_types + antecedent`,
      );
    }
    if (!Array.isArray(check.site_types) || check.site_types.length === 0) {
      throw new Error(`web-audit registry: check "${id}" needs a non-empty site_types array`);
    }
    for (const st of check.site_types) {
      if (!WEB_AUDIT_SITE_TYPES.has(st)) {
        throw new Error(`web-audit registry: check "${id}" has invalid site_types entry "${st}"`);
      }
    }
    if (!WEB_AUDIT_ANTECEDENTS.has(check.antecedent)) {
      throw new Error(`web-audit registry: check "${id}" has unknown antecedent "${check.antecedent}"`);
    }
    if ('eval' in check && !WEB_AUDIT_EVAL_RULES.has(check.eval)) {
      throw new Error(`web-audit registry: check "${id}" has unknown eval rule "${check.eval}"`);
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
      site_types: check.site_types,
      antecedent: check.antecedent,
      ...('eval' in check ? { eval: check.eval } : {}),
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
    category_order: categoryOrder,
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

// MCP-shape checks that carry an evidence-template block (KTD/Round-4).
export const EVIDENCE_TEMPLATE_CHECKS = new Set([
  'mcp-initialize',
  'mcp-capabilities',
  'mcp-tools-list',
  'mcp-unknown-method',
  'mcp-get-fast-fail',
  'mcp-cors-preflight',
  'mcp-cors-actual',
]);

const EVIDENCE_SLOT = '{{evidence}}';

/**
 * Validate + normalize the remediation catalog against the set of check
 * ids. Pure. Asserts 1:1 coverage (every check has remediation, no
 * orphan remediation) and that every MCP-shape check carries the
 * evidence-template slot.
 *
 * @param {object} doc — js-yaml load of remediation.yaml
 * @param {string[]} checkIds — ids from the normalized registry
 * @returns {Record<string, { title: string, body: string, evidence_template: boolean }>}
 */
export function normalizeWebRemediation(doc, checkIds) {
  const remediation = doc?.remediation;
  if (!remediation || typeof remediation !== 'object') {
    throw new Error('web-audit remediation.yaml: expected a top-level "remediation" mapping');
  }
  const out = {};
  for (const [id, entry] of Object.entries(remediation)) {
    if (!entry || typeof entry.title !== 'string' || typeof entry.body !== 'string') {
      throw new Error(`web-audit remediation: entry "${id}" needs a string title and body`);
    }
    const evidenceTemplate = entry.evidence_template === true;
    if (EVIDENCE_TEMPLATE_CHECKS.has(id) && !entry.body.includes(EVIDENCE_SLOT)) {
      throw new Error(`web-audit remediation: MCP-shape check "${id}" must carry the ${EVIDENCE_SLOT} evidence slot`);
    }
    out[id] = { title: entry.title, body: entry.body, evidence_template: evidenceTemplate };
  }
  const ids = new Set(checkIds);
  for (const id of checkIds) {
    if (!out[id]) throw new Error(`web-audit remediation: check "${id}" has no remediation entry`);
  }
  for (const id of Object.keys(out)) {
    if (!ids.has(id)) throw new Error(`web-audit remediation: orphan remediation "${id}" matches no check`);
  }
  return out;
}

/**
 * Load + validate the remediation catalog and emit its JSON projection.
 *
 * @param {{ remediationPath: string, registryPath: string, distDir: string }} opts
 * @returns {Promise<{ entries: number }>}
 */
export async function emitWebRemediation({ remediationPath, registryPath, distDir }) {
  const registry = normalizeWebAuditRegistry(yaml.load(await readFile(registryPath, 'utf8')));
  const doc = yaml.load(await readFile(remediationPath, 'utf8'));
  const normalized = normalizeWebRemediation(
    doc,
    registry.checks.map((c) => c.id),
  );
  await writeFile(join(distDir, '_internal', 'web-remediation.json'), `${JSON.stringify(normalized, null, 2)}\n`);
  return { entries: Object.keys(normalized).length };
}
