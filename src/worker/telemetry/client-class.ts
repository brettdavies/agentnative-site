// Inbound client classification for page analytics: which audience a request
// came from, as a closed class plus a canonical agent name for the non-browser
// classes. Runs at the gateway on the original request, the only place a real
// User-Agent exists: `applyUaClass` in src/worker/accept.ts deletes it for HTML
// clients and rewrites it to `curl/` for markdown clients before the inner
// Worker runs.
//
// The agent name is always a label from the tables below, never a slice of
// the User-Agent. That header is attacker-controlled free text, and copying a
// token out of it would put that text in the dataset. An unrecognised client
// is `unknown` with no name and no User-Agent text: a rising unknown share is
// visible as a count, and extending a table is a deliberate investigation
// against staging traffic, never an always-on capture.
//
// `MARKDOWN_UA_TOKENS` in src/worker/accept.ts is a routing allowlist that
// deliberately excludes the crawler classes named here so Googlebot, GPTBot,
// and ClaudeBot keep receiving HTML. The two tables share tokens and diverge
// on purpose; they must not be merged.

import { MAX_HEADER_LENGTH } from './user-agent';

export type ClientClass = 'browser' | 'ai-fetcher' | 'ai-crawler' | 'search-crawler' | 'cli-client' | 'unknown';

type TokenTable = ReadonlyArray<readonly [token: string, name: string]>;

type NameIn<T extends TokenTable> = T[number][1];

// A live read on behalf of a human, the canonical agent-native read path.
const AI_FETCHER_TOKENS = [
  ['chatgpt-user', 'ChatGPT-User'],
  ['claude-user', 'Claude-User'],
  ['perplexity-user', 'Perplexity-User'],
] as const satisfies TokenTable;

// Corpus building for training or an AI search index, not a read for a
// present human. `applebot-extended` lives here and is checked before the
// search-crawler table, whose `applebot` token it contains.
const AI_CRAWLER_TOKENS = [
  ['gptbot', 'GPTBot'],
  ['oai-searchbot', 'OAI-SearchBot'],
  ['claudebot', 'ClaudeBot'],
  ['claude-searchbot', 'Claude-SearchBot'],
  ['perplexitybot', 'PerplexityBot'],
  ['anthropic-ai', 'anthropic-ai'],
  ['google-extended', 'Google-Extended'],
  ['ccbot', 'CCBot'],
  ['bytespider', 'Bytespider'],
  ['amazonbot', 'Amazonbot'],
  ['applebot-extended', 'Applebot-Extended'],
  ['meta-externalagent', 'Meta-ExternalAgent'],
] as const satisfies TokenTable;

const SEARCH_CRAWLER_TOKENS = [
  ['googlebot', 'Googlebot'],
  ['bingbot', 'bingbot'],
  ['duckduckbot', 'DuckDuckBot'],
  ['applebot', 'Applebot'],
  ['yandexbot', 'YandexBot'],
  ['baiduspider', 'Baiduspider'],
] as const satisfies TokenTable;

// The trailing `/` anchors tokens that are ambiguous bare (`java/`, not
// `java`). `anc-web-audit/` is the site's own auditor, whose full string is
// `AUDIT_USER_AGENT` in src/shared/user-agents.ts; it is matched by product
// token like every other entry.
const CLI_CLIENT_TOKENS = [
  ['curl/', 'curl'],
  ['wget/', 'wget'],
  ['httpie/', 'HTTPie'],
  ['python-requests/', 'python-requests'],
  ['python-httpx/', 'python-httpx'],
  ['go-http-client/', 'Go-http-client'],
  ['node-fetch', 'node-fetch'],
  ['undici', 'undici'],
  ['okhttp/', 'okhttp'],
  ['java/', 'Java'],
  ['libwww-perl', 'libwww-perl'],
  ['postmanruntime/', 'PostmanRuntime'],
  ['axios/', 'axios'],
  ['anc-web-audit/', 'anc-web-audit'],
] as const satisfies TokenTable;

export type AgentName =
  | NameIn<typeof AI_FETCHER_TOKENS>
  | NameIn<typeof AI_CRAWLER_TOKENS>
  | NameIn<typeof SEARCH_CRAWLER_TOKENS>
  | NameIn<typeof CLI_CLIENT_TOKENS>;

export type ClientClassification = { clientClass: ClientClass; agentName: AgentName | null };

// Agent tables run before browser detection because crawlers claim
// `Mozilla/5.0` and WebKit compatibility in their User-Agent.
const AGENT_TABLES = [
  ['ai-fetcher', AI_FETCHER_TOKENS],
  ['ai-crawler', AI_CRAWLER_TOKENS],
  ['search-crawler', SEARCH_CRAWLER_TOKENS],
  ['cli-client', CLI_CLIENT_TOKENS],
] as const;

const BROWSER_ENGINE_TOKENS = ['applewebkit', 'gecko', 'chrome/', 'safari/', 'firefox/'] as const;

const UNKNOWN: ClientClassification = { clientClass: 'unknown', agentName: null };

function matchTable<T extends TokenTable>(userAgent: string, table: T): NameIn<T> | null {
  for (const [token, name] of table) {
    if (userAgent.includes(token)) return name;
  }
  return null;
}

function isBrowser(userAgent: string): boolean {
  return userAgent.startsWith('mozilla/') && BROWSER_ENGINE_TOKENS.some((token) => userAgent.includes(token));
}

export function classifyClient(headers: Headers): ClientClassification {
  const userAgent = (headers.get('user-agent') ?? '').slice(0, MAX_HEADER_LENGTH).toLowerCase();
  if (userAgent === '') return UNKNOWN;
  for (const [clientClass, table] of AGENT_TABLES) {
    const agentName = matchTable(userAgent, table);
    if (agentName !== null) return { clientClass, agentName };
  }
  if (isBrowser(userAgent)) return { clientClass: 'browser', agentName: null };
  return UNKNOWN;
}
