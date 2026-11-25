// A retired /web-audit/skill/<id> path redirects to /fix/<id> only for an id
// the remediation catalog holds, so the catalog is read only for a path of
// that shape and every other request skips the asset fetch.

import { isRetiredFixPath, retiredFixRedirectFor } from '../shared/audit-routes';
import { loadWebRemediationCatalog, type WebRemediationCatalogEnv } from './audit-web/remediation';

export async function retiredFixRedirect(pathname: string, env: WebRemediationCatalogEnv): Promise<string | null> {
  if (!isRetiredFixPath(pathname)) return null;
  return retiredFixRedirectFor(pathname, Object.keys(await loadWebRemediationCatalog(env)));
}
