// The audited site as a set of origins. A site is one origin, or the two
// origins of a www and bare pair that redirect to each other. Every question
// of the form "is this URL on the audited site" goes through here, so the
// answer is the same at endpoint resolution, the declared-hosts trail, the
// API anchors, the same-site links, and the egress guard's redirect hops.

/** Whether origins `a` and `b` are one origin, or both belong to the site's origin set. */
export function sameSiteOrigin(a: string, b: string, siteOrigins: readonly string[] = []): boolean {
  return a === b || (siteOrigins.includes(a) && siteOrigins.includes(b));
}

/** Whether `candidate` is on the same site as `base`; an unparseable URL is on no site. */
export function onSite(candidate: string, base: string, siteOrigins?: readonly string[]): boolean {
  try {
    return sameSiteOrigin(new URL(candidate).origin, new URL(base).origin, siteOrigins);
  } catch {
    return false;
  }
}
