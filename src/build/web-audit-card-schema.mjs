// The server-card fields the web audit requires, read from the vendored
// SEP-2127 extension schema (src/data/web-audit/server-card.schema.json,
// synced by scripts/sync-server-card-schema.sh). The registry build copies
// them into the server-card check's handler parameters, so the Worker
// validates a card against the schema's own required lists and no second
// copy of them is written by hand.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const VENDORED_CARD_SCHEMA_PATH = fileURLToPath(
  new URL('../data/web-audit/server-card.schema.json', import.meta.url),
);

const CARD_DEF = 'ServerCard';
const REMOTES_FIELD = 'remotes';
const JSON_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null']);

/**
 * Read and parse a vendored card schema. A missing or unparseable file is a
 * build error naming the sync script, since the card check cannot score
 * without it.
 *
 * @param {string} [path]
 * @returns {unknown}
 */
export function readCardSchema(path = VENDORED_CARD_SCHEMA_PATH) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(
      `web-audit registry: server card schema not readable at ${path} (${err.message}); run scripts/sync-server-card-schema.sh`,
    );
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`web-audit registry: server card schema at ${path} is not JSON (${err.message})`);
  }
}

/** The definition a local `#/$defs/<name>` reference names, or null. */
function localDef(defs, ref) {
  const match = typeof ref === 'string' ? /^#\/\$defs\/([^/]+)$/.exec(ref) : null;
  return match === null ? null : (defs[match[1]] ?? null);
}

/**
 * A definition's required fields with the JSON types its properties
 * declare, in the schema's order.
 *
 * @returns {Array<{ field: string, type: string[] }>}
 */
function requiredFields(def, label) {
  if (!Array.isArray(def?.required) || def.required.length === 0) {
    throw new Error(`web-audit registry: server card schema carries no required array at ${label}`);
  }
  return def.required.map((field) => {
    const declared = def.properties?.[field]?.type;
    const type = Array.isArray(declared) ? declared : [declared];
    if (typeof field !== 'string' || type.length === 0 || !type.every((t) => JSON_TYPES.has(t))) {
      throw new Error(
        `web-audit registry: server card schema field ${label}.${field} declares no JSON type (got ${JSON.stringify(declared)})`,
      );
    }
    return { field, type };
  });
}

/**
 * The fields a SEP-2127 card must carry at its top level and in each
 * `remotes[]` item, with their JSON types. Pure.
 *
 * @param {unknown} schema - the parsed extension schema
 * @returns {{ required: Array<{ field: string, type: string[] }>, remote_required: Array<{ field: string, type: string[] }> }}
 */
export function cardRequirements(schema) {
  const defs = schema?.$defs;
  const card = defs?.[CARD_DEF];
  if (!card || typeof card !== 'object') {
    throw new Error(`web-audit registry: server card schema has no $defs.${CARD_DEF}`);
  }
  const remote = localDef(defs, card.properties?.[REMOTES_FIELD]?.items?.$ref);
  if (remote === null) {
    throw new Error(
      `web-audit registry: server card schema's ${CARD_DEF}.${REMOTES_FIELD} items name no local $defs entry`,
    );
  }
  return {
    required: requiredFields(card, `$defs.${CARD_DEF}`),
    remote_required: requiredFields(remote, `${CARD_DEF}.${REMOTES_FIELD}[]`),
  };
}
