// `server-card` handler: scores the card of record discovery and the follow
// slice kept, with no request of its own. A card that answered but does not
// parse reads broken. A SEP-1649-shaped card passes with the superseded
// advisory, and so does one that names its server in `serverInfo`, a
// SEP-1649 field SEP-2127 does not have, with no endpoint field for
// discovery to read; any other card is held to SEP-2127 and passes when it
// carries every field the extension schema requires, at its top level and
// in each `remotes[]` item, with the JSON type the schema gives. The field
// lists arrive in `with`, read from the vendored schema at build.

import { type CardShape, cardShape, isJsonObject, type JsonObject, parseJsonObject } from '../discovery-documents';
import type { WebCheck } from '../registry';
import { DOCUMENT_MAX_BODY_BYTES } from '../ssrf';
import type { EvidenceItem, HandlerContext, ProbeOutcome } from './types';

type JsonType = 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'null';

/** One required field and the JSON types the schema allows it. */
export interface CardFieldRule {
  field: string;
  type: JsonType[];
}

export interface ServerCardWith {
  retained: 'server-card';
  required: CardFieldRule[];
  remote_required: CardFieldRule[];
}

const REMOTES = 'remotes';

function hasType(value: unknown, type: JsonType): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'object':
      return isJsonObject(value);
    case 'array':
      return Array.isArray(value);
    case 'null':
      return value === null;
  }
}

/** What `value` lacks against `rules`, each problem prefixed with where it sits. */
function fieldProblems(value: JsonObject, rules: readonly CardFieldRule[], at: string): string[] {
  const missing = rules.filter((rule) => !(rule.field in value)).map((rule) => rule.field);
  const mistyped = rules
    .filter((rule) => rule.field in value && !rule.type.some((type) => hasType(value[rule.field], type)))
    .map((rule) => `${at}${rule.field} is not ${rule.type.join(' or ')}`);
  const lead = `${at}missing required field${missing.length === 1 ? '' : 's'} `;
  return [...(missing.length > 0 ? [`${lead}${missing.join(', ')}`] : []), ...mistyped];
}

/** Every way `card` falls short of the SEP-2127 required fields. */
export function sep2127Problems(card: JsonObject, w: Pick<ServerCardWith, 'required' | 'remote_required'>): string[] {
  const problems = fieldProblems(card, w.required, '');
  const remotes = card[REMOTES];
  if (remotes === undefined) return problems;
  if (!Array.isArray(remotes)) return [...problems, `${REMOTES} is not an array`];
  remotes.forEach((remote, i) => {
    const at = `${REMOTES}[${i}] `;
    if (!isJsonObject(remote)) problems.push(`${at}is not an object`);
    else problems.push(...fieldProblems(remote, w.remote_required, at));
  });
  return problems;
}

function scoredShape(card: JsonObject | null, discovered: CardShape): CardShape {
  return discovered === 'unrecognized' && isJsonObject(card?.serverInfo) ? 'sep-1649' : discovered;
}

export async function runServerCard(check: WebCheck, ctx: HandlerContext): Promise<ProbeOutcome> {
  const w = check.with as unknown as ServerCardWith;
  const doc = ctx.retainedDocuments?.get(w.retained);
  if (doc === undefined) {
    return { status: 'absent', evidence: [{ retained: w.retained, why: ['discovery found no server card'] }] };
  }
  const card = parseJsonObject(doc.response);
  const shape = scoredShape(card, doc.shape ?? cardShape(card));
  const item: EvidenceItem = { url: doc.url, status: doc.response.status, retained: w.retained, shape };
  if (card === null) {
    const why = doc.response.truncated
      ? `the card was cut at the ${DOCUMENT_MAX_BODY_BYTES / 1024} KiB read cap`
      : 'the card is not a JSON object';
    const cut = doc.response.truncated ? { truncated: true } : {};
    return { status: 'broken', evidence: [{ ...item, ...cut, ok: false, why: [why] }] };
  }
  if (shape === 'sep-1649') {
    return { status: 'pass', advisory: 'superseded', evidence: [{ ...item, ok: true, why: [] }] };
  }
  const problems = sep2127Problems(card, w);
  if (problems.length === 0) return { status: 'pass', evidence: [{ ...item, ok: true, why: [] }] };
  return { status: 'broken', evidence: [{ ...item, ok: false, why: [problems.join('; ')] }] };
}

/** The row's evidence line: where the card was read and, when it falls short, how. */
export function serverCardEvidence(outcome: ProbeOutcome): string {
  const first = outcome.evidence[0] ?? {};
  const why = Array.isArray(first.why) ? first.why.filter((w): w is string => typeof w === 'string') : [];
  if (typeof first.url !== 'string') return why.join('; ');
  const read = `${first.url} -> ${String(first.status ?? 'error')}`;
  return why.length > 0 ? `${read} (${why.join('; ')})` : read;
}
