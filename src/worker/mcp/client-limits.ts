// Length limits that MCP clients and registry checks apply to the strings a
// server sends at session start: its instructions and each tool description.
// tests/mcp-client-limits.test.ts reads the served strings against these
// records, so a limit is written down here once and enforced from here.

export type MetadataSurface = 'server-instructions' | 'tool-description-upfront' | 'tool-description-tool-search';

export type LimitUnit = 'characters' | 'utf8-bytes';

/**
 * - `cut`: the client drops text past the value.
 * - `warn`: a check reports text past the value and nothing is dropped.
 * - `lead`: the source asks for the most important details within the value.
 */
export type LimitEffect = 'cut' | 'warn' | 'lead';

export interface LimitSource {
  /** Null only when the source is described rather than named. */
  url: string | null;
  described?: string;
  /** The exact sentence the limit rests on. */
  quote: string;
  /** ISO date the source was read. */
  readOn: string;
}

export interface ClientLimit {
  id: string;
  client: string;
  appliesTo: readonly MetadataSurface[];
  value: number;
  unit: LimitUnit;
  effect: LimitEffect;
  /** First client version the limit applies to, inclusive. Null when it is not tied to a version. */
  fromVersion: string | null;
  /** First client version the limit no longer applies to, exclusive. Null while it is in force. */
  untilVersion: string | null;
  sources: readonly LimitSource[];
}

const CLAUDE_CODE_DOCS = 'https://code.claude.com/docs/en/mcp';
const CLAUDE_CODE_CHANGELOG = 'https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md';
const CLAUDE_CODE_SHORTER_LIMIT_QUOTE =
  'Before v2.1.296, the shorter limit was 2,048 characters, and before v2.1.295 it applied to every tool description, including one loaded through tool search.';
const READ_ON = '2026-11-11';

/**
 * Every known client limit, one record each.
 *
 * A record is refreshed, never rewritten or deleted. Refresh each one on every
 * `SPEC_REVISION` bump and on any report that a client cut this server's text:
 * fetch each `url`, find the quoted sentence, and update `quote` and `readOn`
 * when the wording changed and the value did not. When a client changes a
 * limit, give the old record an `untilVersion` and append a new record, as
 * `claude-code-upfront-2048` and `claude-code-upfront-4096` show. When a source
 * stops stating a limit, keep the record and add a source that notes the
 * removal.
 *
 * Characters are UTF-16 code units, which equals a client's count when it counts
 * code units and is never lower when it counts code points. UTF-8 bytes are at
 * least the code-unit count for every string, so a prefix within a byte limit is
 * also within the same number of characters.
 */
export const CLIENT_LIMITS: readonly ClientLimit[] = [
  {
    id: 'claude-code-all-2048',
    client: 'Claude Code',
    appliesTo: ['server-instructions', 'tool-description-upfront', 'tool-description-tool-search'],
    value: 2048,
    unit: 'characters',
    effect: 'cut',
    fromVersion: '2.1.84',
    untilVersion: '2.1.295',
    sources: [
      {
        url: CLAUDE_CODE_CHANGELOG,
        quote:
          'MCP tool descriptions and server instructions are now capped at 2KB to prevent OpenAPI-generated servers from bloating context',
        readOn: READ_ON,
      },
      { url: CLAUDE_CODE_DOCS, quote: CLAUDE_CODE_SHORTER_LIMIT_QUOTE, readOn: READ_ON },
    ],
  },
  {
    id: 'claude-code-upfront-2048',
    client: 'Claude Code',
    appliesTo: ['server-instructions', 'tool-description-upfront'],
    value: 2048,
    unit: 'characters',
    effect: 'cut',
    fromVersion: '2.1.295',
    untilVersion: '2.1.296',
    sources: [{ url: CLAUDE_CODE_DOCS, quote: CLAUDE_CODE_SHORTER_LIMIT_QUOTE, readOn: READ_ON }],
  },
  {
    id: 'claude-code-tool-search-16384',
    client: 'Claude Code',
    appliesTo: ['tool-description-tool-search'],
    value: 16384,
    unit: 'characters',
    effect: 'cut',
    fromVersion: '2.1.295',
    untilVersion: null,
    sources: [
      {
        url: CLAUDE_CODE_CHANGELOG,
        quote:
          'Changed MCP tool descriptions the model loads through tool search to be cut at 16,384 characters instead of 2,048',
        readOn: READ_ON,
      },
      {
        url: CLAUDE_CODE_DOCS,
        quote: 'The description of a tool that Claude loads through tool search: 16,384 characters',
        readOn: READ_ON,
      },
    ],
  },
  {
    id: 'claude-code-upfront-4096',
    client: 'Claude Code',
    appliesTo: ['server-instructions', 'tool-description-upfront'],
    value: 4096,
    unit: 'characters',
    effect: 'cut',
    fromVersion: '2.1.296',
    untilVersion: null,
    sources: [
      {
        url: CLAUDE_CODE_CHANGELOG,
        quote:
          'Changed the default limit on MCP tool descriptions sent up front and on MCP server instructions from 2,048 to 4,096 characters',
        readOn: READ_ON,
      },
      {
        url: CLAUDE_CODE_DOCS,
        quote: 'Server instructions, and the description of a tool that loads upfront: 4,096 characters',
        readOn: READ_ON,
      },
    ],
  },
  {
    id: 'tool-registry-check-2048',
    client: 'a tool-registry check',
    appliesTo: ['server-instructions', 'tool-description-upfront', 'tool-description-tool-search'],
    value: 2048,
    unit: 'utf8-bytes',
    effect: 'warn',
    fromVersion: null,
    untilVersion: null,
    sources: [
      {
        url: null,
        described:
          'The check is described, not named: its fix line and 2,048-byte threshold as reported on 2026-11-11. The check itself was not read.',
        quote:
          'Keep each tool description and the server instructions field at or below 2 KB, and put critical guidance first',
        readOn: READ_ON,
      },
    ],
  },
  {
    id: 'chatgpt-codex-lead-512',
    client: 'ChatGPT and Codex',
    appliesTo: ['server-instructions'],
    value: 512,
    unit: 'characters',
    effect: 'lead',
    fromVersion: null,
    untilVersion: null,
    sources: [
      {
        url: 'https://developers.openai.com/plugins/build/mcp-server',
        quote: 'Keep the most important details in the first 512 characters.',
        readOn: READ_ON,
      },
    ],
  },
];

function inForce(limit: ClientLimit): boolean {
  return limit.untilVersion === null;
}

/** Every `cut` record still in force: the whole string fits each. */
export function budgetLimits(surface: MetadataSurface): ClientLimit[] {
  return CLIENT_LIMITS.filter((l) => l.appliesTo.includes(surface) && l.effect === 'cut' && inForce(l));
}

/** Every `cut` record that has ended and every `warn` record: the critical items end inside each. */
export function criticalLimits(surface: MetadataSurface): ClientLimit[] {
  return CLIENT_LIMITS.filter(
    (l) => l.appliesTo.includes(surface) && ((l.effect === 'cut' && !inForce(l)) || l.effect === 'warn'),
  );
}

/** Every `lead` record: the purpose and the guide pointer end inside each. */
export function leadLimits(surface: MetadataSurface): ClientLimit[] {
  return CLIENT_LIMITS.filter((l) => l.appliesTo.includes(surface) && l.effect === 'lead');
}

const utf8 = new TextEncoder();

export function measure(text: string, unit: LimitUnit): number {
  return unit === 'characters' ? text.length : utf8.encode(text).length;
}
