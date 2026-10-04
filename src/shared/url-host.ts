/** The host (with any non-default port) a URL names, or null when it does not parse. */
export function hostOf(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}
