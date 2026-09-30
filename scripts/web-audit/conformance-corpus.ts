// Conformance corpus harness. A scenario names a target, a declared site
// type and the exchanges a stub fetch answers; running the engine over it
// yields the golden scorecard the CLI's Rust port must reproduce byte for
// byte. The stub sits at the single-hop `fetchImpl` seam, so redirects,
// body caps and header handling above it are exercised as the engine
// exercises them on a live target. The format contract is the README this
// module emits into the corpus directory.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import { normalizeWebAuditRegistry } from '../../src/build/13-web-audit-registry.mjs';
import type { ExpectBlock } from '../../src/worker/audit-web/assert';
import { runWebAudit } from '../../src/worker/audit-web/engine';
import type { WebAuditRegistry, WebSiteType } from '../../src/worker/audit-web/registry';
import type { WebScorecard } from '../../src/worker/audit-web/scorecard';
import { SCENARIOS } from './conformance-scenarios';

export const REPO_ROOT = join(import.meta.dir, '..', '..');
export const REGISTRY_PATH = join(REPO_ROOT, 'src', 'data', 'web-audit', 'registry.yaml');
export const CORPUS_DIR = join(REPO_ROOT, 'tests', 'fixtures', 'web-audit-conformance');
export const SCENARIOS_DIR = join(CORPUS_DIR, 'scenarios');

/** The clock every scenario runs under; the engine's deadline never fires. */
const FIXED_NOW_MS = Date.UTC(2026, 0, 1);

export type ExchangeRequest = {
  method: string;
  url: string;
  /** Subset match on lowercased header names with exact values. */
  headers?: Record<string, string>;
  /** The top-level `method` of the request body parsed as JSON. */
  body_json_method?: string;
  /** Substring match on the raw request body. */
  body_contains?: string;
};

export type ExchangeResponse =
  | { status: number; headers: Record<string, string>; body: string }
  | { error: string };

export type Exchange = { request: ExchangeRequest; response: ExchangeResponse };

export type Scenario = {
  description: string;
  covers: string[];
  target: string;
  site_type: WebSiteType | null;
  spec_version: string;
  unmatched: ExchangeResponse;
  allow_unmatched: boolean;
  exchanges: Exchange[];
};

export function loadRegistry(): WebAuditRegistry {
  return normalizeWebAuditRegistry(yaml.load(readFileSync(REGISTRY_PATH, 'utf8')) as object) as WebAuditRegistry;
}

function normalizeUrl(raw: string): string {
  return new URL(raw).toString();
}

function lowercaseHeaders(init: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(init).forEach((value, name) => {
    out[name.toLowerCase()] = value;
  });
  return out;
}

type SeenRequest = { method: string; url: string; headers: Record<string, string>; body: string };

function bodyJsonMethod(body: string): string | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const method = (parsed as { method?: unknown }).method;
      return typeof method === 'string' ? method : null;
    }
  } catch {
    return null;
  }
  return null;
}

function matches(rule: ExchangeRequest, seen: SeenRequest): boolean {
  if (rule.method.toUpperCase() !== seen.method) return false;
  if (normalizeUrl(rule.url) !== seen.url) return false;
  for (const [name, value] of Object.entries(rule.headers ?? {})) {
    if (seen.headers[name.toLowerCase()] !== value) return false;
  }
  if (rule.body_json_method !== undefined && bodyJsonMethod(seen.body) !== rule.body_json_method) return false;
  if (rule.body_contains !== undefined && !seen.body.includes(rule.body_contains)) return false;
  return true;
}

const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

/**
 * A transport failure is an `Error` whose name and message reproduce the
 * `Name: message` string the engine records at the seam. A TimeoutError
 * collapses to the engine's fixed deadline wording whatever its message.
 */
function failureFrom(error: string): Error {
  const sep = error.indexOf(': ');
  if (sep <= 0) throw new Error(`transport error ${JSON.stringify(error)} must be of the form "Name: message"`);
  const err = new Error(error.slice(sep + 2));
  err.name = error.slice(0, sep);
  return err;
}

function toResponse(spec: ExchangeResponse): Response {
  if ('error' in spec) throw failureFrom(spec.error);
  if ('content-encoding' in spec.headers) {
    throw new Error('corpus responses carry decoded bodies; content-encoding is not allowed');
  }
  const body = NULL_BODY_STATUSES.has(spec.status) && spec.body === '' ? null : spec.body;
  return new Response(body, { status: spec.status, headers: spec.headers });
}

export type StubLog = { unmatched: string[] };

/** The stub fetch for a scenario: first matching exchange wins, else the unmatched policy. */
export function stubFetchFor(scenario: Scenario, log: StubLog): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const seen: SeenRequest = {
      method: (init?.method ?? 'GET').toUpperCase(),
      url: normalizeUrl(rawUrl),
      headers: lowercaseHeaders(init?.headers),
      body: init?.body === undefined || init?.body === null ? '' : String(init.body),
    };
    const hit = scenario.exchanges.find((exchange) => matches(exchange.request, seen));
    if (hit) return toResponse(hit.response);
    log.unmatched.push(`${seen.method} ${seen.url}`);
    return toResponse(scenario.unmatched);
  }) as typeof fetch;
}

/**
 * Normalizes a scorecard for comparison across engines: result rows take
 * registry order, because wave-2 rows arrive in whatever order the
 * concurrent probes resolve, which no second engine can reproduce and
 * which carries no meaning. The rows carry no wall-clock field (the
 * scorecard keeps the summarized evidence line, not the raw evidence), so
 * nothing else needs normalizing.
 */
export function normalizeScorecard(scorecard: WebScorecard, registry: WebAuditRegistry): WebScorecard {
  const order = new Map(registry.checks.map((check, index) => [check.id, index]));
  const results = [...scorecard.results].sort((a, b) => (order.get(a.id) ?? -1) - (order.get(b.id) ?? -1));
  return { ...scorecard, results };
}

export type ScenarioRun = { output: string; unmatched: string[] };

export async function runScenario(name: string, scenario: Scenario, registry: WebAuditRegistry): Promise<ScenarioRun> {
  const log: StubLog = { unmatched: [] };
  const audit = runWebAudit({
    url: scenario.target,
    registry,
    siteType: scenario.site_type,
    specVersion: scenario.spec_version,
    fetchOptions: { fetchImpl: stubFetchFor(scenario, log) },
    now: () => FIXED_NOW_MS,
  });
  let scorecard: WebScorecard | null = null;
  let unreachable: string | null = null;
  for await (const event of audit) {
    if (event.type === 'complete') scorecard = event.scorecard;
    if (event.type === 'unreachable') unreachable = event.reason;
  }
  if (log.unmatched.length > 0 && !scenario.allow_unmatched) {
    throw new Error(`scenario ${name} hit its unmatched policy: ${log.unmatched.join(', ')}`);
  }
  if (unreachable !== null) return { output: `${JSON.stringify({ unreachable }, null, 2)}\n`, unmatched: log.unmatched };
  if (scorecard === null) throw new Error(`scenario ${name} produced neither a scorecard nor an unreachable event`);
  return { output: `${JSON.stringify(normalizeScorecard(scorecard, registry), null, 2)}\n`, unmatched: log.unmatched };
}

// ---------------------------------------------------------------------------
// regex-parity.json
// ---------------------------------------------------------------------------

/**
 * One fixed probe table for every registry pattern: ASCII and non-ASCII
 * digits and letters, case-fold pairs, every line terminator JavaScript
 * treats specially, the empty string, and the literal tokens the
 * registry's patterns look for.
 */
export const REGEX_PROBES: readonly string[] = [
  '',
  ' ',
  '\t',
  '\n',
  '\r',
  '\r\n',
  ' ',
  ' ',
  '',
  'abc',
  'ABC',
  'AbC',
  'a\nb',
  'a\rb',
  'a\r\nb',
  'a b',
  'a b',
  'ab',
  'ab',
  'ab',
  'ok\n',
  'ok\r\n',
  '0123456789',
  '٠١٢٣',
  '１２３',
  '²³',
  'Straße',
  'STRASSE',
  'ǅ',
  'ﬁ',
  'İstanbul',
  'istanbul',
  'K',
  'k',
  'ſ',
  's',
  'café',
  'CAFÉ',
  'éèê',
  'АБВ',
  '日本語',
  '😀',
  'a_b-c.d',
  '#',
  '# Title',
  '  # Title',
  '\n# Title',
  '\r\n# Title',
  '> summary',
  '](https://example.com/x)',
  '](http://example.com/x)',
  ']( https://example.com/x)',
  'openapi',
  'OPENAPI',
  'swagger',
  '{"openapi":"3.1.0"}',
  'application/json',
  'application/json; charset=utf-8',
  'text/markdown',
  'text/markdown; charset=utf-8',
  'text/plain',
  'TEXT/PLAIN',
  'text/html',
  'application/ld+json',
  'application/ld json',
  'linkset',
  'application/linkset+json',
  'keys',
  'jwk',
  'Contact: mailto:security@example.com',
  'contact:',
  'issuer',
  'authorization_endpoint',
  'token_endpoint',
  'authorization_servers',
  'resource',
  'mcp_endpoint',
  'serverInfo',
  'transport',
  '"name"',
  'name',
  'supportedInterfaces',
  'skills',
  'specVersion',
  'entries',
  '<main>',
  '<MAIN>',
  '<article>',
  '<section>',
  '<nav>',
  '<navigation>',
  '<mainframe>',
  '<noscript>',
  '<NOSCRIPT',
  '<meta name="description" content="x">',
  "<meta name='description' content='x'>",
  '<meta property="og:description">',
  '<meta\nname="description">',
  'rel="service-desc"',
  "rel='alternate'",
  'rel="service-doc"',
  'rel=service-desc',
  'rel="describedby"',
  'rel="api-catalog"',
  'rel=api-catalog',
  'User-agent: *',
  'user-agent: gptbot',
  'User-Agent: GPTBot',
  '  User-agent: ClaudeBot',
  'Disallow: /\nUser-agent: Google-Extended',
  'User-agent:Bytespider',
  'User-agent: Other',
  'Content-Signal: ai-train=no',
  'content-signal: search=yes',
  'Content-Signal:ai-input=yes',
  'Content-Signal: other',
  'just a moment',
  'Just a Moment...',
  'Attention Required!',
  'cf-challenge',
  'Enable JavaScript and cookies to continue',
  'captcha',
  'CAPTCHA',
  'accept',
  'accept-encoding',
  'accept-encoding, user-agent',
  'accept, user-agent',
  'user-agent, accept',
  'user-agent, accept-encoding',
  'Accept-Language,User-Agent',
  'accept-encoding,accept',
  'accept-encoding, accept, user-agent',
  'User-Agent, Accept-Encoding, Accept',
  'user-agent',
  'accept-, user-agent',
  'acceptuser-agent',
  'user-agentaccept',
  '*',
];

type RegexField = 'content_type' | 'header_regex' | 'body_regex' | 'body_not_regex';

export type RegexParityEntry = {
  check_id: string;
  field: RegexField;
  pattern: string;
  flags: 'i' | 'im';
  results: boolean[];
};

export type RegexParityFixture = { probes: string[]; patterns: RegexParityEntry[] };

/** Every registry pattern under the flags assert.ts compiles it with, crossed with the probe table. */
export function regexParityFixture(registry: WebAuditRegistry): RegexParityFixture {
  const patterns: RegexParityEntry[] = [];
  const push = (check_id: string, field: RegexField, pattern: string, flags: 'i' | 'im'): void => {
    const re = new RegExp(pattern, flags);
    patterns.push({ check_id, field, pattern, flags, results: REGEX_PROBES.map((probe) => re.test(probe)) });
  };
  for (const check of registry.checks) {
    const expect = (check.with as { expect?: ExpectBlock }).expect;
    if (!expect) continue;
    if (expect.content_type !== undefined) push(check.id, 'content_type', expect.content_type, 'i');
    if (expect.header_regex !== undefined) push(check.id, 'header_regex', expect.header_regex.pattern, 'i');
    if (expect.body_regex !== undefined) push(check.id, 'body_regex', expect.body_regex, 'im');
    if (expect.body_not_regex !== undefined) push(check.id, 'body_not_regex', expect.body_not_regex, 'im');
  }
  return { probes: [...REGEX_PROBES], patterns };
}

// ---------------------------------------------------------------------------
// Corpus generation
// ---------------------------------------------------------------------------

function validateScenario(name: string, scenario: Scenario, ids: ReadonlySet<string>): void {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error(`scenario name ${JSON.stringify(name)} is not kebab-case`);
  if (scenario.covers.length === 0) throw new Error(`scenario ${name} covers no check`);
  for (const id of scenario.covers) {
    if (!ids.has(id)) throw new Error(`scenario ${name} covers unknown check ${JSON.stringify(id)}`);
  }
  const responses = [scenario.unmatched, ...scenario.exchanges.map((exchange) => exchange.response)];
  for (const response of responses) {
    if ('error' in response) {
      failureFrom(response.error);
      continue;
    }
    for (const header of Object.keys(response.headers)) {
      if (header !== header.toLowerCase()) throw new Error(`scenario ${name}: header ${header} is not lowercase`);
      if (header === 'content-encoding') throw new Error(`scenario ${name}: content-encoding is not allowed`);
    }
  }
  for (const exchange of scenario.exchanges) {
    for (const header of Object.keys(exchange.request.headers ?? {})) {
      if (header !== header.toLowerCase()) throw new Error(`scenario ${name}: request header ${header} is not lowercase`);
    }
  }
}

function scenarioJson(scenario: Scenario): string {
  const ordered: Scenario = {
    description: scenario.description,
    covers: scenario.covers,
    target: scenario.target,
    site_type: scenario.site_type,
    spec_version: scenario.spec_version,
    unmatched: scenario.unmatched,
    allow_unmatched: scenario.allow_unmatched,
    exchanges: scenario.exchanges,
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

function readme(names: string[]): string {
  const rows = names.map((name) => {
    const scenario = SCENARIOS[name];
    return `| \`${name}\` | ${scenario.description} | ${scenario.covers.map((id) => `\`${id}\``).join(', ')} |`;
  });
  return `# Web-audit conformance corpus

Golden fixtures that pin the web-audit engine for the CLI's Rust port. Each scenario pairs the exchanges a
stub fetch answers with the scorecard the engine produces over them; both engines must reproduce
\`scorecard.json\` byte for byte from \`scenario.json\`. The generator is \`scripts/web-audit/gen-fixtures.ts\`
and the scenarios are authored in \`scripts/web-audit/conformance-scenarios.ts\`; this directory is its output
and \`tests/web-audit-conformance-corpus.test.ts\` fails when the two disagree.

## Layout

\`\`\`text
tests/fixtures/web-audit-conformance/
  README.md                        this file
  regex-parity.json                every registry pattern x a fixed probe table -> RegExp boolean
  scenarios/<name>/scenario.json   input: target, site type, exchanges, unmatched policy
  scenarios/<name>/scorecard.json  output: the engine's scorecard, normalized as described below
\`\`\`

## scenario.json

- \`description\`: what the scenario exercises.
- \`covers\`: the check ids the scenario is the subject of; the completeness gate requires every registry id
  to appear in at least one scenario's list.
- \`target\`: the URL handed to the engine.
- \`site_type\`: \`"content"\`, \`"api"\` or \`null\` (run everything).
- \`spec_version\`: the literal both engines are given for the run.
- \`unmatched\`: the response for a request no exchange matches, either a transport failure
  (\`{"error": "Name: message"}\`) or a full response.
- \`allow_unmatched\`: when false, generation fails if any request reaches the unmatched policy.
- \`exchanges\`: ordered rules; the first match wins and a rule may match repeatedly.

Matching: \`method\` compares case-insensitively; \`url\` compares after both sides pass through the URL
parser; \`headers\` is a subset match on lowercase names with exact values; \`body_json_method\` parses the
request body as JSON and compares its top-level \`method\`; \`body_contains\` is a substring match on the raw
body.

Responses carry lowercase header names with single string values and a UTF-8 text body exactly as the engine
reads it. No response carries \`content-encoding\`: decompression is pinned by transport tests, not by the
corpus. A transport failure is \`{"error": "Name: message"}\`, the string \`ProbeResponse.error\` carries at the
seam; a \`TimeoutError\` is always recorded as \`TimeoutError: deadline exceeded\`. Redirects are ordinary
exchanges (a 3xx with a \`location\` header) that the guarded fetch above the seam follows with a new request.

## scorecard.json

The engine's terminal scorecard as \`JSON.stringify(scorecard, null, 2)\` plus a trailing newline, with one
normalization applied before writing and expected of any engine under comparison: \`results\` is sorted into
registry order, because wave-2 rows arrive in the order the concurrent probes resolve, which carries no
meaning and which a second engine cannot reproduce. Rows carry the summarized \`evidence\` line, never the raw
evidence, so no wall-clock value reaches the file. Key order is otherwise the engine's emission order and
every number is an integer. A scenario that ends in
the engine's \`unreachable\` event writes \`{"unreachable": "<reason>"}\` instead of a scorecard. The engine runs
under a fixed clock, so no per-audit deadline fires; per-probe timeouts appear only as declared transport
failures.

## regex-parity.json

\`probes\` is one fixed string table; \`patterns\` lists every \`content_type\`, \`header_regex\`, \`body_regex\`
and \`body_not_regex\` value in the normalized registry with the flags \`assert.ts\` compiles it under (\`i\` for
the first two, \`im\` for the body patterns) and \`results[i] = new RegExp(pattern, flags).test(probes[i])\`.

## Scenarios

| Scenario | Exercises | Subject checks |
| -------- | --------- | -------------- |
${rows.join('\n')}
`;
}

/** Every corpus file by path relative to the corpus directory. */
export async function generateCorpus(registry: WebAuditRegistry): Promise<Map<string, string>> {
  const ids = new Set(registry.checks.map((check) => check.id));
  const names = Object.keys(SCENARIOS).sort();
  const files = new Map<string, string>();
  for (const name of names) {
    const scenario = SCENARIOS[name];
    validateScenario(name, scenario, ids);
    const run = await runScenario(name, scenario, registry);
    files.set(`scenarios/${name}/scenario.json`, scenarioJson(scenario));
    files.set(`scenarios/${name}/scorecard.json`, run.output);
  }
  files.set('regex-parity.json', `${JSON.stringify(regexParityFixture(registry), null, 2)}\n`);
  files.set('README.md', readme(names));
  return files;
}
