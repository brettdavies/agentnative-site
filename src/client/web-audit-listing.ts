// Carries the audit form's public-listing choice to the scoring page
// through the same sessionStorage stash the Turnstile token rides. A real
// form submit always stashes an explicit true/false; a direct
// /web/scoring/<host> visit finds no stash and the POST omits the field,
// because the server treats an omitted flag as "preserve the stored
// choice" while an explicit false would erase an opt-in.

const STASH_PREFIX = 'web-audit-listing:';
// The choice rides the same submit gesture as the Turnstile token stash;
// matching that stash's lifetime keeps a stale tab from applying an old
// choice to a later, unrelated scoring-page load.
const STASH_TTL_MS = 240_000;

export interface AuditWebRequestBody {
  url: string;
  turnstile_token: string;
  public_listing?: boolean;
}

/** Stash the form's explicit listing choice for the scoring page, keyed by audited host. */
export function stashPublicListing(host: string, value: boolean): void {
  try {
    sessionStorage.setItem(STASH_PREFIX + host, JSON.stringify({ value, ts: Date.now() }));
  } catch {
    // Private-mode or disabled storage: the scoring page omits the field
    // and the server preserves the stored choice.
  }
}

/** Read and remove a stashed choice (single-use); null when absent or stale. */
export function takePublicListing(host: string): boolean | null {
  const key = STASH_PREFIX + host;
  let raw: string | null = null;
  try {
    raw = sessionStorage.getItem(key);
    sessionStorage.removeItem(key);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const { value, ts } = JSON.parse(raw) as { value?: unknown; ts?: unknown };
    if (typeof value === 'boolean' && typeof ts === 'number' && Date.now() - ts < STASH_TTL_MS) {
      return value;
    }
  } catch {
    // Corrupt entry: treat as no stash.
  }
  return null;
}

/**
 * Build the POST /api/audit-web body. An explicit choice (a real form
 * submit) sends the boolean; null (no stashed choice) omits the field
 * entirely — sending false here would erase a stored opt-in on a
 * shared-link re-audit.
 */
export function buildAuditWebBody(
  url: string,
  turnstileToken: string,
  publicListing: boolean | null,
): AuditWebRequestBody {
  const body: AuditWebRequestBody = { url, turnstile_token: turnstileToken };
  if (publicListing !== null) {
    body.public_listing = publicListing;
  }
  return body;
}
