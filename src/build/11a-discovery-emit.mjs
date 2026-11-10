// .well-known/* emit. Section 11a of the build pipeline (lands after
// 11-mcp-catalog so the catalog publish order stays semantically grouped).
//
// Emits operational signals:
//   dist/_internal/mcp-server-card-sep2127.json: build seed for the SEP-2127
//     server card, served at /mcp/server-card
//   dist/.well-known/ai-catalog.json: AI catalog listing that card
//   dist/_internal/mcp-server-card.json: build seed for the superseded
//     SEP-1649 card, served at /.well-known/mcp/server-card.json
//   dist/.well-known/security.txt: RFC 9116 vulnerability-reporting contact
//   dist/.well-known/ai.txt: agent / AI-access declaration
//
// The Worker serves each seed and the catalog with their URLs rewritten to
// the request's origin; the SEP-1649 pointer aliases (/.well-known/mcp,
// /mcp.json, /.well-known/mcp.json) 301 to that card. See src/worker/index.ts.
//
// The SEP-1649 card, security.txt, and ai.txt lift from streamsgrp's
// 07-well-known.mjs (anc and streamsgrp converged on the same wire shape
// during the cross-repo MCP work).
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
import { AUDIT_PATH } from '../shared/audit-routes';
import {
  AI_CATALOG_PATH,
  MCP_DISCOVERY_DOCUMENTS,
  MCP_SERVER_CARD_PATH,
  MCP_SERVER_CARD_SCHEMA_URL,
  MCP_SERVER_CARD_SEED_PATH,
  MCP_SERVER_CARD_TYPE,
  MCP_SERVER_NAME,
  MCP_SERVER_VERSION,
  SEP_1649_CARD_PATH,
  SEP_1649_CARD_SEED_PATH,
} from '../shared/mcp-discovery';
import { canonicalBaseUrl, expiresInOneYearIso, resolveBaseUrl } from './util.mjs';

const MCP_SPEC_VERSION = '2026-07-28';
const MCP_CARD_VERSION = '1.0';
const ANC_CONTACT = '97-boss-beetle@icloud.com';
const MCP_DESCRIPTION = 'agent-native CLI standard registry: scorecards, principles, vendored spec';
const MCP_TITLE = 'anc.dev agent-native CLI standard registry';

// A card's name and its catalog identifier name the server, not the
// deployment serving them, so both stay on the canonical host the way
// <link rel="canonical"> does, and a staging build lists the same server.
const CANONICAL_HOST = new URL(canonicalBaseUrl()).host;
const MCP_CARD_NAME = `${CANONICAL_HOST.split('.').reverse().join('.')}/${MCP_SERVER_NAME}`;
const MCP_CATALOG_IDENTIFIER = `urn:air:${CANONICAL_HOST}:mcp:${MCP_SERVER_NAME}`;

function buildServerCard(baseUrl) {
  return `${JSON.stringify(
    {
      $schema: MCP_SERVER_CARD_SCHEMA_URL,
      name: MCP_CARD_NAME,
      title: MCP_TITLE,
      description: MCP_DESCRIPTION,
      version: MCP_SERVER_VERSION,
      websiteUrl: `${baseUrl}/mcp-skill`,
      remotes: [{ type: 'streamable-http', url: `${baseUrl}/mcp` }],
    },
    null,
    2,
  )}\n`;
}

function buildAiCatalog(baseUrl) {
  return `${JSON.stringify(
    {
      specVersion: '1.0',
      entries: [
        {
          identifier: MCP_CATALOG_IDENTIFIER,
          type: MCP_SERVER_CARD_TYPE,
          url: `${baseUrl}${MCP_SERVER_CARD_PATH}`,
        },
      ],
    },
    null,
    2,
  )}\n`;
}

function buildMcpDescriptor(baseUrl) {
  const authMd = `${baseUrl}/auth.md`;
  // The SEP-1649 card, superseded by the SEP-2127 card above and kept for
  // clients that read `protocolVersion` and `mcp_endpoint` from it. Its
  // `documentation` names the client guide's section on the two cards.
  return `${JSON.stringify(
    {
      mcp_endpoint: `${baseUrl}/mcp`,
      version: MCP_CARD_VERSION,
      description: MCP_DESCRIPTION,
      documentation: `${baseUrl}/mcp-skill.md#server-cards`,
      serverInfo: {
        name: MCP_SERVER_NAME,
        version: MCP_SERVER_VERSION,
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

// The site has exactly one canonical location, and it is the production host
// named by `<link rel="canonical">` and the sitemap. RFC 9116's `Canonical:`
// is a different thing wearing the same word: it is a self-reference stating
// where THIS document is served, which a scanner compares against the URL it
// fetched. Naming production here from a staging build would make staging's
// own security.txt disown itself. Read it as "self", not as "the canonical site".
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
 * Emit the server card seeds, the AI catalog, security.txt, and ai.txt.
 *
 * @param {object} args
 * @param {string} args.distDir
 * @param {string=} args.baseUrl — explicit override; defaults via resolveBaseUrl
 * @returns {Promise<{
 *   mcpServerCardSeedPath: string,
 *   aiCatalogPath: string,
 *   mcpDescriptorSeedPath: string,
 *   securityPath: string,
 *   aiPath: string,
 * }>}
 */
export async function emitDiscovery({ distDir, baseUrl }) {
  const base = resolveBaseUrl(baseUrl);
  const wellKnownDir = join(distDir, '.well-known');
  const internalDir = join(distDir, '_internal');
  await mkdir(wellKnownDir, { recursive: true });
  await mkdir(internalDir, { recursive: true });

  const mcpServerCardSeedPath = join(distDir, MCP_SERVER_CARD_SEED_PATH);
  const aiCatalogPath = join(distDir, AI_CATALOG_PATH);
  const mcpDescriptorSeedPath = join(distDir, SEP_1649_CARD_SEED_PATH);
  const securityPath = join(wellKnownDir, 'security.txt');
  const aiPath = join(wellKnownDir, 'ai.txt');

  await writeFile(mcpServerCardSeedPath, buildServerCard(base));
  await writeFile(aiCatalogPath, buildAiCatalog(base));
  await writeFile(mcpDescriptorSeedPath, buildMcpDescriptor(base));
  await writeFile(securityPath, buildSecurityTxt(base));
  await writeFile(aiPath, buildAiTxt(base));

  // Retired static pointer file; aliases are Worker-served from the seed above.
  await unlink(join(wellKnownDir, 'mcp')).catch(() => {});

  return { mcpServerCardSeedPath, aiCatalogPath, mcpDescriptorSeedPath, securityPath, aiPath };
}

// Agent-readiness discovery surfaces (api-catalog, agent-skills, auth.md).
// MCP server card seed: emitDiscovery() → _internal/mcp-server-card.json.

function discoveryLinks(baseUrl) {
  const links = {};
  for (const { path, type, rel } of MCP_DISCOVERY_DOCUMENTS) {
    links[rel] = [...(links[rel] ?? []), { href: `${baseUrl}${path}`, type }];
  }
  return links;
}

function buildApiCatalog(baseUrl) {
  // RFC 9727 link set (application/linkset+json). One anchor: the MCP
  // endpoint, the site's agent-facing programmatic API. Each discovery
  // document sits under its link relation (the server cards under
  // service-desc, the AI catalog under ai-catalog); service-doc is the
  // human/agent guide; status points at the SEP-1649 card.
  return `${JSON.stringify(
    {
      linkset: [
        {
          anchor: `${baseUrl}/mcp`,
          ...discoveryLinks(baseUrl),
          'service-doc': [{ href: `${baseUrl}/mcp-skill`, type: 'text/html' }],
          status: [
            {
              href: `${baseUrl}${SEP_1649_CARD_PATH}`,
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

export function buildAgentSkillsIndex(baseUrl, skillDigest, webAuditSkills = []) {
  // Agent Skills Discovery RFC v0.2.0 index — a directory of pointers
  // only (KTD-7): the MCP client integration guide plus one fix skill
  // per web-audit check, every url targeting its content page. No skill
  // body is mimicked under .well-known. Digests are the SHA-256 of the
  // served artifacts, computed at emit time so they never drift from the
  // bytes on the wire (markdown twins are not minified post-build).
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
        ...webAuditSkills.map((skill) => ({
          name: `web-audit-fix-${skill.id}`,
          type: 'skill-md',
          description: skill.description,
          url: skill.url,
          digest: `sha256:${skill.digest}`,
        })),
      ],
    },
    null,
    2,
  )}\n`;
}

export function buildAgentSkillsIndexMd(baseUrl, webAuditSkills = []) {
  // Human-readable twin of the discovery index.
  return [
    '# Agent skills on anc.dev',
    '',
    'Machine-readable index: `/.well-known/agent-skills/index.json`.',
    '',
    '## MCP client integration',
    '',
    `- [anc-mcp](${baseUrl}/mcp-skill.md): connect to the anc.dev MCP server.`,
    `- [MCP endpoint docs](${baseUrl}/mcp-docs.md): \`GET /mcp\` returns 405; clients POST JSON-RPC to \`${baseUrl}/mcp\`.`,
    '',
    '## Web-audit fix skills',
    '',
    `One fix skill per [web audit](${baseUrl}${AUDIT_PATH}) check:`,
    '',
    ...webAuditSkills.map((skill) => `- [web-audit-fix-${skill.id}](${skill.url}): ${skill.description}`),
    '',
  ].join('\n');
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
    `- MCP server (streamable HTTP): \`${baseUrl}/mcp\` - JSON-RPC, MCP spec revision \`${MCP_SPEC_VERSION}\`. GET returns 405.`,
    `- MCP endpoint docs: \`${baseUrl}/mcp-docs.md\`.`,
    ...MCP_DISCOVERY_DOCUMENTS.map(({ label, path }) => `- ${label}: \`${baseUrl}${path}\`.`),
    `- MCP pointer aliases (301 to the SEP-1649 card): \`${baseUrl}/.well-known/mcp\`, \`${baseUrl}/mcp.json\`.`,
    `- API catalog: \`${baseUrl}/.well-known/api-catalog\`.`,
    `- Client guide: \`${baseUrl}/mcp-skill.md\`.`,
    '',
    '## Authentication method',
    '',
    'None. The catalog is open by design and the inventory is published. No API key and no agent',
    'registration are required. Agents call the MCP endpoint directly over HTTPS; `Authorization`',
    'headers are ignored.',
    '',
    `The SEP-1649 server card (\`${SEP_1649_CARD_PATH}\`) declares \`authentication.required: false\``,
    'and points here via `authentication.documentation`.',
    '',
    '## CORS posture',
    '',
    'Public discovery metadata (server card, api-catalog) returns',
    '`Access-Control-Allow-Origin: *` because these are read-only catalogs meant for cross-origin',
    'agent tools and automated scanners. No secrets are exposed.',
    '',
    '`POST /mcp` deliberately omits CORS so a malicious web page cannot drive JSON-RPC calls',
    '(including metered `score_cli` audits) against the visitor IP. MCP clients are server-side',
    'agent runtimes, not browser tabs.',
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

/**
 * Emit the agent-readiness discovery surfaces into distDir.
 *
 * Probed by generic agent-readiness scanners under the apex:
 *   dist/.well-known/api-catalog              (RFC 9727)
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
 *   agentSkillsPath: string;
 *   authMdPath: string;
 *   skillDigest: string;
 * }>}
 */
export async function emitAgentReadiness({ distDir, baseUrl, webAuditSkills = [] }) {
  const base = resolveBaseUrl(baseUrl);
  const wellKnownDir = join(distDir, '.well-known');
  const skillsDir = join(wellKnownDir, 'agent-skills');
  await mkdir(wellKnownDir, { recursive: true });
  await mkdir(skillsDir, { recursive: true });

  // Digest the served MCP client skill artifact for the agent-skills index.
  const skillArtifact = await readFile(join(distDir, 'mcp-skill.md'));
  const skillDigest = createHash('sha256').update(skillArtifact).digest('hex');

  const apiCatalogPath = join(wellKnownDir, 'api-catalog');
  const agentSkillsPath = join(skillsDir, 'index.json');
  const authMdPath = join(distDir, 'auth.md');

  await writeFile(apiCatalogPath, buildApiCatalog(base));
  await writeFile(agentSkillsPath, buildAgentSkillsIndex(base, skillDigest, webAuditSkills));
  await writeFile(join(skillsDir, 'index.md'), buildAgentSkillsIndexMd(base, webAuditSkills));
  await writeFile(authMdPath, buildAuthMd(base));

  // Retired: dist/.well-known/mcp.json was a separate server-card seed before the
  // descriptor unified onto /.well-known/mcp. Builds do not wipe dist/, so
  // delete the stale file when a prior artifact is still on disk.
  await unlink(join(wellKnownDir, 'mcp.json')).catch(() => {});

  // The MCP endpoint needs no sign-in, so these paths must answer as unknown
  // paths; delete any copy an earlier build left in dist/.
  for (const name of ['oauth-protected-resource', 'oauth-authorization-server', 'jwks.json']) {
    await unlink(join(wellKnownDir, name)).catch(() => {});
  }

  return {
    apiCatalogPath,
    agentSkillsPath,
    authMdPath,
    skillDigest,
  };
}
