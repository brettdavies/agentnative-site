// Worker entry routing for the progress page: /scoring and its twin are
// rendered by the Worker ahead of the asset fetch, so neither can fall
// through to the asset 404 or be served as a stored page.

import { beforeEach, describe, expect, test } from 'bun:test';
import worker, { type Env } from '../src/worker/index';
import { _resetShellTemplateCache } from '../src/worker/shell-template';

const SHELL_TEMPLATE = `<!doctype html>
<html><head><title>{{TITLE}}</title></head>
<body>{{BODY}}</body></html>`;

function makeEnv(): Env {
  return {
    ASSETS: {
      async fetch(req: Request | string) {
        const path = new URL(typeof req === 'string' ? req : req.url).pathname;
        if (path === '/_internal/score-live-shell.html') return new Response(SHELL_TEMPLATE, { status: 200 });
        return new Response('asset not found', { status: 404, headers: { 'content-type': 'text/plain' } });
      },
    } as unknown as Fetcher,
    TURNSTILE_SITEKEY: '1x00000000000000000000AA',
  };
}

function makeCtx(): ExecutionContext {
  return { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
}

function get(path: string, accept = 'text/html'): Request {
  return new Request(`https://anc.dev${path}`, { headers: { accept } });
}

beforeEach(() => {
  _resetShellTemplateCache();
});

describe('Worker routing: /scoring', () => {
  test('/scoring?target= reaches the progress page, not the asset 404', async () => {
    const res = await worker.fetch(get('/scoring?target=ripgrep'), makeEnv(), makeCtx());
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const html = await res.text();
    expect(html).toContain('data-scoring');
    expect(html).toContain('data-target="ripgrep"');
  });

  test('/scoring.md reaches the prose pointer', async () => {
    const res = await worker.fetch(get('/scoring.md?target=ripgrep', 'text/markdown'), makeEnv(), makeCtx());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/markdown');
    expect(await res.text()).toContain('get_scorecard');
  });
});
