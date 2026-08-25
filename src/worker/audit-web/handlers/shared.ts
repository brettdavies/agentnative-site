// Shared helpers for the probe handlers (plan U4): base-relative URL
// resolution, `{mcp_endpoint}`/`{host}` substitution, and per-check
// timeout derivation (registry `with.timeout` is in seconds).

/** Join a path to the base, or pass an absolute URL through unchanged. */
export function resolveUrl(base: string, pathOrUrl: string): string {
  if (pathOrUrl.length === 0) return '';
  if (pathOrUrl.startsWith('http://') || pathOrUrl.startsWith('https://')) return pathOrUrl;
  try {
    return new URL(pathOrUrl, base).toString();
  } catch {
    return '';
  }
}

/** Replace the `{mcp_endpoint}` token; yields '' when the endpoint is unknown. */
export function substituteEndpoint(value: string, mcpEndpoint: string | null): string {
  if (!value.includes('{mcp_endpoint}')) return value;
  return value.replaceAll('{mcp_endpoint}', mcpEndpoint ?? '');
}

/** Replace the `{host}` token used by DoH record names. */
export function substituteHost(value: string, host: string): string {
  return value.replaceAll('{host}', host);
}

/** Convert a check's optional `with.timeout` (seconds) to ms, else the default. */
export function timeoutMsFor(checkTimeoutSeconds: number | undefined, defaultTimeoutMs: number): number {
  return typeof checkTimeoutSeconds === 'number' ? Math.round(checkTimeoutSeconds * 1000) : defaultTimeoutMs;
}

/** Remaining nested-fetch budget; 0 means stop and do not issue another request. */
export function remainingDeadlineMs(deadlineAtMs: number, nowMs = Date.now()): number {
  return Math.max(0, deadlineAtMs - nowMs);
}

const MARKDOWN_HREF_RE = /\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

function isRecoveryPath(pathname: string): boolean {
  return (
    pathname.endsWith('/sitemap.xml') ||
    pathname.endsWith('/llms.txt') ||
    pathname === '/docs' ||
    pathname.startsWith('/docs/')
  );
}

/**
 * True when markdown contains at least one href that resolves to a
 * same-origin sitemap.xml, llms.txt, or /docs recovery surface.
 */
export function sameOriginRecoveryLink(body: string, base: string): { ok: boolean; why: string } {
  let origin: string;
  try {
    origin = new URL(base).origin;
  } catch {
    return { ok: false, why: 'unparseable audit origin' };
  }
  for (const match of body.matchAll(MARKDOWN_HREF_RE)) {
    let url: URL;
    try {
      url = new URL(match[1], base);
    } catch {
      continue;
    }
    if (url.origin !== origin) continue;
    if (isRecoveryPath(url.pathname)) {
      return { ok: true, why: `same-origin recovery ${url.pathname}` };
    }
  }
  return { ok: false, why: 'no same-origin sitemap.xml, llms.txt, or /docs link' };
}
