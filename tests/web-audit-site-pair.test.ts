// Pair resolution is the engine's first step: the audited host's root and its
// www or bare sibling's root decide whether the two hosts are one site, which
// host the checks probe, and what the site is named. Every scenario runs the
// whole engine over a stub fetch and reads the scorecard, the pair report on
// the terminal event, and the requests that reached the wire.

import { describe, expect, test } from 'bun:test';
import { loadRegistry } from '../scripts/web-audit/conformance-corpus';
import { type AuditEvent, runWebAudit } from '../src/worker/audit-web/engine';
import { ALWAYS_ADMIT_BUDGET, type DomainBudget } from '../src/worker/audit-web/follow-requests';
import { stubFetch } from './helpers/stub-fetch';

const registry = loadRegistry();

const HTML = '<html><head><meta name="description" content="x"></head><body><main>hi</main></body></html>';
const html = (): Response => new Response(HTML, { status: 200, headers: { 'content-type': 'text/html' } });
const status = (code: number): Response => new Response('', { status: code });
const redirect = (location: string, code = 301): Response => new Response('', { status: code, headers: { location } });

type Route = () => Response | Promise<Response>;

const ABORTED = (): DOMException => new DOMException('aborted', 'AbortError');

/** Never answers; rejects as an aborted fetch does. */
const stall = (): Route => () => new Promise<Response>(() => {});

function world(routes: Record<string, Route>) {
  const wire: string[] = [];
  const fetchImpl = stubFetch((url, init) => {
    const names = Object.keys((init?.headers as Record<string, string> | undefined) ?? {}).map((n) => n.toLowerCase());
    const plain = names.length === 1 && names[0] === 'user-agent';
    wire.push(`${init?.method ?? 'GET'} ${url}${plain ? '' : ` [${names.join(',')}]`}`);
    const route = routes[url] ?? routes[`${new URL(url).origin}/*`];
    if (route === undefined) return new Response('not found', { status: 404 });
    const answer = route();
    if (answer instanceof Promise) {
      return new Promise<Response>((resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(ABORTED()), { once: true });
        void answer.then(resolve, reject);
      });
    }
    return answer;
  });
  return { fetchImpl, wire };
}

const failing = (): Route => () => {
  throw new TypeError('network connection lost');
};

async function run(
  host: string,
  routes: Record<string, Route>,
  opts: { follow?: boolean; budget?: DomainBudget; perCheckTimeoutMs?: number } = {},
) {
  const { fetchImpl, wire } = world(routes);
  const events: AuditEvent[] = [];
  const started = Date.now();
  let firstEventMs = 0;
  for await (const event of runWebAudit({
    url: `https://${host}/`,
    registry,
    followDeclarations: opts.follow,
    domainBudget: opts.budget ?? ALWAYS_ADMIT_BUDGET,
    perCheckTimeoutMs: opts.perCheckTimeoutMs,
    fetchOptions: { fetchImpl },
  })) {
    if (events.length === 0) firstEventMs = Date.now() - started;
    events.push(event);
  }
  const terminal = events.at(-1);
  const complete = terminal?.type === 'complete' ? terminal : undefined;
  const unreachable = terminal?.type === 'unreachable' ? terminal : undefined;
  return { events, wire, terminal, complete, unreachable, firstEventMs };
}

const onWire = (wire: string[], url: string): number => wire.filter((line) => line === `GET ${url}`).length;

describe('a redirect between the two roots folds the pair', () => {
  test('a bare host redirecting to www is one site named by the bare host, probed at www', async () => {
    const { complete, wire } = await run('n.test', {
      'https://n.test/': () => redirect('https://www.n.test/'),
      'https://www.n.test/': html,
    });
    expect(complete?.scorecard.tool.name).toBe('n.test');
    expect(complete?.scorecard.target_url).toBe('https://www.n.test/');
    expect(complete?.pair?.outcome).toBe('folded');
    expect(onWire(wire, 'https://n.test/')).toBe(1);
    expect(onWire(wire, 'https://www.n.test/')).toBe(1);
  });

  test('a www host redirecting to the bare host is one site named by the bare host, probed at the bare host', async () => {
    const { complete, wire } = await run('www.n.test', {
      'https://www.n.test/': () => redirect('https://n.test/'),
      'https://n.test/': html,
    });
    expect(complete?.scorecard.tool.name).toBe('n.test');
    expect(complete?.scorecard.target_url).toBe('https://n.test/');
    expect(complete?.pair?.outcome).toBe('folded');
    expect(onWire(wire, 'https://www.n.test/')).toBe(1);
    expect(onWire(wire, 'https://n.test/')).toBe(1);
  });

  test('a sibling that redirects to the audited host folds even when the audited root answers 200', async () => {
    const { complete } = await run('n.test', {
      'https://n.test/': html,
      'https://www.n.test/': () => redirect('https://n.test/'),
    });
    expect(complete?.scorecard.tool.name).toBe('n.test');
    expect(complete?.scorecard.target_url).toBe('https://n.test/');
    expect(complete?.pair?.outcome).toBe('folded');
  });

  test('a first hop that lands on a path of the sibling folds and probes the sibling origin', async () => {
    const { complete } = await run('n.test', {
      'https://n.test/': () => redirect('https://www.n.test/en-us/'),
      'https://www.n.test/en-us/': html,
    });
    expect(complete?.scorecard.target_url).toBe('https://www.n.test/');
    expect(complete?.pair?.outcome).toBe('folded');
  });

  test('a temporary redirect folds like a permanent one', async () => {
    const { complete } = await run('n.test', {
      'https://n.test/': () => redirect('https://www.n.test/', 307),
      'https://www.n.test/': html,
    });
    expect(complete?.pair?.outcome).toBe('folded');
  });

  test('a fold from www followed on to a third host keeps the third host as the root response', async () => {
    const { complete, wire } = await run('www.n.test', {
      'https://www.n.test/': () => redirect('https://n.test/'),
      'https://n.test/': () => redirect('https://third.test/'),
      'https://third.test/': html,
    });
    expect(complete?.scorecard.tool.name).toBe('n.test');
    expect(complete?.scorecard.target_url).toBe('https://n.test/');
    expect(complete?.pair?.outcome).toBe('folded');
    expect(onWire(wire, 'https://third.test/')).toBeGreaterThanOrEqual(1);
    const metaRow = complete?.scorecard.results.find((row) => row.id === 'root-meta-description');
    expect(metaRow?.status).toBe('pass');
  });

  test('the fold reaches the DNS-AID check as the bare host', async () => {
    const { wire } = await run('n.test', {
      'https://n.test/': () => redirect('https://www.n.test/'),
      'https://www.n.test/': html,
    });
    expect(wire.some((line) => line.includes('name=_index._agents.n.test'))).toBe(true);
    expect(wire.some((line) => line.includes('name=_index._agents.www.n.test'))).toBe(false);
  });

  test('a redirect to the sibling over http is refused as plaintext and folds nothing', async () => {
    const { unreachable, wire } = await run('n.test', {
      'https://n.test/': () => redirect('http://www.n.test/'),
      'https://www.n.test/': html,
    });
    expect(unreachable?.reason).toContain('redirects to http');
    expect(unreachable?.pair).toBeUndefined();
    expect(wire.some((line) => line.startsWith('GET http://'))).toBe(false);
  });
});

describe('only an https redirect folds', () => {
  test('a sibling redirecting to the audited host over http is not a fold', async () => {
    const { complete } = await run('n.test', {
      'https://n.test/': html,
      'https://www.n.test/': () => redirect('http://n.test/'),
    });
    expect(complete?.pair?.outcome).toBe('unfolded');
    expect(complete?.scorecard.target_url).toBe('https://n.test/');
  });
});

describe('without a redirect between them the two hosts stay separate sites', () => {
  test('a redirect to a third host is not a fold, and the sibling answering 404 leaves the pair unfolded', async () => {
    const { complete } = await run('n.test', {
      'https://n.test/': () => redirect('https://third.test/'),
      'https://third.test/': html,
      'https://www.n.test/': () => status(404),
    });
    expect(complete?.scorecard.tool.name).toBe('n.test');
    expect(complete?.pair?.outcome).toBe('unfolded');
  });

  test('both roots answering 200 is unfolded and the name is the audited host', async () => {
    const asApex = await run('n.test', { 'https://n.test/': html, 'https://www.n.test/': html });
    expect(asApex.complete?.scorecard.tool.name).toBe('n.test');
    expect(asApex.complete?.scorecard.target_url).toBe('https://n.test/');
    expect(asApex.complete?.pair?.outcome).toBe('unfolded');

    const asWww = await run('www.n.test', { 'https://n.test/': html, 'https://www.n.test/': html });
    expect(asWww.complete?.scorecard.tool.name).toBe('www.n.test');
    expect(asWww.complete?.scorecard.target_url).toBe('https://www.n.test/');
    expect(asWww.complete?.pair?.outcome).toBe('unfolded');
  });

  test('a bare host answering 200 while the sibling answers 404 is unfolded', async () => {
    const { complete } = await run('n.test', { 'https://n.test/': html, 'https://www.n.test/': () => status(404) });
    expect(complete?.pair?.outcome).toBe('unfolded');
  });

  test('a www host answering 200 while the bare host is unreachable is its own site', async () => {
    const { complete } = await run('www.n.test', { 'https://www.n.test/': html, 'https://n.test/': failing() });
    expect(complete?.scorecard.tool.name).toBe('www.n.test');
    expect(complete?.scorecard.target_url).toBe('https://www.n.test/');
    expect(complete?.pair?.outcome).toBe('no-answer');
  });

  test('a host with no pair is audited alone and requests no sibling', async () => {
    const { complete, wire } = await run('203.0.113.7', { 'https://203.0.113.7/': html });
    expect(complete?.scorecard.tool.name).toBe('203.0.113.7');
    expect(complete?.pair).toBeUndefined();
    expect(wire.some((line) => line.includes('www.'))).toBe(false);
  });
});

describe('a sibling that gives no answer is not read as a missing redirect', () => {
  for (const [label, sibling] of [
    ['a 503', () => status(503)],
    ['a 429', () => status(429)],
    ['a transport failure', failing()],
  ] as const) {
    test(`a bare host answering 200 while the sibling gives ${label} reports no answer`, async () => {
      const { complete } = await run('n.test', { 'https://n.test/': html, 'https://www.n.test/': sibling });
      expect(complete?.pair?.outcome).toBe('no-answer');
      expect(complete?.scorecard.tool.name).toBe('n.test');
      expect(complete?.scorecard.target_url).toBe('https://n.test/');
    });
  }

  test('an audited root answering 429 while the sibling answers 200 reports no answer', async () => {
    const { complete } = await run('n.test', { 'https://n.test/': () => status(429), 'https://www.n.test/': html });
    expect(complete?.pair?.outcome).toBe('no-answer');
  });

  test('the pair report carries the first-hop status of each root', async () => {
    const folded = await run('n.test', {
      'https://n.test/': () => redirect('https://www.n.test/', 308),
      'https://www.n.test/': html,
    });
    expect(folded.complete?.pair).toEqual({ outcome: 'folded', requestedStatus: 308, siblingStatus: 200 });

    const silent = await run('n.test', { 'https://n.test/': html, 'https://www.n.test/': () => status(503) });
    expect(silent.complete?.pair).toEqual({ outcome: 'no-answer', requestedStatus: 200, siblingStatus: 503 });
  });
});

describe('the sibling request is bounded', () => {
  test('a first hop that lands on the sibling decides the fold without waiting for the sibling root', async () => {
    const { complete, firstEventMs } = await run(
      'n.test',
      {
        'https://n.test/': () => redirect('https://www.n.test/en-us/'),
        'https://www.n.test/en-us/': html,
        'https://www.n.test/': stall(),
      },
      { perCheckTimeoutMs: 300 },
    );
    expect(complete?.pair?.outcome).toBe('folded');
    expect(firstEventMs).toBeLessThan(1_500);
  }, 10_000);

  test('a sibling that stalls past the bound counts as not answering and the pair step ends at the bound', async () => {
    const { complete, firstEventMs } = await run('n.test', {
      'https://n.test/': html,
      'https://www.n.test/': stall(),
    });
    expect(complete?.pair?.outcome).toBe('no-answer');
    expect(complete?.pair?.siblingStatus).toBeNull();
    expect(firstEventMs).toBeGreaterThanOrEqual(1_900);
    expect(firstEventMs).toBeLessThan(4_000);
  }, 15_000);
});

describe('an audited host that does not answer', () => {
  test('names the sibling that answered, in the reason', async () => {
    const { unreachable } = await run('n.test', { 'https://n.test/*': failing(), 'https://www.n.test/': html });
    expect(unreachable?.reason.endsWith('www.n.test answered; audit https://www.n.test/ instead.')).toBe(true);
    expect(unreachable?.sibling).toBe('https://www.n.test/');
    expect(unreachable?.pair?.outcome).toBe('no-answer');
  });

  test('a 530 from the audited host reads the same way', async () => {
    const { unreachable } = await run('n.test', {
      'https://n.test/*': () => status(530),
      'https://www.n.test/': html,
    });
    expect(unreachable?.reason.endsWith('www.n.test answered; audit https://www.n.test/ instead.')).toBe(true);
  });

  test('the sibling is named from the www side as well', async () => {
    const { unreachable } = await run('www.n.test', { 'https://www.n.test/*': failing(), 'https://n.test/': html });
    expect(unreachable?.reason.endsWith('n.test answered; audit https://n.test/ instead.')).toBe(true);
  });

  test('keeps the current wording when the sibling fails too', async () => {
    const { unreachable } = await run('n.test', {
      'https://n.test/*': failing(),
      'https://www.n.test/*': failing(),
    });
    expect(unreachable?.reason).toBeDefined();
    expect(unreachable?.reason).not.toContain('answered; audit');
    expect(unreachable?.sibling).toBeUndefined();
  });

  test('a sibling that answers 503 is not named', async () => {
    const { unreachable } = await run('n.test', {
      'https://n.test/*': failing(),
      'https://www.n.test/*': () => status(503),
    });
    expect(unreachable?.reason).toBeDefined();
    expect(unreachable?.reason).not.toContain('answered; audit');
  });
});

describe('the pair resolution is not following', () => {
  test('a folding pair still folds with following off and draws no domain-budget unit for the sibling', async () => {
    const reserved: string[] = [];
    const budget: DomainBudget = {
      reserve: async (domain: string) => {
        reserved.push(domain);
        return { ok: true as const };
      },
    } as unknown as DomainBudget;
    const { complete } = await run(
      'n.test',
      { 'https://n.test/': () => redirect('https://www.n.test/'), 'https://www.n.test/': html },
      { follow: false, budget },
    );
    expect(complete?.pair?.outcome).toBe('folded');
    expect(reserved).toEqual([]);
  });
});
