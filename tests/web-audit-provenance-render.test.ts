// The website result page and its markdown twin say where each row's
// evidence came from: a Declared hosts section (or one line saying why there
// is none), a host line per category and a host note per differing row, one
// outcome per host on rows over several hosts, closed groups for rows the
// audit could not run, and what a reader can run to evaluate them.

import { describe, expect, test } from 'bun:test';
import { findingRowsFromElements } from '../src/client/assemble-prompt';
import { getWorksheet } from '../src/client/webmcp-result';
import { enrichWebScorecardForDisplay } from '../src/worker/audit-web/display';
import { buildWebSummaryMarkdown } from '../src/worker/audit-web/summary-markdown';
import { buildWebSummaryBody } from '../src/worker/audit-web/summary-render';
import type { TransientReason } from '../src/worker/audit-web/summary-transient';
import {
  at,
  REGISTRY,
  REMEDIATION,
  row,
  STRIPE_TRAIL,
  type StoredScorecard,
  scorecardOf,
  stripeShaped,
  twoAnchorShaped,
} from './helpers/declared-host-scorecards';
import { parseHtml } from './helpers/html-elements';

type Scorecard = StoredScorecard;

const FRESHNESS = { cached: true, scored_at: '2026-09-10T17:20:00.000Z', refresh_after: '2026-09-10T17:21:00.000Z' };

function input(scorecard: Scorecard, opts: { lanes?: boolean; transient?: TransientReason } = {}) {
  const host = new URL(scorecard.target_url).host;
  return {
    scorecard: scorecard as never,
    domain: host,
    targetUrl: scorecard.target_url,
    remediation: REMEDIATION,
    ...(opts.lanes === false ? {} : { registry: REGISTRY }),
    origin: 'https://anc.dev',
    freshness: FRESHNESS,
    ...(opts.transient ? { transient: opts.transient } : {}),
  };
}

const page = (scorecard: Scorecard, opts?: Parameters<typeof input>[1]) => buildWebSummaryBody(input(scorecard, opts));
const twin = (scorecard: Scorecard, opts?: Parameters<typeof input>[1]) =>
  buildWebSummaryMarkdown(input(scorecard, opts));

/** The text of an HTML fragment, tags dropped and entities read back. */
function textOf(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replaceAll('&#39;', "'")
    .replaceAll('&quot;', '"')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

function categoryHtml(html: string, id: string): string {
  const start = html.indexOf(`data-category="${id}"`);
  const end = html.indexOf('</li>\n', html.indexOf('<span class="stpill', start));
  return html.slice(start, end);
}

function sectionMd(md: string, heading: string): string {
  const start = md.indexOf(heading);
  const next = md.indexOf('\n## ', start + heading.length);
  return md.slice(start, next === -1 ? undefined : next);
}

/** A stored scorecard from before provenance: no hosts or advisories on rows, no follow state, no trail. */
function preProvenance(): Scorecard {
  const sc = stripeShaped();
  const { follow_declarations: _f, declared_hosts: _d, ...rest } = sc;
  return {
    ...rest,
    results: sc.results.map(({ hosts: _h, host: _x, advisory: _a, ...r }) =>
      r.na_reason === 'auth-required' ? { ...r, na_reason: undefined, status: 'n_a' } : r,
    ),
  } as Scorecard;
}

describe('the Declared hosts slot', () => {
  test('a followed audit lists its trail in a labelled section between the score note and the checks', () => {
    const html = page(stripeShaped());
    const start = html.indexOf('<section class="declared-hosts"');
    const section = html.slice(start, html.indexOf('</section>', start) + 10);
    expect(section).toContain('id="declared-hosts" aria-labelledby="declared-hosts-heading"');
    expect(section).toContain('<h2 id="declared-hosts-heading">Declared hosts</h2>');
    expect(textOf(section)).toContain(
      'stripe.dev points agents to these hosts; results from the hosts anc could confirm are credited to stripe.dev.',
    );
    expect(section.match(/<li class="declared-hosts__entry">/g)).toHaveLength(STRIPE_TRAIL.length);
    const order = ['result-score__note', 'data-web-audit-context', 'class="declared-hosts"', 'pscore-heading'];
    const positions = order.map((marker) => html.indexOf(marker));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);

    const md = twin(stripeShaped());
    expect(md.indexOf('## Declared hosts')).toBeGreaterThan(0);
    expect(md.indexOf('## Declared hosts')).toBeLessThan(md.indexOf('## API'));
    expect(sectionMd(md, '## Declared hosts').match(/^- /gm)).toHaveLength(STRIPE_TRAIL.length);
  });

  const STATES: Array<[string, () => Scorecard, TransientReason | undefined, string]> = [
    ['the follow field missing', preProvenance, undefined, 'Declared hosts: not recorded for this audit.'],
    [
      'following paused by the kill switch',
      () => ({ ...stripeShaped(), follow_declarations: false, declared_hosts: [] }),
      undefined,
      'Declared hosts: not followed; following is paused.',
    ],
    [
      'following off for this run',
      () => ({ ...stripeShaped(), follow_declarations: false, declared_hosts: [] }),
      { kind: 'opt-out' },
      'Declared hosts: not followed for this run.',
    ],
    [
      'nothing declared',
      () => ({ ...stripeShaped(), declared_hosts: [] }),
      undefined,
      'Declared hosts: none declared.',
    ],
  ];

  for (const [name, scorecard, transient, line] of STATES) {
    test(`${name} renders one line on the page and the twin`, () => {
      const html = page(scorecard(), { transient });
      expect(html).toContain(`<p class="declared-hosts__state" id="declared-hosts">${line}</p>`);
      expect(html).not.toContain('class="declared-hosts"');
      const md = twin(scorecard(), { transient });
      expect(md).toContain(`\n${line}\n`);
      expect(md).not.toContain('## Declared hosts');
    });
  }

  test('following off reads as one line even when the site declared hosts', () => {
    const paused = { ...stripeShaped(), follow_declarations: false };
    expect(page(paused)).toContain('Declared hosts: not followed; following is paused.');
    expect(page(paused, { transient: { kind: 'opt-out' } })).toContain('Declared hosts: not followed for this run.');
  });

  test('the audit context keeps the stored follow state and trail, and omits what was never recorded', async () => {
    const context = (await parseHtml(page(stripeShaped()))).querySelector('[data-web-audit-context]');
    expect(context?.getAttribute('data-follow-declarations')).toBe('true');
    expect(JSON.parse(context?.getAttribute('data-declared-hosts') ?? 'null')).toEqual(STRIPE_TRAIL);
    const old = (await parseHtml(page(preProvenance()))).querySelector('[data-web-audit-context]');
    expect(old?.getAttribute('data-follow-declarations')).toBeNull();
    expect(old?.getAttribute('data-declared-hosts')).toBeNull();
  });
});

describe('trail entries', () => {
  const SITE = 'example.com';
  const DISCOVERY = [
    { source: '/.well-known/mcp/server-card.json', status: 200, shape: 'sep-2127' },
    { source: '/.well-known/mcp.json', status: 200, shape: 'sep-1649' },
    { source: '/mcp', status: 307, redirect: 'https://mcp.redirected.net/mcp' },
  ];
  const entry = (fields: Record<string, unknown>) => ({ kind: 'mcp-endpoint', ...fields });
  const TRAIL = [
    entry({
      surface: '/.well-known/mcp/server-card.json',
      url: 'https://mcp.example.net/mcp',
      host: 'mcp.example.net',
      outcome: 'followed',
      admitted_by: 'card',
    }),
    entry({
      surface: '/.well-known/mcp.json',
      url: 'https://refused.example.net/mcp',
      host: 'refused.example.net',
      outcome: 'reciprocity-refused',
    }),
    entry({
      surface: '/.well-known/ai-catalog.json#/entries/0/data',
      url: 'https://cat.example.net/',
      host: 'cat.example.net',
      outcome: 'followed',
      admitted_by: 'ai-catalog',
    }),
    entry({
      surface: '/mcp',
      url: 'https://mcp.redirected.net/mcp',
      host: 'mcp.redirected.net',
      outcome: 'unreachable',
    }),
    {
      kind: 'card-document',
      surface: '/.well-known/ai-catalog.json#/entries/1',
      url: 'https://cards.example.net/card',
      host: 'cards.example.net',
      outcome: 'blocked',
    },
    entry({
      surface: '/.well-known/ai-catalog.json#/entries/2/data',
      url: 'https://{tenant}.example.org/mcp',
      host: '{tenant}.example.org',
      outcome: 'not-followed',
      reason: 'templated-url',
    }),
    entry({
      surface: '/.well-known/mcp/server-card.json',
      url: 'https://second.example.net/',
      host: 'second.example.net',
      outcome: 'not-followed',
      reason: 'beyond-endpoint-of-record',
    }),
    entry({
      surface: '/mcp',
      url: 'https://anc.dev/token',
      host: 'anc.dev',
      outcome: 'not-followed',
      reason: 'self-path',
    }),
    entry({
      surface: '/.well-known/mcp.json',
      url: 'https://h5.example.net/mcp',
      host: 'h5.example.net',
      outcome: 'budget-exceeded',
      cause: 'per-audit-cap',
    }),
    entry({
      surface: '/.well-known/mcp.json',
      url: 'https://slow.example.net/mcp',
      host: 'slow.example.net',
      outcome: 'budget-exceeded',
      cause: 'slice',
    }),
    entry({
      surface: '/.well-known/mcp.json',
      url: 'https://busy.example.net/mcp',
      host: 'busy.example.net',
      outcome: 'budget-exceeded',
      cause: 'domain-budget',
    }),
    {
      kind: 'api-description',
      surface: '/.well-known/api-catalog#/linkset/0/service-desc/0',
      url: 'https://api.example.net/openapi.json',
      host: 'api.example.net',
      final_url: 'https://docs.example.net/openapi.json',
      outcome: 'followed',
    },
  ];
  const scorecard = () =>
    scorecardOf(SITE, [row('llms-txt', 'pass', at(SITE))], {
      mcp_discovery: DISCOVERY,
      follow_declarations: true,
      declared_hosts: TRAIL,
    });

  async function entries(): Promise<Array<Record<string, string | null>>> {
    const doc = await parseHtml(page(scorecard()));
    const cell = (li: Element, cls: string) => li.querySelector(`.declared-hosts__${cls}`)?.textContent ?? null;
    return [...doc.querySelectorAll('.declared-hosts__entry')].map((li) => ({
      surface: cell(li, 'surface'),
      host: cell(li, 'host'),
      outcome: cell(li, 'outcome'),
      why: cell(li, 'why'),
      attention: li.querySelector('.declared-hosts__outcome--attention') ? 'yes' : null,
    }));
  }

  test('each entry reads its human surface and outcome label', async () => {
    expect(await entries()).toEqual([
      {
        surface: 'server card (remotes[].url)',
        host: 'mcp.example.net',
        outcome: 'evaluated',
        why: 'confirmed by https://mcp.example.net/mcp/server-card',
        attention: null,
      },
      {
        surface: 'server card (transport.url)',
        host: 'refused.example.net',
        outcome: 'not confirmed by refused.example.net',
        why: null,
        attention: 'yes',
      },
      {
        surface: 'ai-catalog entry',
        host: 'cat.example.net',
        outcome: 'evaluated',
        why: "confirmed by cat.example.net's ai-catalog",
        attention: null,
      },
      { surface: 'redirect from /mcp', host: 'mcp.redirected.net', outcome: 'no answer', why: null, attention: 'yes' },
      {
        surface: 'ai-catalog entry',
        host: 'cards.example.net',
        outcome: 'not probed: private or IP address',
        why: null,
        attention: null,
      },
      {
        surface: 'ai-catalog entry',
        host: '{tenant}.example.org',
        outcome: 'not followed: templated URL',
        why: null,
        attention: null,
      },
      {
        surface: 'server card (remotes[].url)',
        host: 'second.example.net',
        outcome: 'not followed: not the endpoint of record',
        why: null,
        attention: null,
      },
      {
        surface: 'redirect from /mcp',
        host: 'anc.dev',
        outcome: 'not followed: self path',
        why: null,
        attention: null,
      },
      {
        surface: 'server card (transport.url)',
        host: 'h5.example.net',
        outcome: 'not probed: more than 4 hosts',
        why: null,
        attention: null,
      },
      {
        surface: 'server card (transport.url)',
        host: 'slow.example.net',
        outcome: 'not probed: time limit',
        why: null,
        attention: null,
      },
      {
        surface: 'server card (transport.url)',
        host: 'busy.example.net',
        outcome: 'not probed: hourly limit, try after 18:00 UTC',
        why: null,
        attention: null,
      },
      {
        surface: 'api-catalog service-desc',
        host: 'api.example.net',
        outcome: 'evaluated',
        why: null,
        attention: null,
      },
    ]);
  });

  test('an anchor with no service description and an entry following skipped read their own not-followed labels', async () => {
    const sc = scorecardOf(SITE, [row('llms-txt', 'pass', at(SITE))], {
      follow_declarations: true,
      declared_hosts: [
        {
          kind: 'api-anchor',
          surface: '/.well-known/api-catalog#/linkset/1',
          url: 'https://status.example.net/',
          host: 'status.example.net',
          outcome: 'not-followed',
          reason: 'no-service-desc',
        },
        entry({
          surface: '/.well-known/mcp.json',
          url: 'https://off.example.net/mcp',
          host: 'off.example.net',
          outcome: 'not-followed',
          reason: 'follow-disabled',
        }),
      ],
    });
    const doc = await parseHtml(page(sc));
    expect(
      [...doc.querySelectorAll('.declared-hosts__entry')].map((li) => [
        li.querySelector('.declared-hosts__host')?.textContent,
        li.querySelector('.declared-hosts__outcome')?.textContent,
      ]),
    ).toEqual([
      ['status.example.net', 'not followed: no service description'],
      ['off.example.net', 'not followed: following off for this audit'],
    ]);
    const md = sectionMd(twin(sc), '## Declared hosts');
    expect(md).toContain('- api-catalog anchor: `status.example.net`, not followed: no service description\n');
    expect(md).toContain(
      '`off.example.net` (`https://off.example.net/mcp`), not followed: following off for this audit\n',
    );
  });

  test('an entry the endpoint host did not confirm names the three URLs anc checked, once, and none reach a prompt', () => {
    const html = page(scorecard());
    const guidance = [...html.matchAll(/<p class="declared-hosts__guidance">(.*?)<\/p>/g)].map((m) => textOf(m[1]));
    expect(guidance).toEqual([
      'To be evaluated, refused.example.net publishes one of these naming https://refused.example.net/mcp: a SEP-2127 server card at https://refused.example.net/mcp/server-card, an entry in https://refused.example.net/.well-known/ai-catalog.json, or RFC 9728 metadata at https://refused.example.net/.well-known/oauth-protected-resource/mcp.',
    ]);
    for (const carrier of html.matchAll(/data-copy-text="([^"]*)"/g)) expect(carrier[1]).not.toContain('refused');
    expect(twin(scorecard())).toContain(
      '  To be evaluated, refused.example.net publishes one of these naming `https://refused.example.net/mcp`: a SEP-2127 server card at `https://refused.example.net/mcp/server-card`, an entry in `https://refused.example.net/.well-known/ai-catalog.json`, or RFC 9728 metadata at `https://refused.example.net/.well-known/oauth-protected-resource/mcp`.',
    );
  });

  test('a redirected entry shows where it led, a root URL shows only its host, and only the page breaks at boundaries', () => {
    const html = page(scorecard());
    expect(textOf(html)).toContain('redirected to https://docs.example.net/openapi.json');
    expect(html).toContain('<code>mcp.<wbr>example.<wbr>net</code>');
    expect(html).not.toContain('<code>https:/<wbr>/<wbr>cat.<wbr>example.<wbr>net/<wbr></code>');
    const md = twin(scorecard());
    expect(md).not.toContain('<wbr>');
    expect(md).toContain(
      '- api-catalog service-desc: `api.example.net` (`https://api.example.net/openapi.json`), redirected to `https://docs.example.net/openapi.json`, evaluated',
    );
  });

  test('the scorecard JSON and the audit context keep the machine values', async () => {
    const context = (await parseHtml(page(scorecard()))).querySelector('[data-web-audit-context]');
    expect(JSON.parse(context?.getAttribute('data-declared-hosts') ?? 'null')).toEqual(TRAIL);
    expect(scorecard().declared_hosts).toEqual(TRAIL);
  });

  test('an evaluated API anchor reads "OpenAPI description found" only when its description was read', () => {
    const md = twin(stripeShaped());
    expect(md).toContain('- api-catalog anchor: `api.stripe.com`, evaluated, OpenAPI description found');
    const missing = stripeShaped();
    missing.results = missing.results.map((r) =>
      r.id === 'openapi' ? { ...r, status: 'absent', evidence: 'spec3.json -> 404' } : r,
    );
    expect(twin(missing)).toContain('- api-catalog anchor: `api.stripe.com`, evaluated\n');
  });

  test('declared URLs and surfaces carrying markup render escaped on the page and inside code spans in the twin', () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const sc = scorecardOf(SITE, [row('llms-txt', 'pass', at(SITE))], {
      follow_declarations: true,
      declared_hosts: [
        entry({
          surface: `/x${hostile}`,
          url: `https://{tenant}.example.org/${hostile}`,
          host: '{tenant}.example.org',
          outcome: 'not-followed',
          reason: 'templated-url',
        }),
        entry({ surface: '/y', url: 'https://ok.example.net/', host: hostile, outcome: 'reciprocity-refused' }),
      ],
    });
    const html = page(sc);
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    const md = twin(sc);
    expect(md).toContain(`(\`https://{tenant}.example.org/${hostile}\`)`);
    // Outside a code span, a markup opener is backslash-escaped, so a renderer prints it as text.
    expect(md.replaceAll(/`[^`]*`/g, '')).not.toMatch(/(^|[^\\])<img/);
    expect(md).toContain('not confirmed by \\<img');
  });
});

describe('where the evidence came from, on categories and rows', () => {
  test('a category whose evaluated rows reached one other host names it and what declared it', () => {
    const html = page(stripeShaped());
    expect(textOf(categoryHtml(html, 'api'))).toContain(
      "Evaluated at api.stripe.com, declared by stripe.dev's api-catalog anchor",
    );
    expect(textOf(categoryHtml(html, 'mcp'))).toContain(
      "Evaluated at mcp.stripe.com, declared by stripe.dev's server card (transport.url)",
    );
    expect(categoryHtml(html, 'api')).toContain(
      '<p class="pscore__evidence pscore__evidence--host">Evaluated at <code>api.stripe.com</code>, declared by',
    );
    const md = twin(stripeShaped());
    expect(sectionMd(md, '## API')).toContain(
      "\nEvaluated at `api.stripe.com`, declared by stripe.dev's api-catalog anchor.\n",
    );
  });

  test('a row evaluated anywhere else carries a host note under its label, never inside its summary', () => {
    const html = page(stripeShaped());
    const card = html.slice(
      html.indexOf('data-id="api-catalog"'),
      html.indexOf('</details>', html.indexOf('data-id="api-catalog"')),
    );
    expect(card).toContain('</summary>\n      <p class="web-check__note">Evaluated at <code>stripe.dev</code></p>');
    expect(card.slice(0, card.indexOf('</summary>'))).not.toContain('Evaluated at');
    const openapi = html.slice(
      html.indexOf('data-id="openapi"'),
      html.indexOf('</details>', html.indexOf('data-id="openapi"')),
    );
    expect(openapi).not.toContain('web-check__note');
    const md = sectionMd(twin(stripeShaped()), '## API');
    expect(md.match(/^- Host: .*$/gm)).toEqual(['- Host: `stripe.dev`']);
  });

  test('every row carries the host it reads as evaluated at', async () => {
    const doc = await parseHtml(page(stripeShaped()));
    const hosts = Object.fromEntries(
      [...doc.querySelectorAll('.web-check[data-id]')].map((el) => [
        el.getAttribute('data-id'),
        el.getAttribute('data-host'),
      ]),
    );
    expect(hosts).toMatchObject({
      openapi: 'api.stripe.com',
      'json-schemas': 'stripe.dev',
      'api-catalog': 'stripe.dev',
      'mcp-initialize': 'mcp.stripe.com',
    });
  });

  test('a row over two hosts lists each host with its own outcome on the page and the twin', () => {
    const html = page(twoAnchorShaped());
    const line =
      'Present but broken (https://files.example.net/x -> 404 (HTML)); api.example.net: pass, files.example.net: broken';
    expect(textOf(html)).toContain(`Result: ${line}`);
    expect(html).toContain('data-host="api.example.net files.example.net"');
    expect(twin(twoAnchorShaped())).toContain(`- Result: ${line}`);
    expect(html).not.toContain('Evaluated at');
  });

  test('a scorecard stored before provenance shows no host phrase anywhere', () => {
    const html = page(preProvenance());
    expect(html).not.toContain('Evaluated at');
    expect(html).not.toContain('web-check__note');
    expect(html).not.toContain('declared-hosts__entry');
    expect(html).toContain('Declared hosts: not recorded for this audit.');
    expect(html).not.toContain('including');
    const md = twin(preProvenance());
    expect(md).not.toContain('Host:');
    expect(md).not.toContain('Evaluated at');
    expect(md).toContain('Declared hosts: not recorded for this audit.');
  });
});

describe('the score note and closing note', () => {
  test('a result that evaluated declared hosts says how many and links the section; a single-origin one reads as before', () => {
    const html = page(stripeShaped());
    expect(html).toContain(
      '<p class="result-score__note">relative to the checks that apply to this site, including 2 hosts it declares (see <a href="#declared-hosts">Declared hosts</a>); global measures it',
    );
    expect(html).toContain(
      "This scorecard reflects the target's public agent-facing surface and the hosts it declares at audit time.",
    );
    const md = twin(stripeShaped());
    expect(md).toContain(
      '**Score:** 70% (relative to the checks that apply to this site, including 2 hosts it declares (see Declared hosts))',
    );
    expect(md).toContain(
      "This scorecard reflects the target's public agent-facing surface and the hosts it declares at audit time.",
    );

    const single = { ...stripeShaped(), declared_hosts: [] };
    const singleHtml = page(single);
    expect(singleHtml).toContain(
      '<p class="result-score__note">relative to the checks that apply to this site; global measures it',
    );
    expect(singleHtml).toContain("This scorecard reflects the target's public agent-facing surface at audit time.");
    const singleMd = twin(single);
    expect(singleMd).toContain('**Score:** 70% (relative to the checks that apply to this site)');
    expect(singleMd).not.toContain('and the hosts it declares');
  });
});

describe('rows the audit could not run', () => {
  test('a category counts them beside its pass rollup; optional rows that are absent are not among them', () => {
    const html = page(stripeShaped());
    expect(categoryHtml(html, 'mcp')).toContain(
      '<span class="audit-group__rollup band-high">6 / 6</span> checks pass · 18 not run</p>',
    );
    expect(categoryHtml(html, 'api')).toContain('checks pass</p>');
    expect(twin(stripeShaped())).toContain('\n## MCP (6/6, 18 not run)\n');
    const lanes = [...html.matchAll(/<span class="web-lane__count">([^<]*)<\/span>/g)].map((m) => m[1]);
    expect(lanes).toEqual(['6 / 6 pass · 1 not run', '10 not run', '7 not run']);
  });

  test('a stripe-shaped MCP category groups 10 rows in the legacy lane, 7 in the modern lane, and leaves 1 ungrouped', () => {
    const html = page(stripeShaped());
    const lane = (id: string) =>
      html.slice(
        html.indexOf(`data-mcp-lane="${id}"`),
        html.indexOf('<div class="web-lane"', html.indexOf(`data-mcp-lane="${id}"`) + 1),
      );
    const groups = (block: string) =>
      [
        ...block.matchAll(
          /<details class="web-check web-check--n_a web-check--group">\s*<summary aria-label="([^"]+)">/g,
        ),
      ].map((m) => m[1]);
    expect(groups(lane('legacy'))).toEqual(['10 checks not run, mcp.stripe.com requires sign-in']);
    expect(groups(lane('modern'))).toEqual(['7 checks not run, mcp.stripe.com requires sign-in']);
    expect(groups(lane('shared'))).toEqual([]);
    expect(lane('legacy')).toContain(
      '<span class="web-check__label">10 checks not run: mcp.stripe.com requires sign-in</span>',
    );
    expect(lane('shared')).toContain('data-id="mcp-cors-actual"');
  });

  test('a category without lanes groups its 18 rows once, and every reader still finds all 18', async () => {
    const html = page(stripeShaped(), { lanes: false });
    const mcp = categoryHtml(html, 'mcp');
    expect(mcp.match(/web-check--group/g)).toHaveLength(1);
    expect(mcp).toContain('<summary aria-label="18 checks not run, mcp.stripe.com requires sign-in">');
    expect(mcp).not.toMatch(/web-check--group"[^>]*open/);
    const doc = await parseHtml(html);
    const rows = findingRowsFromElements(doc.querySelectorAll('.web-check[data-id]'));
    const signIn = rows.filter((r) => r.result?.includes('requires sign-in'));
    expect(signIn).toHaveLength(18);
    const worksheet = JSON.parse(getWorksheet(doc, { statuses: ['n_a'], limit: 25 }));
    expect(worksheet.total).toBe(rows.filter((r) => r.status === 'n_a').length);
    const context = doc.querySelector('[data-web-audit-context]');
    expect(Number(context?.getAttribute('data-count-n_a'))).toBe(rows.filter((r) => r.status === 'n_a').length);
    const md = twin(stripeShaped(), { lanes: false });
    expect(md.match(/^### N\/A — /gm)?.length).toBe(rows.filter((r) => r.status === 'n_a').length);
    expect(md).toContain('\n18 checks not run: mcp.stripe.com requires sign-in. ');
  });

  test('two rows sharing a reason render ungrouped, each with its own remedy', () => {
    const sc = scorecardOf('stripe.dev', [
      row('mcp-initialize', 'n_a', { na_reason: 'auth-required', ...at('mcp.stripe.com') }),
      row('mcp-tools-list', 'n_a', { na_reason: 'auth-required', ...at('mcp.stripe.com') }),
      row('mcp-get-fast-fail', 'pass', at('mcp.stripe.com')),
    ]);
    const html = page(sc, { lanes: false });
    expect(html).not.toContain('web-check--group');
    expect(html.match(/<p class="web-check__note">anc&#39;s public audit holds no sign-in/g)).toHaveLength(2);
    expect(twin(sc, { lanes: false })).not.toContain('checks not run');
  });

  test('rows sharing a reason at two hosts group per host: three at one host collapse, two at the other stay rows', () => {
    const signIn = (id: string, host: string) => row(id, 'n_a', { na_reason: 'auth-required', ...at(host) });
    const sc = scorecardOf('example.com', [
      signIn('mcp-initialize', 'mcp.example.net'),
      signIn('mcp-capabilities', 'mcp.example.org'),
      signIn('mcp-tools-list', 'mcp.example.net'),
      signIn('mcp-resources-list', 'mcp.example.org'),
      signIn('mcp-unknown-method', 'mcp.example.net'),
      row('mcp-get-fast-fail', 'pass', at('mcp.example.net')),
    ]);
    const mcp = categoryHtml(page(sc, { lanes: false }), 'mcp');
    const groups = [
      ...mcp.matchAll(/<details class="web-check web-check--n_a web-check--group">\s*<summary aria-label="([^"]+)">/g),
    ];
    expect(groups.map((m) => m[1])).toEqual(['3 checks not run, mcp.example.net requires sign-in']);
    const nested = mcp.slice(
      mcp.indexOf('<div class="web-check__group">'),
      mcp.indexOf('</div>', mcp.indexOf('<div class="web-check__group">')),
    );
    expect([...nested.matchAll(/data-id="([^"]+)"/g)].map((m) => m[1])).toEqual([
      'mcp-initialize',
      'mcp-tools-list',
      'mcp-unknown-method',
    ]);
    expect(
      mcp.match(/<p class="web-check__note">anc&#39;s public audit holds no sign-in for mcp\.example\.org/g),
    ).toHaveLength(2);
    const md = twin(sc, { lanes: false });
    expect(md).toContain('\n3 checks not run: mcp.example.net requires sign-in. ');
    expect(md).not.toContain('checks not run: mcp.example.org');
  });

  test('a group opens with why the public audit could not run its rows', () => {
    const html = page(stripeShaped());
    const group = html.slice(html.indexOf('web-check--group'), html.indexOf('<div class="web-check__group">'));
    expect(textOf(group)).toContain("anc's public audit holds no sign-in for mcp.stripe.com.");
    expect(group).not.toContain('anc web');
    const nested = html.slice(
      html.indexOf('<div class="web-check__group">'),
      html.indexOf('</div>', html.indexOf('<div class="web-check__group">')),
    );
    expect(nested).not.toContain('web-check__note');
  });

  test('a reason other than sign-in names its own cause and no token', () => {
    const sc = scorecardOf('example.com', [
      row('mcp-initialize', 'n_a', { na_reason: 'reciprocity-refused', ...at('mcp.example.net') }),
    ]);
    expect(textOf(page(sc, { lanes: false }))).toContain(
      "anc's public audit probes mcp.example.net only after mcp.example.net confirms this endpoint.",
    );
    expect(page(sc)).not.toContain('ANC_WEB_TOKEN');
  });

  test('the score note says global keeps those rows in its maximum, on the page and the twin', () => {
    const sentence = 'Global keeps the 18 checks this audit could not run in its maximum.';
    expect(textOf(page(stripeShaped()))).toContain(sentence);
    expect(twin(stripeShaped())).toContain(`\n${sentence}\n`);
    const single = scorecardOf('example.com', [row('llms-txt', 'pass', at('example.com'))]);
    expect(page(single)).not.toContain('Global keeps');
  });

  test('an empty category whose rows the audit could not run gives that reason and points at Declared hosts', () => {
    const refused = scorecardOf('example.com', [
      row('mcp-initialize', 'n_a', { na_reason: 'reciprocity-refused', ...at('mcp.example.net') }),
      row('mcp-get-fast-fail', 'n_a', { na_reason: 'reciprocity-refused', ...at('mcp.example.net') }),
      row('webmcp', 'n_a', { na_reason: 'optional-absent', ...at('example.com') }),
    ]);
    expect(page(refused)).toContain(
      '<p class="audit-group__note">Not evaluated: mcp.example.net did not confirm this endpoint. See <a href="#declared-hosts">Declared hosts</a>.</p>',
    );
    expect(twin(refused)).toContain(
      '\nNot evaluated: mcp.example.net did not confirm this endpoint. See Declared hosts.\n',
    );
    const unmet = scorecardOf('example.com', [
      row('mcp-initialize', 'n_a', { na_reason: 'antecedent-unmet' }),
      row('mcp-get-fast-fail', 'n_a', { na_reason: 'antecedent-unmet' }),
    ]);
    expect(page(unmet)).toContain('<p class="audit-group__note">No checks in this category apply to this site.</p>');
    expect(twin(unmet)).toContain('\nNo checks in this category apply to this site.\n');
  });
});

describe('a host carrying a backtick, which the URL parser accepts', () => {
  const HOST = 'a`b.example.com';
  const scorecard = () =>
    scorecardOf(
      'example.com',
      [
        row('openapi', 'pass', { evidence: 'https://api.example.net/openapi.json -> 200', ...at('api.example.net') }),
        row('rate-limit-headers', 'absent', { evidence: 'no rate-limit header', ...at(HOST) }),
        row('json-errors', 'n_a', { na_reason: 'auth-required', evidence: `https://${HOST}/`, ...at(HOST) }),
      ],
      {
        follow_declarations: true,
        declared_hosts: [
          {
            kind: 'api-anchor',
            surface: '/.well-known/api-catalog#/linkset/0',
            url: `https://${HOST}/v1`,
            host: HOST,
            outcome: 'reciprocity-refused',
          },
        ],
      },
    );
  const REMEDY = "anc's public audit holds no sign-in for a\\`b.example.com.";

  test('the twin widens the code span around it and escapes it in prose, so no span closes early', () => {
    expect(new URL(`https://${HOST}/`).host).toBe(HOST);
    const md = twin(scorecard());
    expect(md).toContain('- Host: `` a`b.example.com ``\n');
    expect(sectionMd(md, '## Declared hosts')).toContain(
      '- api-catalog anchor: `` a`b.example.com `` (`` https://a`b.example.com/v1 ``), not confirmed by a\\`b.example.com',
    );
    expect(md).toContain(`- Note: ${REMEDY}\n`);
  });

  test('the MCP read carries the same escaped remedy as access_remedy', () => {
    const read = enrichWebScorecardForDisplay(scorecard(), {
      registry: REGISTRY,
      catalog: REMEDIATION,
      origin: 'https://anc.dev',
    }) as { results: Array<{ id: string; access_remedy?: string }> };
    expect(read.results.find((r) => r.id === 'json-errors')?.access_remedy).toBe(REMEDY);
  });
});
