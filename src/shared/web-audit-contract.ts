// What the build and the Worker share about the CLI vendoring contract's
// fingerprint. The registry fingerprint prefix a scorecard records takes the same
// shape, so one definition covers both.

/** Where the build leaves the fingerprint for the Worker; the Worker 404s every /_internal/ path to the public. */
export const CONTRACT_FINGERPRINT_ASSET_PATH = '/_internal/web-audit-contract-fingerprint.txt';

export const FINGERPRINT_PREFIX_LENGTH = 12;
const FINGERPRINT_PREFIX_RE = new RegExp(`^[0-9a-f]{${FINGERPRINT_PREFIX_LENGTH}}$`);

export function isFingerprintPrefix(value: unknown): value is string {
  return typeof value === 'string' && FINGERPRINT_PREFIX_RE.test(value);
}
