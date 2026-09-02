// Vary contract for the /api/score endpoints. Extensionless /api/score
// negotiates JSON vs markdown by Accept alone (detectScorePreference
// never reads User-Agent), so it carries `Vary: Accept` on every
// freshness class; the suffix-pinned twins are one representation each
// and carry none. The drift canaries assert the suffix dispatch agrees
// with the shared pinned-representation predicate instead of pinning a
// second path list that could rot independently.

import { beforeEach, describe, expect, test } from 'bun:test';
import { isRepresentationPinned } from '../src/worker/headers';
import { keyFor } from '../src/worker/score/cache';
import { preferenceFor } from '../src/worker/score/content-negotiation';
import { _resetIndexCache, handleScore } from '../src/worker/score/handler';
import { _resetKillSwitchCache } from '../src/worker/score/kill-switch';
import { ANC_VERSION, SPEC_VERSION } from '../src/worker/spec-version.gen';
import { makeEnv, postScore } from './score-handler.test';

const CACHE_KEY_UNCURATED = keyFor('uncurated-tool', SPEC_VERSION);

const CACHED_UNCURATED_PAYLOAD = {
  spec_version: SPEC_VERSION,
  anc_version: ANC_VERSION,
  tool_version: '3.04',
  scorecard: { tool: { name: 'uncurated-tool', binary: 'uncurated-tool', version: '3.04' }, score: { value: 92 } },
};

beforeEach(() => {
  _resetIndexCache();
  _resetKillSwitchCache();
});

describe('/api/score — Vary matrix', () => {
  const liveDo = {
    doResponse: {
      scorecard: { tool: { name: 'uncurated-tool', version: '3.04' } },
      anc_version: ANC_VERSION,
    },
  };

  test('live extensionless JSON carries Vary: Accept', async () => {
    const res = await handleScore(postScore('cargo binstall uncurated-tool'), makeEnv(liveDo));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('application/json');
    expect(res.headers.get('Vary')).toBe('Accept');
  });

  test('live extensionless markdown variant carries Vary: Accept', async () => {
    const res = await handleScore(
      postScore('cargo binstall uncurated-tool', { accept: 'text/markdown' }),
      makeEnv(liveDo),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/markdown');
    expect(res.headers.get('Vary')).toBe('Accept');
  });

  test('live /api/score.json carries no Vary', async () => {
    const res = await handleScore(postScore('cargo binstall uncurated-tool', { pathSuffix: '.json' }), makeEnv(liveDo));
    expect(res.status).toBe(200);
    expect(res.headers.get('Vary')).toBeNull();
  });

  test('live /api/score.md carries no Vary', async () => {
    const res = await handleScore(postScore('cargo binstall uncurated-tool', { pathSuffix: '.md' }), makeEnv(liveDo));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/markdown');
    expect(res.headers.get('Vary')).toBeNull();
  });

  test('cache-hit /api/score.json carries no Vary', async () => {
    const env = makeEnv({ cacheContent: { [CACHE_KEY_UNCURATED]: CACHED_UNCURATED_PAYLOAD } });
    const res = await handleScore(postScore('cargo binstall uncurated-tool', { pathSuffix: '.json' }), env);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=300');
    expect(res.headers.get('Vary')).toBeNull();
  });

  test('cache-hit /api/score.md carries no Vary', async () => {
    const env = makeEnv({ cacheContent: { [CACHE_KEY_UNCURATED]: CACHED_UNCURATED_PAYLOAD } });
    const res = await handleScore(postScore('cargo binstall uncurated-tool', { pathSuffix: '.md' }), env);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/markdown');
    expect(res.headers.get('Vary')).toBeNull();
  });

  test('cache-hit extensionless markdown variant carries Vary: Accept', async () => {
    const env = makeEnv({ cacheContent: { [CACHE_KEY_UNCURATED]: CACHED_UNCURATED_PAYLOAD } });
    const res = await handleScore(postScore('cargo binstall uncurated-tool', { accept: 'text/markdown' }), env);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/markdown');
    expect(res.headers.get('Vary')).toBe('Accept');
  });
});

describe('/api/score — suffix dispatch agrees with the shared predicate', () => {
  const markdownAccept = () => new Request('https://anc.dev/api/score', { headers: { accept: 'text/markdown' } });
  const jsonAccept = () => new Request('https://anc.dev/api/score', { headers: { accept: 'application/json' } });

  for (const path of ['/api/score', '/api/score.json', '/api/score.md']) {
    test(`${path}: Accept is honored iff the predicate leaves the path negotiable`, () => {
      const honorsAccept = preferenceFor(path, markdownAccept()) !== preferenceFor(path, jsonAccept());
      expect(honorsAccept).toBe(!isRepresentationPinned(path));
    });
  }

  test('suffix-pinned paths dispatch to the suffix format regardless of Accept', () => {
    expect(preferenceFor('/api/score.json', markdownAccept())).toBe('json');
    expect(preferenceFor('/api/score.md', jsonAccept())).toBe('markdown');
  });
});
