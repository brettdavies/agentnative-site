export const STAGING_HOSTNAME = 'agentnative-site-staging.brettdavies.workers.dev';

/**
 * Whether a URL is the staging Worker itself. The whole hostname has to match,
 * because the answer decides who receives the Access service token, and an audit
 * requests hosts a site declares or redirects to. Any Cloudflare account can
 * deploy a Worker with this one's name under its own workers.dev subdomain.
 */
export function isStagingUrl(url: string): boolean {
  return new URL(url).hostname === STAGING_HOSTNAME;
}

// run.sh asks the same question before it reads the token from 1Password.
if (import.meta.main) process.exit(isStagingUrl(process.argv[2] ?? '') ? 0 : 1);
