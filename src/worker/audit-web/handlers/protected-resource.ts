// `protected-resource` handler: scores what an MCP endpoint that requires
// sign-in tells a client about signing in, from the facts the audit already
// settled, with no request of its own. The `challenge` op reads the
// WWW-Authenticate its 401 carried; the `metadata` op reads the
// authorization servers its RFC 9728 metadata lists.
//
// The audited server chooses those values, so none is ever requested (a
// listed authorization server could be any host) and each reaches the
// evidence line in a form no reader can take as markup.

import { resourceMetadataFromChallenge } from '../reciprocity';
import type { WebCheck } from '../registry';
import { validatePublicUrl } from '../ssrf';
import type { EvidenceItem, HandlerContext, McpAuthRequired, ProbeOutcome } from './types';

const MAX_AUTHORIZATION_SERVERS = 8;
const MAX_URL_LENGTH = 2048;
const MAX_SHOWN_LENGTH = 200;

const BEARER_CHALLENGE = /(?:^|,)\s*bearer(?:\s|$)/i;

// Every character a URL needs unescaped; anything else is percent-encoded,
// which leaves no markup, link syntax, or line break for a reader to act on.
const SHOWN_AS_IS = /[A-Za-z0-9\-._~:/?#@!$+,;=%]/;
const UTF8 = new TextEncoder();

/**
 * A server-chosen value as the evidence line shows it: as written, with
 * every character outside a URL's own set percent-encoded. Long values are
 * cut.
 */
function shown(value: unknown): string {
  const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value));
  const encoded = Array.from(text, (c) =>
    SHOWN_AS_IS.test(c)
      ? c
      : Array.from(UTF8.encode(c), (byte) => `%${byte.toString(16).toUpperCase().padStart(2, '0')}`).join(''),
  ).join('');
  return encoded.length > MAX_SHOWN_LENGTH ? `${encoded.slice(0, MAX_SHOWN_LENGTH)}...` : encoded;
}

function verdict(status: ProbeOutcome['status'], item: EvidenceItem, why: string): ProbeOutcome {
  return { status, evidence: [{ ...item, why: [why] }] };
}

function challengeOutcome(auth: McpAuthRequired): ProbeOutcome {
  const item: EvidenceItem = { url: auth.endpoint, status: 401 };
  if (auth.challenge === null) {
    return verdict('noncompliant', item, 'the 401 carries no WWW-Authenticate challenge');
  }
  if (!BEARER_CHALLENGE.test(auth.challenge)) {
    return verdict('noncompliant', item, 'the WWW-Authenticate challenge is not a Bearer challenge');
  }
  const named = resourceMetadataFromChallenge(auth.challenge);
  if (named === null) {
    return verdict('noncompliant', item, 'the Bearer challenge names no resource_metadata');
  }
  return verdict('pass', item, `resource_metadata names ${shown(named)}`);
}

/** Why a listed authorization server is unusable, or null when it is a public https URL. */
function serverDefect(value: unknown): string | null {
  if (typeof value !== 'string') return 'is not a URL';
  if (value.length > MAX_URL_LENGTH) return `is longer than ${MAX_URL_LENGTH} characters`;
  const validated = validatePublicUrl(value);
  if (!validated.ok) return validated.refused === 'host' ? 'names a private or reserved host' : 'is not a URL';
  return validated.url.protocol === 'https:' ? null : 'is not https';
}

function metadataOutcome(auth: McpAuthRequired): ProbeOutcome {
  const item: EvidenceItem = { url: auth.metadataUrl };
  const servers = auth.metadata.authorization_servers;
  if (!Array.isArray(servers) || servers.length === 0) {
    return verdict('broken', item, 'the metadata lists no authorization_servers');
  }
  const read = servers.slice(0, MAX_AUTHORIZATION_SERVERS);
  for (const value of read) {
    const defect = serverDefect(value);
    if (defect !== null) return verdict('broken', item, `authorization server ${shown(value)} ${defect}`);
  }
  return verdict('pass', item, `authorization_servers: ${read.map(shown).join(', ')}`);
}

export async function runProtectedResource(check: WebCheck, ctx: HandlerContext): Promise<ProbeOutcome> {
  const auth = ctx.mcpAuth;
  if (!auth) return { status: 'na', evidence: [{ why: ['the MCP endpoint does not require sign-in'] }] };
  const op = (check.with as { op?: string }).op;
  if (op === 'challenge') return challengeOutcome(auth);
  if (op === 'metadata') return metadataOutcome(auth);
  throw new Error(`protected-resource: check "${check.id}" names unknown op ${JSON.stringify(op)}`);
}
