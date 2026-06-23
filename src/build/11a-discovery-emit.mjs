// .well-known/* emit. Section 11a of the build pipeline (lands after
// 11-mcp-catalog so the catalog publish order stays semantically grouped).
//
// Emits three operational signals:
//   dist/.well-known/mcp           — JSON pointer at the MCP server
//   dist/.well-known/security.txt  — RFC 9116 vulnerability-reporting contact
//   dist/.well-known/ai.txt        — agent / AI-access declaration
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
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ANC_VERSION, expiresInOneYearIso, resolveBaseUrl } from './util.mjs';

const MCP_SPEC_VERSION = '2025-06-18';
const ANC_CONTACT = '97-boss-beetle@icloud.com';

function buildMcpPointer(baseUrl) {
  return `${JSON.stringify(
    {
      mcp_endpoint: `${baseUrl}/mcp`,
      version: MCP_SPEC_VERSION,
      description: 'agent-native CLI standard registry: scorecards, principles, vendored spec',
      transport: 'streamable-http',
      documentation: `${baseUrl}/mcp-skill.md`,
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
 * @returns {Promise<{ mcpPath: string, securityPath: string, aiPath: string }>}
 */
export async function emitDiscovery({ distDir, baseUrl }) {
  const base = resolveBaseUrl(baseUrl);
  const wellKnownDir = join(distDir, '.well-known');
  await mkdir(wellKnownDir, { recursive: true });

  const mcpPath = join(wellKnownDir, 'mcp');
  const securityPath = join(wellKnownDir, 'security.txt');
  const aiPath = join(wellKnownDir, 'ai.txt');

  await writeFile(mcpPath, buildMcpPointer(base));
  await writeFile(securityPath, buildSecurityTxt(base));
  await writeFile(aiPath, buildAiTxt(base));

  return { mcpPath, securityPath, aiPath };
}

// ---------------------------------------------------------------------------
// Agent-readiness discovery surfaces. These four files answer the protocol-
// discovery probes a generic agent-readiness scanner runs against the apex:
//
//   .well-known/api-catalog            — RFC 9727 link set pointing at the
//                                        programmatic surfaces (the MCP API).
//   .well-known/mcp.json               — SEP-1649 MCP Server Card. The legacy
//                                        .well-known/mcp pointer is an
//                                        extensionless FILE, so `mcp` cannot
//                                        also be a directory holding
//                                        server-card.json. Scanners accept
//                                        .well-known/mcp.json as an equivalent
//                                        candidate path, which sidesteps the
//                                        file/directory collision while keeping
//                                        the legacy pointer intact.
//   .well-known/agent-skills/index.json — Agent Skills Discovery v0.2.0 index.
//                                        References the self-hosted MCP client
//                                        skill (/mcp-skill.md) with a SHA-256
//                                        digest of the served artifact.
//   auth.md                            — Self-contained auth declaration. The
//                                        catalog is public and no-auth by
//                                        design (AGENTS.md: "the surface is
//                                        open, the inventory is published"), so
//                                        auth.md states that posture honestly
//                                        rather than advertising an OAuth
//                                        authorization server that does not
//                                        exist.
//
// All four lift their URLs from the same resolveBaseUrl() the rest of the
// build uses, so localhost / staging / prod each get self-consistent links.

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
          'service-desc': [{ href: `${baseUrl}/.well-known/mcp.json`, type: 'application/json' }],
          'service-doc': [{ href: `${baseUrl}/mcp-skill`, type: 'text/html' }],
          status: [{ href: `${baseUrl}/.well-known/mcp`, type: 'application/json' }],
        },
      ],
    },
    null,
    2,
  )}\n`;
}

function buildMcpServerCard(baseUrl) {
  // SEP-1649 MCP Server Card. serverInfo.version tracks the agent-native CLI
  // release the catalog mirrors (ANC_VERSION); protocolVersion is the MCP
  // spec revision the streamable-HTTP transport is pinned to. capabilities
  // mirror the live surface: 9 tools + 5 resources, no prompts.
  return `${JSON.stringify(
    {
      serverInfo: {
        name: 'anc.dev agent-native CLI standard registry',
        version: ANC_VERSION,
      },
      protocolVersion: MCP_SPEC_VERSION,
      description:
        'Streamable-HTTP MCP server exposing the agent-native CLI standard: scorecards, principles, ' +
        'and the vendored spec. Public catalog, no authentication.',
      url: `${baseUrl}/mcp`,
      transport: {
        type: 'streamable-http',
        endpoint: `${baseUrl}/mcp`,
      },
      capabilities: {
        tools: true,
        resources: true,
        prompts: false,
      },
      documentation: `${baseUrl}/mcp-skill.md`,
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
    `- MCP server card: \`${baseUrl}/.well-known/mcp.json\`.`,
    `- API catalog: \`${baseUrl}/.well-known/api-catalog\`.`,
    `- Client guide: \`${baseUrl}/mcp-skill.md\`.`,
    '',
    '## Authentication method',
    '',
    'None. The catalog is open by design and the inventory is published. There is no authorization',
    'server, no token endpoint, and no registration flow. `Authorization` headers are ignored.',
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
 *   dist/.well-known/mcp.json                 (SEP-1649 MCP Server Card)
 *   dist/.well-known/agent-skills/index.json  (Agent Skills Discovery v0.2.0)
 *   dist/auth.md                              (auth declaration)
 *
 * The agent-skills index digests dist/mcp-skill.md, so this stage MUST run
 * after the sub-pages stage (7) that emits the markdown twin.
 *
 * @param {object} args
 * @param {string} args.distDir
 * @param {string=} args.baseUrl — explicit override; defaults via resolveBaseUrl
 * @returns {Promise<{ apiCatalogPath: string, mcpServerCardPath: string, agentSkillsPath: string, authMdPath: string, skillDigest: string }>}
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
  const mcpServerCardPath = join(wellKnownDir, 'mcp.json');
  const agentSkillsPath = join(skillsDir, 'index.json');
  const authMdPath = join(distDir, 'auth.md');

  await writeFile(apiCatalogPath, buildApiCatalog(base));
  await writeFile(mcpServerCardPath, buildMcpServerCard(base));
  await writeFile(agentSkillsPath, buildAgentSkillsIndex(base, skillDigest));
  await writeFile(authMdPath, buildAuthMd(base));

  return { apiCatalogPath, mcpServerCardPath, agentSkillsPath, authMdPath, skillDigest };
}
