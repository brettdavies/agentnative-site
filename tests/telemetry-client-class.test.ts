// Client-class taxonomy tests. The load-bearing assertion is that the
// agent name can only ever be a canonical label from the module's own
// table: an unrecognised product token yields null, and an unknown-class
// result carries no User-Agent text at all. The rest pins the closed
// union, the fetcher-versus-crawler split, the pairs whose tokens overlap,
// and the rule that crawlers claiming Mozilla compatibility are crawlers
// and not browsers.

import { describe, expect, test } from 'bun:test';
import { type AgentName, type ClientClass, classifyClient } from '../src/worker/telemetry/client-class';

function classify(userAgent: string | null) {
  const headers = new Headers();
  if (userAgent !== null) headers.set('user-agent', userAgent);
  return classifyClient(headers);
}

const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const FIREFOX_UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0';
const SAFARI_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';

type Expected = { clientClass: ClientClass; agentName: AgentName | null };

const TABLE: ReadonlyArray<readonly [string, Expected]> = [
  [
    'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot',
    { clientClass: 'ai-fetcher', agentName: 'ChatGPT-User' },
  ],
  [
    'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-User/1.0; +Claude-User@anthropic.com)',
    { clientClass: 'ai-fetcher', agentName: 'Claude-User' },
  ],
  [
    'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Perplexity-User/1.0; +https://perplexity.ai/perplexity-user)',
    { clientClass: 'ai-fetcher', agentName: 'Perplexity-User' },
  ],
  [
    'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)',
    { clientClass: 'ai-crawler', agentName: 'GPTBot' },
  ],
  [
    'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot',
    { clientClass: 'ai-crawler', agentName: 'OAI-SearchBot' },
  ],
  [
    'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)',
    { clientClass: 'ai-crawler', agentName: 'ClaudeBot' },
  ],
  [
    'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-SearchBot/1.0; +Claude-SearchBot@anthropic.com)',
    { clientClass: 'ai-crawler', agentName: 'Claude-SearchBot' },
  ],
  [
    'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)',
    { clientClass: 'ai-crawler', agentName: 'PerplexityBot' },
  ],
  [
    'Mozilla/5.0 (compatible; anthropic-ai/1.0; +http://www.anthropic.com/bot.html)',
    { clientClass: 'ai-crawler', agentName: 'anthropic-ai' },
  ],
  [
    'Mozilla/5.0 (compatible; Google-Extended/1.0; +https://developers.google.com/search/docs/crawling-indexing/overview-google-crawlers)',
    { clientClass: 'ai-crawler', agentName: 'Google-Extended' },
  ],
  ['CCBot/2.0 (https://commoncrawl.org/faq/)', { clientClass: 'ai-crawler', agentName: 'CCBot' }],
  [
    'Mozilla/5.0 (Linux; Android 5.0) AppleWebKit/537.36 (KHTML, like Gecko) Mobile Safari/537.36 (compatible; Bytespider; spider-feedback@bytedance.com)',
    { clientClass: 'ai-crawler', agentName: 'Bytespider' },
  ],
  [
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_10_1) AppleWebKit/600.2.5 (KHTML, like Gecko) Version/8.0.2 Safari/600.2.5 (Amazonbot/0.1; +https://developer.amazon.com/support/amazonbot)',
    { clientClass: 'ai-crawler', agentName: 'Amazonbot' },
  ],
  [
    'Mozilla/5.0 (compatible; Applebot-Extended/0.1; +http://www.apple.com/go/applebot)',
    { clientClass: 'ai-crawler', agentName: 'Applebot-Extended' },
  ],
  [
    'meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)',
    { clientClass: 'ai-crawler', agentName: 'Meta-ExternalAgent' },
  ],
  [
    'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    { clientClass: 'search-crawler', agentName: 'Googlebot' },
  ],
  [
    'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
    { clientClass: 'search-crawler', agentName: 'bingbot' },
  ],
  [
    'DuckDuckBot/1.1; (+http://duckduckgo.com/duckduckbot.html)',
    { clientClass: 'search-crawler', agentName: 'DuckDuckBot' },
  ],
  [
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.1.1 Safari/605.1.15 (Applebot/0.1; +http://www.apple.com/go/applebot)',
    { clientClass: 'search-crawler', agentName: 'Applebot' },
  ],
  [
    'Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)',
    { clientClass: 'search-crawler', agentName: 'YandexBot' },
  ],
  [
    'Mozilla/5.0 (compatible; Baiduspider/2.0; +http://www.baidu.com/search/spider.html)',
    { clientClass: 'search-crawler', agentName: 'Baiduspider' },
  ],
  ['curl/8.7.1', { clientClass: 'cli-client', agentName: 'curl' }],
  ['Wget/1.21.4', { clientClass: 'cli-client', agentName: 'wget' }],
  ['HTTPie/3.2.2', { clientClass: 'cli-client', agentName: 'HTTPie' }],
  ['python-requests/2.32.3', { clientClass: 'cli-client', agentName: 'python-requests' }],
  ['python-httpx/0.27.0', { clientClass: 'cli-client', agentName: 'python-httpx' }],
  ['Go-http-client/2.0', { clientClass: 'cli-client', agentName: 'Go-http-client' }],
  ['node-fetch/1.0 (+https://github.com/bitinn/node-fetch)', { clientClass: 'cli-client', agentName: 'node-fetch' }],
  ['undici', { clientClass: 'cli-client', agentName: 'undici' }],
  ['okhttp/4.12.0', { clientClass: 'cli-client', agentName: 'okhttp' }],
  ['Java/17.0.2', { clientClass: 'cli-client', agentName: 'Java' }],
  ['libwww-perl/6.72', { clientClass: 'cli-client', agentName: 'libwww-perl' }],
  ['PostmanRuntime/7.39.0', { clientClass: 'cli-client', agentName: 'PostmanRuntime' }],
  ['axios/1.7.2', { clientClass: 'cli-client', agentName: 'axios' }],
  ['anc-web-audit/1.0 (+https://anc.dev/web-audit)', { clientClass: 'cli-client', agentName: 'anc-web-audit' }],
  [CHROME_UA, { clientClass: 'browser', agentName: null }],
  [FIREFOX_UA, { clientClass: 'browser', agentName: null }],
  [SAFARI_UA, { clientClass: 'browser', agentName: null }],
];

function byName(name: AgentName): string {
  const row = TABLE.find(([, expected]) => expected.agentName === name);
  if (!row) throw new Error(`no fixture for ${name}`);
  return row[0];
}

describe('classifyClient', () => {
  test('AI user-fetchers classify as ai-fetcher with canonical names', () => {
    expect(classify(byName('ChatGPT-User'))).toEqual({ clientClass: 'ai-fetcher', agentName: 'ChatGPT-User' });
    expect(classify(byName('Claude-User'))).toEqual({ clientClass: 'ai-fetcher', agentName: 'Claude-User' });
    expect(classify(byName('Perplexity-User'))).toEqual({ clientClass: 'ai-fetcher', agentName: 'Perplexity-User' });
  });

  test('AI corpus crawlers classify as ai-crawler, not ai-fetcher', () => {
    for (const name of ['GPTBot', 'ClaudeBot', 'OAI-SearchBot', 'PerplexityBot'] as const) {
      const result = classify(byName(name));
      expect(result).toEqual({ clientClass: 'ai-crawler', agentName: name });
      expect(result.clientClass).not.toBe('ai-fetcher');
    }
  });

  test('search engines are search-crawler, shell clients are cli-client, Chrome is browser with no name', () => {
    expect(classify(byName('Googlebot'))).toEqual({ clientClass: 'search-crawler', agentName: 'Googlebot' });
    expect(classify(byName('bingbot'))).toEqual({ clientClass: 'search-crawler', agentName: 'bingbot' });
    expect(classify(byName('curl'))).toEqual({ clientClass: 'cli-client', agentName: 'curl' });
    expect(classify(byName('wget'))).toEqual({ clientClass: 'cli-client', agentName: 'wget' });
    expect(classify(byName('python-requests'))).toEqual({ clientClass: 'cli-client', agentName: 'python-requests' });
    expect(classify(CHROME_UA)).toEqual({ clientClass: 'browser', agentName: null });
  });

  test('every table entry resolves to its canonical label', () => {
    for (const [ua, expected] of TABLE) {
      expect(classify(ua)).toEqual(expected);
    }
  });

  test('the site auditor classifies as cli-client under its own label', () => {
    expect(classify('anc-web-audit/1.0 (+https://anc.dev/web-audit)')).toEqual({
      clientClass: 'cli-client',
      agentName: 'anc-web-audit',
    });
  });
});

describe('classifyClient agent name closure', () => {
  test('an unrecognised product token yields a null agent name, never the token', () => {
    const results = [
      classify('Mozilla/5.0 (compatible; EvilBot/1.0; +https://example.com/evil)'),
      classify(`${CHROME_UA} CustomToken/3.1`),
      classify('SuperSecretAgent/9.9 (token-that-must-not-leak)'),
    ];
    for (const result of results) {
      expect(result.agentName).toBeNull();
      const serialized = JSON.stringify(result).toLowerCase();
      for (const leak of ['evilbot', 'customtoken', 'supersecretagent', 'token-that-must-not-leak']) {
        expect(serialized).not.toContain(leak);
      }
    }
    expect(results[1].clientClass).toBe('browser');
  });

  test('an unknown-class record carries only the class and a null name', () => {
    const ua = 'SuperSecretAgent/9.9 (token-that-must-not-leak)';
    const result = classify(ua);
    expect(result).toEqual({ clientClass: 'unknown', agentName: null });
    expect(JSON.stringify(result)).toBe('{"clientClass":"unknown","agentName":null}');
    const serialized = JSON.stringify(result).toLowerCase();
    for (const fragment of ua.toLowerCase().split(/[^a-z0-9-]+/)) {
      if (fragment.length < 3) continue;
      expect(serialized).not.toContain(fragment);
    }
  });

  test('the agent name type is closed over the table', () => {
    // @ts-expect-error 'SuperSecretAgent' is not a canonical label
    const name: AgentName = 'SuperSecretAgent';
    expect(typeof name).toBe('string');
  });
});

describe('classifyClient unknown and input bounds', () => {
  test('absent, empty, and unrecognised User-Agents are unknown', () => {
    expect(classify(null)).toEqual({ clientClass: 'unknown', agentName: null });
    expect(classify('')).toEqual({ clientClass: 'unknown', agentName: null });
    expect(classify('Mozilla/4.0 (compatible; MSIE 6.0; Windows NT 5.1)')).toEqual({
      clientClass: 'unknown',
      agentName: null,
    });
    expect(classify('totally-unknown-thing 1.0')).toEqual({ clientClass: 'unknown', agentName: null });
  });

  test('matching is case-insensitive and the returned label keeps canonical casing', () => {
    expect(classify('GPTBOT/1.2')).toEqual({ clientClass: 'ai-crawler', agentName: 'GPTBot' });
    expect(classify('gptbot/1.2')).toEqual({ clientClass: 'ai-crawler', agentName: 'GPTBot' });
    expect(classify('CURL/8.7.1')).toEqual({ clientClass: 'cli-client', agentName: 'curl' });
    expect(classify('MOZILLA/5.0 (X11; Linux x86_64) APPLEWEBKIT/537.36 CHROME/126.0.0.0')).toEqual({
      clientClass: 'browser',
      agentName: null,
    });
  });

  test('an oversized User-Agent is bounded before matching', () => {
    const padding = 'x'.repeat(10_000);
    expect(classify(`curl/8.7.1 ${padding}`)).toEqual({ clientClass: 'cli-client', agentName: 'curl' });
    expect(classify(`${padding} curl/8.7.1`)).toEqual({ clientClass: 'unknown', agentName: null });
  });
});

describe('classifyClient precedence', () => {
  test('crawlers that claim Mozilla and WebKit compatibility stay crawlers', () => {
    for (const name of ['GPTBot', 'ChatGPT-User', 'Amazonbot', 'Bytespider', 'Applebot'] as const) {
      expect(classify(byName(name)).clientClass).not.toBe('browser');
      expect(classify(byName(name)).agentName).toBe(name);
    }
  });

  test('Applebot-Extended resolves before Applebot', () => {
    expect(classify(byName('Applebot-Extended'))).toEqual({
      clientClass: 'ai-crawler',
      agentName: 'Applebot-Extended',
    });
    expect(classify(byName('Applebot'))).toEqual({ clientClass: 'search-crawler', agentName: 'Applebot' });
  });

  test('Claude-User, Claude-SearchBot, and ClaudeBot do not collide', () => {
    expect(classify(byName('Claude-User'))).toEqual({ clientClass: 'ai-fetcher', agentName: 'Claude-User' });
    expect(classify(byName('Claude-SearchBot'))).toEqual({ clientClass: 'ai-crawler', agentName: 'Claude-SearchBot' });
    expect(classify(byName('ClaudeBot'))).toEqual({ clientClass: 'ai-crawler', agentName: 'ClaudeBot' });
  });

  test('ChatGPT-User and OAI-SearchBot do not collide with GPTBot', () => {
    expect(classify(byName('ChatGPT-User'))).toEqual({ clientClass: 'ai-fetcher', agentName: 'ChatGPT-User' });
    expect(classify(byName('OAI-SearchBot'))).toEqual({ clientClass: 'ai-crawler', agentName: 'OAI-SearchBot' });
    expect(classify(byName('GPTBot'))).toEqual({ clientClass: 'ai-crawler', agentName: 'GPTBot' });
  });

  test('Perplexity-User and PerplexityBot do not collide', () => {
    expect(classify(byName('Perplexity-User'))).toEqual({ clientClass: 'ai-fetcher', agentName: 'Perplexity-User' });
    expect(classify(byName('PerplexityBot'))).toEqual({ clientClass: 'ai-crawler', agentName: 'PerplexityBot' });
  });

  test('Google-Extended resolves as ai-crawler while Googlebot stays search-crawler', () => {
    expect(classify(byName('Google-Extended'))).toEqual({ clientClass: 'ai-crawler', agentName: 'Google-Extended' });
    expect(classify(byName('Googlebot'))).toEqual({ clientClass: 'search-crawler', agentName: 'Googlebot' });
  });

  test('a fetcher token wins over a crawler token in the same string', () => {
    expect(classify('Mozilla/5.0 (compatible; ChatGPT-User/1.0; GPTBot/1.2)')).toEqual({
      clientClass: 'ai-fetcher',
      agentName: 'ChatGPT-User',
    });
  });
});
