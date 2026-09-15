// The worker validator and the shared classifier must agree on the
// `owner/repo@branch` form: one fixture drives both.

import { describe, expect, test } from 'bun:test';
import { classifyTarget } from '../src/shared/audit-routes';
import { validateInput } from '../src/worker/score/validate';

const REGISTRY = { by_slug: {}, by_owner_repo: {} };

describe('owner/repo@branch', () => {
  test('validates to github-url with the branch, agreeing with the classifier', () => {
    for (const [raw, owner, repo, branch] of [
      ['owner/repo@feature/x', 'owner', 'repo', 'feature/x'],
      ['o/r@main', 'o', 'r', 'main'],
      ['o/r@release.json', 'o', 'r', 'release.json'],
    ]) {
      expect(validateInput(raw, REGISTRY)).toEqual({ kind: 'github-url', owner, repo, branch });
      expect(classifyTarget(raw)).toMatchObject({ ok: true, kind: 'cli-branch', owner, repo, branch });
    }
  });

  test('rejects what the classifier rejects', () => {
    for (const raw of ['o/r@..', 'o/r@', 'o/r@feature//x', 'o/r@.hidden', 'o/r@bad branch', 'o/r@md']) {
      expect(validateInput(raw, REGISTRY).kind).toBe('unknown');
      expect(classifyTarget(raw).ok).toBe(false);
    }
  });
});
