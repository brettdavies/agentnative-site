// The operator's switch over following the hosts a site declares. It is
// read per request, and any value but the string "true" reads as off, so a
// production secret that was never created fails closed: audits keep
// running, scored without the declared hosts.

export interface FollowSwitchEnv {
  WEB_AUDIT_FOLLOW_ENABLED?: string;
}

/** The follow state an audit runs with: the caller's choice, unless the operator has switched following off. */
export function effectiveFollow(env: FollowSwitchEnv, requested: boolean): boolean {
  return requested && env.WEB_AUDIT_FOLLOW_ENABLED === 'true';
}
