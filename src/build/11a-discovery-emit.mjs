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

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expiresInOneYearIso, resolveBaseUrl } from './util.mjs';

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
