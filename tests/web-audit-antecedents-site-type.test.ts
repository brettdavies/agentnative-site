import { describe, expect, test } from 'bun:test';
import { siteTypeApplies } from '../src/worker/audit-web/antecedents';
import { ctx } from './web-audit-antecedents-helpers';

describe('siteTypeApplies', () => {
  test('all applies everywhere; no declared type runs everything', () => {
    expect(siteTypeApplies(['all'], ctx({ siteType: 'content' }))).toBe(true);
    expect(siteTypeApplies(['api'], ctx({ siteType: null }))).toBe(true);
  });

  test('a declared content type gates api-only checks off', () => {
    expect(siteTypeApplies(['api'], ctx({ siteType: 'content' }))).toBe(false);
    expect(siteTypeApplies(['content'], ctx({ siteType: 'content' }))).toBe(true);
  });

  test('mcp entries auto-apply when an endpoint is discovered, regardless of declared type', () => {
    expect(siteTypeApplies(['mcp'], ctx({ siteType: 'content', mcpEndpoint: 'https://x.dev/mcp' }))).toBe(true);
    expect(siteTypeApplies(['api', 'mcp'], ctx({ siteType: 'content' }))).toBe(false);
  });
});
