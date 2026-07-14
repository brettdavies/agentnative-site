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
