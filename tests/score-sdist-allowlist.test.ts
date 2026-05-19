// sdist-allowlist invariants (plan U7 follow-up, option C).
//
// The allowlist is a security-relevant data file: each entry loosens
// `--only-binary=:all:` for one package, letting pip fall back to sdist
// (which runs setup.py at install time). The shape + integrity checks
// here ensure entries can't quietly drift into invalid states (typo'd
// names, missing evidence, version-range gaps).

import { describe, expect, test } from 'bun:test';
import {
  SDIST_REJECTED_NOTES,
  SDIST_TRUSTED_DEPS,
  SDIST_TRUSTED_NAMES,
  type SdistTrustedEntry,
} from '../src/worker/score/sdist-allowlist';

describe('SDIST_TRUSTED_DEPS — entry shape integrity', () => {
  test('every entry has a non-empty PyPI name', () => {
    for (const e of SDIST_TRUSTED_DEPS) {
      expect(e.name.length).toBeGreaterThan(0);
      // PyPI names are lowercase letters, digits, hyphens, dots, underscores.
      expect(e.name).toMatch(/^[a-z0-9._-]+$/);
    }
  });

  test('every entry carries a non-trivial reason (>=80 chars to discourage one-liners)', () => {
    for (const e of SDIST_TRUSTED_DEPS) {
      expect({ name: e.name, reasonLen: e.reason.length }).toEqual({
        name: e.name,
        reasonLen: expect.any(Number),
      });
      expect(e.reason.length).toBeGreaterThanOrEqual(80);
    }
  });

  test('every entry carries at least one evidence URL', () => {
    for (const e of SDIST_TRUSTED_DEPS) {
      expect(e.evidence.length).toBeGreaterThanOrEqual(1);
      for (const url of e.evidence) {
        expect(url).toMatch(/^https:\/\//);
      }
    }
  });

  test('every entry carries a YYYY-MM-DD added date', () => {
    for (const e of SDIST_TRUSTED_DEPS) {
      expect(e.added).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  test('no duplicate entries', () => {
    const names = SDIST_TRUSTED_DEPS.map((e) => e.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });
});

describe('SDIST_TRUSTED_DEPS — version range fields', () => {
  // affected_min/max + safe_pin are advisory but should be internally
  // consistent: if max_affected is set, it should be lower than the
  // safe_pin (the pin is a recommendation OUT of the affected range).

  test('affected_min_version, when set, is a valid semver-ish string', () => {
    for (const e of SDIST_TRUSTED_DEPS) {
      if (e.affected_min_version !== undefined) {
        // Loose semver: digits and dots, optionally with a prerelease tag.
        expect(e.affected_min_version).toMatch(/^\d+(\.\d+)*(\.[A-Za-z0-9._-]+)?$/);
      }
    }
  });

  test('affected_max_version, when set, is a valid semver-ish string', () => {
    for (const e of SDIST_TRUSTED_DEPS) {
      if (e.affected_max_version !== undefined) {
        expect(e.affected_max_version).toMatch(/^\d+(\.\d+)*(\.[A-Za-z0-9._-]+)?$/);
      }
    }
  });

  test('safe_pin, when set, is a recognizable pip version specifier (>=, ==, ~=, etc.)', () => {
    for (const e of SDIST_TRUSTED_DEPS) {
      if (e.safe_pin !== undefined) {
        expect(e.safe_pin).toMatch(/^(>=|<=|==|~=|>|<|!=)?\d/);
      }
    }
  });
});

describe('SDIST_TRUSTED_NAMES — derived flag value', () => {
  test('SDIST_TRUSTED_NAMES is a comma-joined list of every trusted entry name', () => {
    const expected = SDIST_TRUSTED_DEPS.map((e) => e.name).join(',');
    expect(SDIST_TRUSTED_NAMES).toBe(expected);
  });

  test('SDIST_TRUSTED_NAMES contains no spaces (must be safe for --no-binary=<csv> flag)', () => {
    expect(SDIST_TRUSTED_NAMES).not.toMatch(/\s/);
  });

  test('SDIST_TRUSTED_NAMES current expected composition: pyperclip + pycparser', () => {
    // Pinning to surface any future addition/removal as a deliberate
    // PR-reviewable change. If the allowlist changes, update both the
    // file AND this expectation.
    expect(SDIST_TRUSTED_NAMES).toBe('pyperclip,pycparser');
  });
});

describe('SDIST_REJECTED_NOTES — entry shape integrity', () => {
  test('every entry has a name, reason, investigated date, and version range', () => {
    for (const e of SDIST_REJECTED_NOTES) {
      expect(e.name.length).toBeGreaterThan(0);
      expect(e.reason.length).toBeGreaterThanOrEqual(80);
      expect(e.investigated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  test('every rejected entry has an explicit affected version range', () => {
    // The whole point of rejecting an entry is documenting WHEN it
    // applies. A rejected entry without a version range is ambiguous:
    // future me reading "don't add numpy" needs to know it's about a
    // specific version range, not all numpy forever.
    for (const e of SDIST_REJECTED_NOTES) {
      expect({ name: e.name, hasMin: e.affected_min_version !== undefined }).toEqual({
        name: e.name,
        hasMin: true,
      });
      expect({ name: e.name, hasMax: e.affected_max_version !== undefined }).toEqual({
        name: e.name,
        hasMax: true,
      });
    }
  });

  test('every rejected entry suggests a safe_pin alternative', () => {
    // Rejection means "this isn't fixed by allowlisting"; downstream
    // consumers still need a path forward. safe_pin documents the right
    // recommendation (usually "pin to a newer version that ships wheels").
    for (const e of SDIST_REJECTED_NOTES) {
      expect({ name: e.name, hasPin: e.safe_pin !== undefined && e.safe_pin.length > 0 }).toEqual({
        name: e.name,
        hasPin: true,
      });
    }
  });
});

describe('SDIST_TRUSTED_DEPS vs SDIST_REJECTED_NOTES — no overlap', () => {
  test('no package appears on both lists', () => {
    const trustedNames = new Set(SDIST_TRUSTED_DEPS.map((e) => e.name));
    for (const r of SDIST_REJECTED_NOTES) {
      expect({ name: r.name, onTrustedList: trustedNames.has(r.name) }).toEqual({
        name: r.name,
        onTrustedList: false,
      });
    }
  });
});

// Type-level smoke check: ensures the exported type stays usable from
// the consumer side. If anyone tightens SdistTrustedEntry in a way that
// breaks the existing entries, this fails at type-check time.
const _typeCheck: SdistTrustedEntry = {
  name: 'example',
  reason: 'x'.repeat(80),
  added: '2026-05-19',
  evidence: ['https://example.com'],
};
void _typeCheck;
