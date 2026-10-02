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

/**
 * Why a listed authorization server is unusable from the audit's vantage,
 * or null when an agent there can sign in through it. A private or reserved
 * host is out of reach unless the endpoint itself is: a client that reached
 * a private endpoint shares its network.
 */
function serverDefect(value: unknown, privateReachable: boolean): string | null {
  if (typeof value !== 'string') return 'is not a URL';
  if (value.length > MAX_URL_LENGTH) return `is longer than ${MAX_URL_LENGTH} characters`;
  const validated = validatePublicUrl(value);
  if (!validated.ok && validated.refused === 'url') return 'is not a URL';
  if (!validated.ok && !privateReachable) return 'names a private or reserved host';
  return new URL(value).protocol === 'https:' ? null : 'is not https';
}

/** The endpoint sits on a private or reserved host, by the guard every probe passes through. */
function privateEndpoint(endpoint: string): boolean {
  const validated = validatePublicUrl(endpoint);
  return !validated.ok && validated.refused === 'host';
}

/**
 * Priced by what an agent at the audit's vantage can do with the list: no
 * usable server leaves it nowhere to sign in, a dead end, while a usable
 * one listed beside bad entries still gets it signed in.
 */
function metadataOutcome(auth: McpAuthRequired): ProbeOutcome {
  const item: EvidenceItem = { url: auth.metadataUrl };
  const servers = auth.metadata.authorization_servers;
  if (!Array.isArray(servers) || servers.length === 0) {
    return verdict('broken', item, 'the metadata lists no authorization_servers');
  }
  const privateReachable = privateEndpoint(auth.endpoint);
  const read = servers.slice(0, MAX_AUTHORIZATION_SERVERS);
  const defects = read.flatMap((value) => {
    const defect = serverDefect(value, privateReachable);
    return defect === null ? [] : [`authorization server ${shown(value)} ${defect}`];
  });
  if (defects.length === 0) return verdict('pass', item, `authorization_servers: ${read.map(shown).join(', ')}`);
  return { status: defects.length === read.length ? 'broken' : 'noncompliant', evidence: [{ ...item, why: defects }] };
}

export async function runProtectedResource(check: WebCheck, ctx: HandlerContext): Promise<ProbeOutcome> {
  const auth = ctx.mcpAuth;
  if (!auth) return { status: 'na', evidence: [{ why: ['the MCP endpoint does not require sign-in'] }] };
  const op = (check.with as { op?: string }).op;
  if (op === 'challenge') return challengeOutcome(auth);
  if (op === 'metadata') return metadataOutcome(auth);
  throw new Error(`protected-resource: check "${check.id}" names unknown op ${JSON.stringify(op)}`);
}
