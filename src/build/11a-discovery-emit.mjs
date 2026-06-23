// .well-known/* emit. Section 11a of the build pipeline (lands after
// 11-mcp-catalog so the catalog publish order stays semantically grouped).
//
// Emits operational signals:
//   dist/_internal/mcp-server-card.json — build seed for the SEP-1649 MCP
//                                       server card (served at the RFC path
//                                       /.well-known/mcp/server-card.json).
//   dist/.well-known/security.txt       — RFC 9116 vulnerability-reporting contact
//   dist/.well-known/ai.txt             — agent / AI-access declaration
//
// Legacy pointer aliases (/.well-known/mcp, /mcp.json, /.well-known/mcp.json)
// are Worker-served from the same seed; see src/worker/index.ts.
//
// All three lift from streamsgrp's 07-well-known.mjs (anc and streamsgrp
// converged on the same wire shape during the cross-repo MCP work).
//
// The canonical contact for anc.dev is the operator's iCloud address;
// both security.txt and ai.txt point at the same inbox. Apex-domain
// aliases like security@anc.dev are not provisioned, and pinning the
// real address in the file is how the discoverability surfaces stay
// reachable today. If a routed alias lands in the future the constant
// flips here in one place.

import { createHash } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ANC_VERSION, expiresInOneYearIso, resolveBaseUrl } from './util.mjs';

const MCP_SPEC_VERSION = '2025-06-18';
const MCP_CARD_SCHEMA = 'https://static.modelcontextprotocol.io/schemas/mcp-server-card/v1.json';
const MCP_CARD_VERSION = '1.0';
const ANC_CONTACT = '97-boss-beetle@icloud.com';

function buildMcpDescriptor(baseUrl) {
  const description = 'agent-native CLI standard registry: scorecards, principles, vendored spec';
  const authMd = `${baseUrl}/auth.md`;
  // SEP-1649 server card (canonical at /.well-known/mcp/server-card.json) plus
  // U6 pointer fields retained for legacy alias consumers (mcp_endpoint, documentation).
  return `${JSON.stringify(
    {
      $schema: MCP_CARD_SCHEMA,
      mcp_endpoint: `${baseUrl}/mcp`,
      version: MCP_CARD_VERSION,
      description,
      documentation: `${baseUrl}/mcp-skill.md`,
      serverInfo: {
        name: 'anc.dev agent-native CLI standard registry',
        version: ANC_VERSION,
      },
      protocolVersion: MCP_SPEC_VERSION,
      url: `${baseUrl}/mcp`,
      transport: {
        type: 'streamable-http',
        endpoint: `${baseUrl}/mcp`,
      },
      capabilities: {
        tools: { listChanged: false },
        resources: { subscribe: false, listChanged: false },
        prompts: { listChanged: false },
      },
      authentication: {
        required: false,
        schemes: [],
        documentation: authMd,
      },
    },
    null,
    2,
  )}\n`;
}

function buildSecurityTxt(baseUrl) {
  const expires = expiresInOneYearIso();
  return [
    `Contact: mailto:${ANC_CONTACT}`,
    `Expires: ${expires}`,
    'Preferred-Languages: en',
    `Canonical: ${baseUrl}/.well-known/security.txt`,
    '',
  ].join('\n');
}

function buildAiTxt(baseUrl) {
  return [
    '# ai.txt for anc.dev',
    '# Declares AI-training and agent-access posture. Format may evolve as the',
    '# ai.txt convention ratifies; this file is the canonical statement.',
    '',
    'User-Agent: *',
    'Allow: /',
    'Allow-AI-Training: yes',
    'Allow-Inference: yes',
    `Programmatic-API: ${baseUrl}/mcp`,
    `Contact: mailto:${ANC_CONTACT}`,
    '',
  ].join('\n');
}

/**
 * Emit the three .well-known files into dist/.well-known/.
 *
 * @param {object} args
 * @param {string} args.distDir
 * @param {string=} args.baseUrl — explicit override; defaults via resolveBaseUrl
 * @returns {Promise<{ mcpDescriptorSeedPath: string, securityPath: string, aiPath: string }>}
 */
export async function emitDiscovery({ distDir, baseUrl }) {
  const base = resolveBaseUrl(baseUrl);
  const wellKnownDir = join(distDir, '.well-known');
  const internalDir = join(distDir, '_internal');
  await mkdir(wellKnownDir, { recursive: true });
  await mkdir(internalDir, { recursive: true });

  const mcpDescriptorSeedPath = join(internalDir, 'mcp-server-card.json');
  const securityPath = join(wellKnownDir, 'security.txt');
  const aiPath = join(wellKnownDir, 'ai.txt');

  await writeFile(mcpDescriptorSeedPath, buildMcpDescriptor(base));
  await writeFile(securityPath, buildSecurityTxt(base));
  await writeFile(aiPath, buildAiTxt(base));

  // Retired static pointer file; aliases are Worker-served from the seed above.
  await unlink(join(wellKnownDir, 'mcp')).catch(() => {});

  return { mcpDescriptorSeedPath, securityPath, aiPath };
}

// Agent-readiness discovery surfaces (api-catalog, OAuth metadata, agent-skills,
// auth.md). MCP server card seed: emitDiscovery() → _internal/mcp-server-card.json.

function buildApiCatalog(baseUrl) {
  // RFC 9727 link set (application/linkset+json). One anchor: the MCP
  // endpoint, the site's agent-facing programmatic API. service-desc is the
  // machine-readable MCP server card; service-doc is the human/agent guide;
  // status points at the lightweight descriptor pointer.
  return `${JSON.stringify(
    {
      linkset: [
        {
          anchor: `${baseUrl}/mcp`,
          'service-desc': [{ href: `${baseUrl}/.well-known/mcp/server-card.json`, type: 'application/json' }],
          'service-doc': [{ href: `${baseUrl}/mcp-skill`, type: 'text/html' }],
          status: [
            {
              href: `${baseUrl}/.well-known/mcp/server-card.json`,
              type: 'application/json',
            },
          ],
        },
      ],
    },
    null,
    2,
  )}\n`;
}

function buildAgentSkillsIndex(baseUrl, skillDigest) {
  // Agent Skills Discovery RFC v0.2.0 index. One self-hosted skill: the MCP
  // client integration guide served at /mcp-skill.md. The digest is the
  // SHA-256 of the served artifact (dist/mcp-skill.md), computed at emit
  // time so it never drifts from the bytes on the wire (the markdown twin
  // is not minified post-build).
  return `${JSON.stringify(
    {
      $schema: 'https://schemas.agentskills.io/discovery/0.2.0/schema.json',
      skills: [
        {
          name: 'anc-mcp',
          type: 'skill-md',
          description:
            "Connect to anc.dev's Model Context Protocol server to query the agent-native CLI standard: " +
            'scorecards, the eight principles, and the vendored spec.',
          url: `${baseUrl}/mcp-skill.md`,
          digest: `sha256:${skillDigest}`,
        },
      ],
    },
    null,
    2,
  )}\n`;
}

function buildAuthMd(baseUrl) {
  // Self-contained auth declaration. The catalog is public/no-auth by design,
  // so this file documents the audience, endpoints, and the (deliberate)
  // absence of any credential flow. Kept pure ASCII so clients that decode
  // markdown as Latin-1 do not mangle it. The H1 MUST contain "auth.md" for
  // the convention's detector.
  return [
    '# auth.md - anc.dev agent authentication',
    '',
    'anc.dev publishes a public catalog of the agent-native CLI standard. The programmatic surfaces',
    'below require **no authentication, no API key, and no agent registration**.',
    '',
    '## Audience',
    '',
    'AI agents and MCP clients (Claude Code, Codex, Cursor, custom runtimes) that query the',
    'agent-native CLI standard: scorecards, the eight principles, and the vendored spec.',
    '',
    '## Endpoints',
    '',
    `- MCP server (streamable HTTP): \`${baseUrl}/mcp\` - JSON-RPC, MCP spec revision \`${MCP_SPEC_VERSION}\`.`,
    `- MCP server card (SEP-1649): \`${baseUrl}/.well-known/mcp/server-card.json\`.`,
    `- MCP pointer aliases: \`${baseUrl}/.well-known/mcp\`, \`${baseUrl}/mcp.json\`.`,
    `- API catalog: \`${baseUrl}/.well-known/api-catalog\`.`,
    `- OAuth protected resource: \`${baseUrl}/.well-known/oauth-protected-resource\`.`,
    `- OAuth authorization server: \`${baseUrl}/.well-known/oauth-authorization-server\`.`,
    `- Client guide: \`${baseUrl}/mcp-skill.md\`.`,
    '',
    '## Authentication method',
    '',
    'None. The catalog is open by design and the inventory is published. No API key and no agent',
    'registration are required. Agents call the MCP endpoint directly over HTTPS; `Authorization`',
    'headers are ignored.',
    '',
    'OAuth discovery metadata (`/.well-known/oauth-protected-resource`,',
    '`/.well-known/oauth-authorization-server`, `/.well-known/jwks.json`) is published for',
    'agent-readiness scanners. The `token_endpoint` (`/oauth2/token`) exists only to answer',
    'discovery probes: POSTs return a typed `public_catalog` error and issue no credentials.',
    'The server card (`/.well-known/mcp/server-card.json`) declares `authentication.required: false`',
    'and points here via `authentication.documentation`. OAuth PRM/AS `resource_documentation` /',
    '`service_documentation` also resolve to this file.',
    '',
    '## CORS posture',
    '',
    'Public discovery metadata (server card, api-catalog, OAuth PRM/AS, JWKS) returns',
    '`Access-Control-Allow-Origin: *` because these are read-only catalogs meant for cross-origin',
    'agent tools and automated scanners. No secrets are exposed.',
    '',
    '`POST /mcp` deliberately omits CORS so a malicious web page cannot drive JSON-RPC calls',
    '(including metered `score_cli` audits) against the visitor IP. MCP clients are server-side',
    'agent runtimes, not browser tabs.',
    '',
    '`POST /oauth2/token` also omits CORS for the same browser-isolation reason; discovery',
    'metadata already documents the public-catalog posture.',
    '',
    '## Credential use',
    '',
    'No credentials are issued or required. Agents call the MCP endpoint directly over HTTPS.',
    '',
    '## Rate limits',
    '',
    'Reads are gated at 60 requests per 60 seconds per IP. The cost-bearing live-scoring tool',
    '(`score_cli`) is metered separately at 5 fresh audits per 60 minutes per IP. Both are keyed on',
    'the client IP; there is no per-agent identity.',
    '',
    '## Contact',
    '',
    `mailto:${ANC_CONTACT}`,
    '',
  ].join('\n');
}

function buildOAuthProtectedResource(baseUrl) {
  // RFC 9728 Protected Resource Metadata. The MCP endpoint is the
  // programmatic resource; the catalog is public/no-auth, so scopes are
  // empty and the authorization server metadata documents anonymous access.
  return `${JSON.stringify(
    {
      resource: `${baseUrl}/mcp`,
      authorization_servers: [baseUrl],
      scopes_supported: [],
      bearer_methods_supported: ['header'],
      resource_documentation: `${baseUrl}/auth.md`,
    },
    null,
    2,
  )}\n`;
}

function buildOAuthAuthorizationServer(baseUrl) {
  // RFC 8414 Authorization Server Metadata plus the auth.md agent_auth
  // extension. The catalog is open by design; anonymous identity is the
  // only supported registration path and issues no credentials. token_endpoint
  // is a discovery stub for scanners — POST returns public_catalog (see auth.md).
  // authorization_endpoint is omitted: RFC 8414 marks it OPTIONAL when no
  // authorization-code grant is supported, and a real probe would only hit prose.
  return `${JSON.stringify(
    {
      issuer: baseUrl,
      token_endpoint: `${baseUrl}/oauth2/token`,
      jwks_uri: `${baseUrl}/.well-known/jwks.json`,
      service_documentation: `${baseUrl}/auth.md`,
      grant_types_supported: ['urn:workos:agent-auth:grant-type:anonymous'],
      response_types_supported: ['none'],
      agent_auth: {
        skill: `${baseUrl}/auth.md`,
        register_uri: `${baseUrl}/auth.md`,
        identity_types_supported: ['anonymous'],
        anonymous: {
          credential_types_supported: ['none'],
          claim_uri: `${baseUrl}/auth.md`,
        },
      },
    },
    null,
    2,
  )}\n`;
}

function buildJwks() {
  // Empty JWKS: the public catalog issues no bearer tokens. The endpoint
  // exists so oauth-discovery scanners find a valid jwks_uri.
  return `${JSON.stringify({ keys: [] }, null, 2)}\n`;
}

/**
 * Emit the agent-readiness discovery surfaces into distDir.
 *
 * Probed by generic agent-readiness scanners under the apex:
 *   dist/.well-known/api-catalog              (RFC 9727)
 *   dist/.well-known/oauth-protected-resource (RFC 9728 PRM)
 *   dist/.well-known/oauth-authorization-server (RFC 8414 + agent_auth)
 *   dist/.well-known/jwks.json                (empty JWKS for public catalog)
 *   dist/.well-known/agent-skills/index.json  (Agent Skills Discovery v0.2.0)
 *   dist/auth.md                              (auth declaration)
 *
 * MCP server card seed: emitDiscovery() at dist/_internal/mcp-server-card.json.
 *
 * The agent-skills index digests dist/mcp-skill.md, so this stage MUST run
 * after the sub-pages stage (7) that emits the markdown twin.
 *
 * @param {object} args
 * @param {string} args.distDir
 * @param {string=} args.baseUrl — explicit override; defaults via resolveBaseUrl
 * @returns {Promise<{
 *   apiCatalogPath: string;
 *   oauthProtectedResourcePath: string;
 *   oauthAuthorizationServerPath: string;
 *   jwksPath: string;
 *   agentSkillsPath: string;
 *   authMdPath: string;
 *   skillDigest: string;
 * }>}
 */
export async function emitAgentReadiness({ distDir, baseUrl }) {
  const base = resolveBaseUrl(baseUrl);
  const wellKnownDir = join(distDir, '.well-known');
  const skillsDir = join(wellKnownDir, 'agent-skills');
  await mkdir(wellKnownDir, { recursive: true });
  await mkdir(skillsDir, { recursive: true });

  // Digest the served MCP client skill artifact for the agent-skills index.
  const skillArtifact = await readFile(join(distDir, 'mcp-skill.md'));
  const skillDigest = createHash('sha256').update(skillArtifact).digest('hex');

  const apiCatalogPath = join(wellKnownDir, 'api-catalog');
  const oauthProtectedResourcePath = join(wellKnownDir, 'oauth-protected-resource');
  const oauthAuthorizationServerPath = join(wellKnownDir, 'oauth-authorization-server');
  const jwksPath = join(wellKnownDir, 'jwks.json');
  const agentSkillsPath = join(skillsDir, 'index.json');
  const authMdPath = join(distDir, 'auth.md');

  await writeFile(apiCatalogPath, buildApiCatalog(base));
  await writeFile(oauthProtectedResourcePath, buildOAuthProtectedResource(base));
  await writeFile(oauthAuthorizationServerPath, buildOAuthAuthorizationServer(base));
  await writeFile(jwksPath, buildJwks());
  await writeFile(agentSkillsPath, buildAgentSkillsIndex(base, skillDigest));
  await writeFile(authMdPath, buildAuthMd(base));

  // Retired: dist/.well-known/mcp.json was a separate server-card seed before the
  // descriptor unified onto /.well-known/mcp. Builds do not wipe dist/, so
  // delete the stale file when a prior artifact is still on disk.
  await unlink(join(wellKnownDir, 'mcp.json')).catch(() => {});

  return {
    apiCatalogPath,
    oauthProtectedResourcePath,
    oauthAuthorizationServerPath,
    jwksPath,
    agentSkillsPath,
    authMdPath,
    skillDigest,
  };
}
