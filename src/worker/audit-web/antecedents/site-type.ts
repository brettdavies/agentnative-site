// The declared-site-type gate, applied before the antecedent token. Separate
// from token resolution: it filters on a check's declared `site_types`, not
// on observed wave-1 evidence.

import type { WebCheckSiteType } from '../registry';
import type { AntecedentContext } from './context';

/** True when the declared-type filter lets the check run. */
export function siteTypeApplies(siteTypes: WebCheckSiteType[], ctx: AntecedentContext): boolean {
  if (siteTypes.includes('all')) return true;
  if (siteTypes.includes('mcp') && ctx.mcpEndpoint !== null) return true;
  if (ctx.siteType === null || ctx.siteType === undefined) return true;
  return siteTypes.includes(ctx.siteType);
}
