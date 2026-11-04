// Generates the CLI vendoring contract and reports how the committed copy
// differs from a fresh generation. The CLI reads this directory instead of
// this repo's sources, so a drifted file is a wrong input in another repo; the
// `--check` mode and the contract test both report through this module.

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { projectionBytes, projectWebRemediation } from '../../src/build/13-web-audit-registry.mjs';
import { VENDORED_CARD_SCHEMA_PATH } from '../../src/build/web-audit-card-schema.mjs';
import { AUDIT_USER_AGENT, PROBE_UA_TOKENS } from '../../src/shared/user-agents';
import { MAX_CATALOG_ANCHORS } from '../../src/worker/audit-web/api-catalog';
import { DISCOVERY_BUDGET_MS } from '../../src/worker/audit-web/discovery';
import { MAX_CATALOG_CARDS } from '../../src/worker/audit-web/discovery-documents';
import {
  DEFAULT_CONCURRENCY,
  DEFAULT_PER_AUDIT_DEADLINE_MS,
  DEFAULT_PER_CHECK_TIMEOUT_MS,
  DEGRADED_PER_CHECK_TIMEOUT_MS,
} from '../../src/worker/audit-web/engine';
import { CARD_DOCUMENT_TIMEOUT_MS, ENDPOINT_GET_TIMEOUT_MS, FOLLOW_SLICE_MS } from '../../src/worker/audit-web/follow';
import { DESCRIPTION_TIMEOUT_MS } from '../../src/worker/audit-web/follow-api';
import { MAX_FOLLOW_REQUESTS, MAX_FOLLOWED_HOSTS } from '../../src/worker/audit-web/follow-requests';
import { MAX_TWIN_PROBES, MIN_TWIN_CHARS, MIN_VISIBLE_CHARS } from '../../src/worker/audit-web/handlers/content-without-js';
import { DEFAULT_MAX_LINKS } from '../../src/worker/audit-web/handlers/llms-txt-quality';
import {
  MAX_AUTHORIZATION_SERVERS,
  MAX_SHOWN_LENGTH,
  MAX_URL_LENGTH,
} from '../../src/worker/audit-web/handlers/protected-resource';
import { DEFAULT_MAX_CANDIDATES } from '../../src/worker/audit-web/handlers/scoped-llms';
import { fingerprintPrefix, registryFingerprintPrefix, type WebAuditRegistry } from '../../src/worker/audit-web/registry';
import { MEMO_BODY_MAX_BYTES, MEMO_TOTAL_MAX_BYTES } from '../../src/worker/audit-web/request-hop';
import {
  AUDIT_PROBE_MAX_BODY_BYTES,
  DEFAULT_MAX_REDIRECTS,
  DEFAULT_TIMEOUT_MS,
  DOCUMENT_MAX_BODY_BYTES,
  METADATA_MAX_BODY_BYTES,
  OPENAPI_MAX_BODY_BYTES,
  STATUS_ONLY_BODY_BYTES,
} from '../../src/worker/audit-web/ssrf';
import { generateCorpus } from './conformance-corpus';
import {
  CONTRACT_BUILD_TREE,
  CONTRACT_CORPUS_TREE,
  CONTRACT_DIR,
  CONTRACT_FINGERPRINT_FILE,
  CONTRACT_LISTING,
  GENERATED_TREES,
  MIRRORED_TREES,
  REGENERATE_COMMAND,
  WEB_AUDIT_REMEDIATION_PATH,
} from '../../src/build/web-audit-contract-paths.mjs';

/**
 * What `build/constants.json` carries: the engine settings the port reads, under the
 * name its owning module exports it by, so one search finds it in both repos.
 */
async function contractConstants(registry: WebAuditRegistry): Promise<Record<string, unknown>> {
  return {
    REGISTRY_FINGERPRINT: await registryFingerprintPrefix(registry),
    AUDIT_USER_AGENT,
    PROBE_UA_TOKENS,
    DEFAULT_CONCURRENCY,
    DEFAULT_PER_CHECK_TIMEOUT_MS,
    DEFAULT_PER_AUDIT_DEADLINE_MS,
    DEGRADED_PER_CHECK_TIMEOUT_MS,
    DISCOVERY_BUDGET_MS,
    DEFAULT_TIMEOUT_MS,
    DEFAULT_MAX_REDIRECTS,
    STATUS_ONLY_BODY_BYTES,
    AUDIT_PROBE_MAX_BODY_BYTES,
    DOCUMENT_MAX_BODY_BYTES,
    METADATA_MAX_BODY_BYTES,
    OPENAPI_MAX_BODY_BYTES,
    MEMO_BODY_MAX_BYTES,
    MEMO_TOTAL_MAX_BYTES,
    FOLLOW_SLICE_MS,
    ENDPOINT_GET_TIMEOUT_MS,
    CARD_DOCUMENT_TIMEOUT_MS,
    DESCRIPTION_TIMEOUT_MS,
    MAX_FOLLOWED_HOSTS,
    MAX_FOLLOW_REQUESTS,
    MAX_CATALOG_CARDS,
    MAX_CATALOG_ANCHORS,
    MIN_VISIBLE_CHARS,
    MAX_TWIN_PROBES,
    MIN_TWIN_CHARS,
    DEFAULT_MAX_LINKS,
    DEFAULT_MAX_CANDIDATES,
    MAX_AUTHORIZATION_SERVERS,
    MAX_URL_LENGTH,
    MAX_SHOWN_LENGTH,
  };
}

/** The generated files of `build/`, by file name. */
export async function generateContractBuild(registry: WebAuditRegistry): Promise<Map<string, string>> {
  return new Map([
    ['constants.json', projectionBytes(await contractConstants(registry))],
    ['registry.json', projectionBytes(registry)],
    ['remediation.json', projectionBytes(projectWebRemediation(readFileSync(WEB_AUDIT_REMEDIATION_PATH, 'utf8'), registry))],
    ['server-card.schema.json', readFileSync(VENDORED_CARD_SCHEMA_PATH, 'utf8')],
  ]);
}

function filesUnder(root: string, tree: string): string[] {
  const dir = join(root, tree);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = `${tree}/${entry.name}`;
    return entry.isDirectory() ? filesUnder(root, path) : [path];
  });
}

/** The bytes of every file the CLI mirrors, by its path under the contract root. */
export function mirroredFiles(
  root: string = CONTRACT_DIR,
  include: (path: string) => boolean = () => true,
): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  for (const tree of MIRRORED_TREES) {
    for (const path of filesUnder(root, tree)) {
      if (include(path)) files.set(path, readFileSync(join(root, path)));
    }
  }
  return files;
}

/** Its own line is the output, and a README is prose: an edit to one must not make an older CLI report a difference. */
function isHashed(path: string): boolean {
  return path !== CONTRACT_FINGERPRINT_FILE && basename(path) !== 'README.md';
}

/**
 * The bytes of `FINGERPRINT`: a sha256 prefix over each hashed file's path, length
 * and bytes, in path order. It moves when any hashed byte moves, so a difference
 * means the mirrored data differs, not necessarily that behavior does. A corpus
 * scorecard moving is how it catches the handler and scoring changes a registry
 * fingerprint cannot see; a logic change no scenario reaches moves nothing.
 */
export function contractFingerprint(files: ReadonlyMap<string, string | Buffer>): string {
  const hash = createHash('sha256');
  for (const path of [...files.keys()].filter(isHashed).sort()) {
    const content = files.get(path) ?? '';
    const bytes = typeof content === 'string' ? Buffer.from(content) : content;
    hash.update(`${path}\0${bytes.byteLength}\0`);
    hash.update(bytes);
  }
  return `${fingerprintPrefix(hash.digest('hex'))}\n`;
}

/** Every generated file of the contract, by its path under the contract root. */
export async function generateContract(registry: WebAuditRegistry): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const [name, content] of await generateContractBuild(registry)) files.set(`${CONTRACT_BUILD_TREE}/${name}`, content);
  for (const [name, content] of await generateCorpus(registry)) files.set(`${CONTRACT_CORPUS_TREE}/${name}`, content);
  // What generation does not write, the fingerprint still covers: a hand-authored
  // fixture is an input the CLI mirrors too.
  const handAuthored = mirroredFiles(CONTRACT_DIR, (path) => !GENERATED_TREES.some((tree) => path.startsWith(`${tree}/`)));
  files.set(CONTRACT_FINGERPRINT_FILE, contractFingerprint(new Map<string, string | Buffer>([...files, ...handAuthored])));
  return files;
}

export type ContractDrift = {
  /** Generated files that a regeneration would change, add, or remove. */
  stale: string[];
  /** Entries that differ from the pinned listing, which a regeneration does not settle. */
  listing: string[];
};

/** How the contract under `root` differs from `generated` and from the pinned listing. */
export function contractDrift(generated: ReadonlyMap<string, string>, root: string = CONTRACT_DIR): ContractDrift {
  const stale: string[] = [];
  for (const [name, content] of generated) {
    const path = join(root, name);
    if (!existsSync(path)) stale.push(`${name} (missing)`);
    else if (!Buffer.from(content).equals(readFileSync(path))) stale.push(name);
  }
  for (const tree of GENERATED_TREES) {
    for (const name of filesUnder(root, tree)) {
      if (!generated.has(name)) stale.push(`${name} (no longer generated)`);
    }
  }

  const listing: string[] = [];
  for (const [dir, pinned] of Object.entries(CONTRACT_LISTING)) {
    const path = join(root, dir);
    const actual = existsSync(path) ? readdirSync(path) : [];
    const entry = (name: string) => (dir === '.' ? name : `${dir}/${name}`);
    for (const name of actual) {
      if (!pinned.includes(name)) listing.push(`${entry(name)} (not in the pinned listing)`);
    }
    for (const name of pinned) {
      if (!actual.includes(name)) listing.push(`${entry(name)} (pinned but missing)`);
    }
  }
  return { stale: stale.sort(), listing: listing.sort() };
}

/** What a failing check prints: each drifted entry and what settles it. Null when nothing drifted. */
export function contractDriftMessage({ stale, listing }: ContractDrift): string | null {
  const sections: string[] = [];
  if (stale.length > 0) {
    sections.push(
      `stale contract files (${stale.length}):\n  ${stale.join('\n  ')}\nrun \`${REGENERATE_COMMAND}\` and commit the result.`,
    );
  }
  if (listing.length > 0) {
    sections.push(
      `contract listing differs (${listing.length}):\n  ${listing.join('\n  ')}\n` +
        'remove the file, or add it to CONTRACT_LISTING in src/build/web-audit-contract-paths.mjs: ' +
        'the CLI vendors these directories whole, so a new file is a change to its inputs.',
    );
  }
  return sections.length > 0 ? sections.join('\n') : null;
}
