const STAGING_HOST = /^agentnative-site-staging\.[a-z0-9-]+\.workers\.dev$/;

/**
 * Whether a URL is the staging Worker itself. The match is exact because the
 * answer decides who receives the Access service token, and an audit requests
 * hosts a site declares or redirects to, which can be named anything.
 */
export function isStagingUrl(url: string): boolean {
  return STAGING_HOST.test(new URL(url).hostname);
}
